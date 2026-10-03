"""Synthetic YouTube caption fast-path tests; no network or inference."""

import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from app.services import clip_selection, jobs, transcribe, transcript_alignment, transcript_repairs, youtube_captions


URL = "https://example.invalid/native.vtt"


def track(language="en", *, translated=False):
    url = URL + ("?tlang=en" if translated else "")
    return {language: [{"ext": "vtt", "url": url}]}


def vtt(*texts):
    lines = ["WEBVTT", ""]
    for i, text in enumerate(texts):
        lines.extend([f"00:00:{i * 10:02d}.000 --> 00:00:{i * 10 + 10:02d}.000", text, ""])
    return "\n".join(lines)


class FakeYoutubeDL:
    def __init__(self, info, caption):
        self.info = info
        self.caption = caption
        self.download_flags = []

    def __call__(self, options):
        self.download_flags.append(options)
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def extract_info(self, _url, download):
        if download:
            raise AssertionError("caption retrieval must not download video")
        return self.info

    def urlopen(self, request):
        if request.url != URL:
            raise OSError("subtitle unavailable")
        return io.BytesIO(self.caption.encode())


class CaptionSelectionTests(unittest.TestCase):
    def test_manual_precedes_auto_and_translated(self):
        info = {"language": "en", "duration": 20, "subtitles": track(),
                "automatic_captions": track()}
        self.assertEqual(youtube_captions.select_track(info)[:2], ("youtube_manual", "en"))
        info["subtitles"] = track(translated=True)
        self.assertEqual(youtube_captions.select_track(info)[:2], ("youtube_auto", "en"))

    def test_auto_and_non_english_native(self):
        info = {"language": "en", "automatic_captions": track()}
        self.assertEqual(youtube_captions.select_track(info)[0], "youtube_auto")
        info = {"language": "es", "subtitles": track("es")}
        self.assertEqual(youtube_captions.select_track(info)[:2], ("youtube_manual", "es"))
        regional = {"language": "en-US", "subtitles": track("en-US")}
        self.assertEqual(youtube_captions.select_track(regional)[:2],
                         ("youtube_manual", "en-US"))

    def test_unusable_manual_can_try_native_auto(self):
        info = {"language": "en", "duration": 20,
                "subtitles": {"en": [{"ext": "vtt", "url": "https://example.invalid/manual.vtt"}]},
                "automatic_captions": track()}
        fake = FakeYoutubeDL(info, vtt("A clear opening starts here with words.",
                                       "The next phrase continues the synthetic lesson."))
        with patch.object(youtube_captions.yt_dlp, "YoutubeDL", fake):
            result = youtube_captions.acquire(URL, Path("sample.mp4"))
        self.assertEqual(result["provenance"]["source"], "youtube_auto")

    def test_translated_or_unknown_language_is_not_native(self):
        self.assertIsNone(youtube_captions.select_track({
            "language": "en", "subtitles": track(translated=True)}))
        self.assertIsNone(youtube_captions.select_track({"automatic_captions": track()}))
        native = {"automatic_captions": track("en-orig")}
        self.assertEqual(youtube_captions.select_track(native)[:2],
                         ("youtube_auto", "en-orig"))

    def test_rolling_overlap_removes_repeated_prefix_and_suffix(self):
        cues = [(0, 2, "the Lord is"), (1, 3, "the Lord is good"),
                (2.5, 4, "is good and"), (3.8, 5, "good and faithful")]
        normalized = youtube_captions.normalize_cues(cues)
        self.assertEqual(" ".join(s["text"] for s in normalized),
                         "the Lord is good and faithful")
        self.assertEqual(len([w for s in normalized for w in s["words"]]), 6)

    def test_real_repetition_and_punctuation_survive(self):
        cues = [(0, 1, "Go, go."), (2, 3, "Go again."), (3.2, 4.2, "Go again.")]
        normalized = youtube_captions.normalize_cues(cues)
        self.assertEqual(" ".join(s["text"] for s in normalized),
                         "Go, go. Go again. Go again.")
        separate = youtube_captions.normalize_cues(
            [(0, 1, "I know"), (1.2, 2.2, "I know I know")])
        self.assertEqual(" ".join(s["text"] for s in separate),
                         "I know I know I know")

    def test_markup_empty_and_malformed_timing(self):
        cues = youtube_captions.parse_vtt(
            "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c>Hello</c>  &amp;  welcome\n\n"
            "00:00:01.000 --> 00:00:02.000\n[Music]\n\n"
            "00:00:02.000 --> 00:00:03.000\n  \n")
        self.assertEqual(cues, [(0, 1, "Hello & welcome")])
        with self.assertRaises(youtube_captions.CaptionUnavailable):
            youtube_captions.parse_vtt("WEBVTT\n\nwrong --> 00:00:03.000\nWords\n")

    def test_coverage_and_loop_quality_reject(self):
        segments = youtube_captions.normalize_cues(
            [(i * 2, i * 2 + 2, f"Distinct phrase {i} with enough words") for i in range(12)])
        transcript = {"duration": 250, "segments": segments}
        with self.assertRaisesRegex(youtube_captions.CaptionUnavailable, "tail"):
            youtube_captions.validate_caption_transcript(transcript)
        short_excerpt = youtube_captions.normalize_cues(youtube_captions.parse_vtt(
            "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n"
            "A brief caption excerpt with several spoken words here.\n"))
        with self.assertRaisesRegex(youtube_captions.CaptionUnavailable, "tail"):
            youtube_captions.validate_caption_transcript(
                {"duration": 20, "segments": short_excerpt})
        repeated = youtube_captions.normalize_cues(
            [(i * 3, i * 3 + 1.5, "Synthetic phrase loops again") for i in range(18)])
        with self.assertRaisesRegex(youtube_captions.CaptionUnavailable, "quality"):
            youtube_captions.validate_caption_transcript({"duration": 54, "segments": repeated})


class CaptionJobTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name) / "sample.mp4"
        self.source.touch()
        self.path = Path(self.temp.name) / "transcript.json"
        self.caption = vtt("A clear opening starts here with words.",
                           "The next phrase continues the synthetic lesson.")
        self.local = {"source": self.source.name, "duration": 20, "language": "en",
                      "backend": "ctranslate2", "model": "synthetic-model",
                      "created_at": "2020-01-01T00:00:00Z",
                      "segments": youtube_captions.normalize_cues(youtube_captions.parse_vtt(self.caption))}

    def tearDown(self):
        self.temp.cleanup()

    async def _run(self, info, *, caption=None, fetch_error=False):
        fake = FakeYoutubeDL(info, caption if caption is not None else self.caption)
        job = jobs.Job(id="synthetic", kind="transcribe", source=self.source.name, url=URL)
        with patch.object(youtube_captions.yt_dlp, "YoutubeDL", fake), \
             patch.object(transcribe, "transcript_path_for", return_value=self.path), \
             patch.object(jobs, "_start", new_callable=AsyncMock), \
             patch.object(jobs, "_save"), patch.object(jobs, "_finish") as finish, \
             patch.object(jobs, "_maybe_chain_prescan"), \
             patch.object(jobs, "create_repair_job") as repair, \
             patch.object(transcribe, "transcribe_file", return_value=self.local) as local:
            if fetch_error:
                with patch.object(fake, "urlopen", side_effect=OSError("unavailable")):
                    await jobs._run_transcribe(job, self.source)
            else:
                await jobs._run_transcribe(job, self.source)
        self.assertTrue(self.path.exists())
        self.assertEqual(finish.call_args.args, (job,))
        repair.assert_not_called()
        return json.loads(self.path.read_text()), local, fake

    async def test_manual_fast_path_ready_and_effective_selection_input(self):
        info = {"language": "en", "duration": 20, "subtitles": track(),
                "automatic_captions": track()}
        raw, local, fake = await self._run(info)
        local.assert_not_called()
        self.assertEqual(raw["provenance"]["source"], "youtube_manual")
        self.assertTrue(fake.download_flags[0]["skip_download"])
        self.assertEqual(transcript_repairs.transcript_status(self.path)["effective_quality"]["status"], "clean")
        self.assertEqual(transcript_alignment.status(self.path)["status"], "not_aligned")
        jobs._ensure_transcript_selectable(self.path)
        client = MagicMock()
        client.messages.parse.return_value = SimpleNamespace(
            parsed_output=clip_selection.ClipSelection(clips=[]), model="synthetic",
            usage=SimpleNamespace(input_tokens=0, output_tokens=0,
                                  cache_creation_input_tokens=0, cache_read_input_tokens=0))
        with patch.object(clip_selection, "_get_client", return_value=client):
            clip_selection.select_clips(self.path)
        prompt = client.messages.parse.call_args.kwargs["messages"][0]["content"][0]["text"]
        self.assertIn("A clear opening", prompt)
        self.assertNotIn("provenance", prompt)

    async def test_auto_fast_path(self):
        raw, local, _ = await self._run({"language": "en", "duration": 20,
                                         "automatic_captions": track()})
        local.assert_not_called()
        self.assertEqual(raw["provenance"]["source"], "youtube_auto")

    async def test_fallback_variants(self):
        cases = [
            ({"language": "en", "duration": 20}, None, False),
            ({"language": "en", "duration": 20, "subtitles": track(translated=True)}, None, False),
            ({"language": "en", "duration": 20, "subtitles": track()}, None, True),
            ({"language": "en", "duration": 20, "subtitles": track()}, "WEBVTT\n", False),
            ({"language": "en", "duration": 20, "subtitles": track()},
             "WEBVTT\n\nwrong --> 00:00:02.000\nText\n", False),
            ({"language": "en", "duration": 250, "subtitles": track()}, None, False),
            ({"language": "en", "duration": 54, "subtitles": track()},
             "WEBVTT\n\n" + "\n\n".join(
                 f"00:00:{i * 3:02d}.000 --> 00:00:{i * 3 + 1:02d}.500\nSynthetic phrase loops again"
                 for i in range(18)), False),
        ]
        for info, caption, fetch_error in cases:
            with self.subTest(info=info, caption=caption, fetch_error=fetch_error):
                self.path.unlink(missing_ok=True)
                raw, local, _ = await self._run(info, caption=caption, fetch_error=fetch_error)
                local.assert_called_once()
                self.assertEqual(raw["provenance"]["source"], "local_asr")
                self.assertEqual(raw["provenance"]["backend"], "ctranslate2")

    async def test_existing_immutable_raw_is_not_overwritten(self):
        self.path.write_text('{"source":"sample.mp4","segments":[]}', encoding="utf-8")
        before = self.path.read_bytes()
        job = jobs.Job(id="synthetic", kind="transcribe", source=self.source.name, url=URL)
        fake = FakeYoutubeDL({"language": "en", "duration": 20, "subtitles": track()}, self.caption)
        with patch.object(youtube_captions.yt_dlp, "YoutubeDL", fake), \
             patch.object(transcribe, "transcript_path_for", return_value=self.path), \
             patch.object(jobs, "_start", new_callable=AsyncMock), \
             patch.object(jobs, "_save"), patch.object(jobs, "_finish") as finish:
            await jobs._run_transcribe(job, self.source)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertIn("FileExistsError", finish.call_args.args[1])

    def test_legacy_raw_without_provenance_remains_readable(self):
        self.path.write_text(json.dumps(self.local), encoding="utf-8")
        self.assertIn(transcript_repairs.transcript_status(self.path)["effective_quality"]["status"],
                      {"clean", "warning"})
