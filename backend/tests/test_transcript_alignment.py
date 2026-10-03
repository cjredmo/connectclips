"""Forced-alignment layering with synthetic text and mocked worker output."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import alignment_runner, transcript_alignment, transcript_edits


def sample():
    words = [
        {"word": text, "start": float(i), "end": i + 0.4}
        for i, text in enumerate(("alpha", "beta", "gamma", "delta", "epsilon", "zeta"))
    ]
    return {"source": "sample.mp4", "duration": 8.0,
            "segments": [{"id": 1, "start": 0.0, "end": 5.4,
                          "text": " ".join(w["word"] for w in words), "words": words}]}


class AlignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "transcript.json"
        self.source = Path(self.temp.name) / "sample.mp4"
        self.source.touch()
        self.path.write_text(json.dumps(sample()), encoding="utf-8")
        self.raw_bytes = self.path.read_bytes()

    def tearDown(self):
        self.temp.cleanup()

    def candidate(self, shift=0.2):
        effective, _, _ = transcript_edits.load_effective_transcript(self.path)
        words = [{**word, "status": "aligned", "aligned_start": word["start"] + shift,
                  "aligned_end": word["end"] + shift, "score": 0.9}
                 for word in transcript_alignment.flatten(effective)]
        return transcript_alignment.new_candidate(effective, model="synthetic",
                                                  ranges=[(0, 8)], words=words,
                                                  diagnostics=[], failed_windows=[])

    def test_sidecar_version_fingerprint_and_text_preservation(self):
        self.assertIsNone(transcript_alignment.read(self.path))
        candidate = self.candidate()
        transcript_alignment.write(self.path, candidate)
        self.assertEqual(transcript_alignment.read(self.path)["version"], 1)
        display = transcript_alignment.load_display_transcript(self.path)
        self.assertEqual([w["word"] for w in display["segments"][0]["words"]],
                         [w["word"] for w in sample()["segments"][0]["words"]])
        self.assertEqual(display["segments"][0]["words"][0]["start"], 0.2)
        self.assertEqual(self.path.read_bytes(), self.raw_bytes)
        self.assertTrue(transcript_alignment.status(self.path)["acceptable"])
        candidate["version"] = 99
        with self.assertRaises(transcript_alignment.AlignmentError):
            transcript_alignment.write(self.path, candidate)

    def test_human_edit_stales_local_context_but_retains_safe_later_alignment(self):
        transcript_alignment.write(self.path, self.candidate())
        original = [sample()["segments"][0]["words"][0]]
        transcript_edits.save_edit(self.path, 1, 0, original, "changed")
        status = transcript_alignment.status(self.path)
        self.assertEqual(status["status"], "stale")
        self.assertFalse(status["acceptable"])
        self.assertTrue(status["stale_ranges"])
        # All words in this tiny sample are inside the changed word's context.
        display = transcript_alignment.load_display_transcript(self.path)
        self.assertEqual(display["segments"][0]["words"][0]["word"], "changed")
        self.assertEqual(display["segments"][0]["words"][0]["start"], 0.0)
        self.assertEqual(self.path.read_bytes(), self.raw_bytes)

    def test_human_edit_preserves_alignment_outside_context(self):
        words = [{"word": f"word{i}", "start": float(i), "end": i + 0.4}
                 for i in range(20)]
        transcript = {"source": "sample.mp4", "duration": 21,
                      "segments": [{"id": 1, "start": 0, "end": 19.4,
                                    "text": " ".join(w["word"] for w in words),
                                    "words": words}]}
        self.path.write_text(json.dumps(transcript))
        effective, _, _ = transcript_edits.load_effective_transcript(self.path)
        entries = [{**word, "status": "aligned", "aligned_start": word["start"] + 0.2,
                    "aligned_end": word["end"] + 0.2}
                   for word in transcript_alignment.flatten(effective)]
        transcript_alignment.write(self.path, transcript_alignment.new_candidate(
            effective, model="synthetic", ranges=[(0, 21)], words=entries,
            diagnostics=[], failed_windows=[]))
        transcript_edits.save_edit(self.path, 1, 0, [words[0]], "corrected")
        display = transcript_alignment.load_display_transcript(self.path)
        self.assertEqual(display["segments"][0]["words"][0]["start"], 0.0)
        self.assertEqual(display["segments"][0]["words"][15]["start"], 15.2)
        self.assertEqual(transcript_alignment.status(self.path)["status"], "stale")

    def test_shared_preview_and_export_timing_reader(self):
        from app.routers import sermons
        from app.services import reframe
        self.assertIs(reframe.clip_precision.caption_words,
                      sermons.clip_precision.caption_words)
        transcript_alignment.write(self.path, self.candidate())
        with patch.object(sermons.settings, "data_sources_dir", Path(self.temp.name)), \
             patch.object(sermons, "transcript_path_for", return_value=self.path):
            response = sermons.get_transcript_words("sample.mp4", 0, 8)
        self.assertAlmostEqual(response["words"][0]["start"], 0.2)
        self.assertEqual(len(response["words"]), 6)

    def test_overlap_merge_and_disagreement_fallback(self):
        effective = sample()
        words = transcript_alignment.flatten(effective)
        windows = alignment_runner.make_windows(words, [(0, 3), (3, 8)], 8)
        results = []
        for window in windows:
            parts = []
            for key in window["keys"]:
                word = next(w for w in words if w["key"] == key)
                shift = 0.2
                if window["index"] == 1 and word["text"] == "beta":
                    shift = 0.9
                parts.append({"word": word["text"],
                              "start": word["start"] + shift - window["audio_start"],
                              "end": word["end"] + shift - window["audio_start"],
                              "score": 0.9})
            results.append({"index": window["index"], "word_segments": parts})
        result = alignment_runner.merge(effective, [(0, 3), (3, 8)], windows,
                                        {"windows": results})
        self.assertEqual(len(result["words"]), len(words))
        self.assertEqual(result["words"][1]["status"], "fallback")
        self.assertEqual(result["words"][1]["reason"], "overlap_disagreement")
        self.assertEqual(result["words"][2]["status"], "aligned")

    def test_missing_words_and_invalid_duration_fall_back(self):
        effective = sample()
        words = transcript_alignment.flatten(effective)
        windows = alignment_runner.make_windows(words, [(0, 8)], 8)
        output = [{"word": w["text"], "start": w["start"] + 0.2,
                   "end": w["end"] + 0.2, "score": 0.9} for w in words]
        output[2]["end"] = output[2]["start"]
        output.pop(4)
        result = alignment_runner.merge(effective, [(0, 8)], windows,
                                        {"windows": [{"index": 0, "word_segments": output}]})
        self.assertEqual(len(result["words"]), 6)
        self.assertEqual([w["text"] for w in result["words"]], [w["text"] for w in words])
        self.assertEqual(result["words"][2]["reason"], "invalid_duration_or_bounds")
        self.assertEqual(result["words"][4]["reason"], "unresolved")

    def test_millisecond_duration_boundary_survives_validation(self):
        candidate = self.candidate()
        candidate["words"][0]["aligned_start"] = 0.002
        candidate["words"][0]["aligned_end"] = 0.022
        self.assertEqual(transcript_alignment.validation_errors(sample(), candidate), [])
        transcript_alignment.write(self.path, candidate)
        self.assertEqual(transcript_alignment.read(self.path)["words"][0]["status"], "aligned")

    def test_merge_rejects_duration_outside_limit_after_rounding(self):
        effective = {"source": "sample.mp4", "duration": 3.0,
                     "segments": [{"id": 1, "start": 0.0, "end": 0.4,
                                   "text": "alpha", "words": [
                                       {"word": "alpha", "start": 0.0, "end": 0.4}]}]}
        words = transcript_alignment.flatten(effective)
        windows = alignment_runner.make_windows(words, [(0, 3)], 3)
        output = [{"word": "alpha", "start": 0.0045, "end": 2.0045, "score": 0.9}]
        result = alignment_runner.merge(effective, [(0, 3)], windows,
                                        {"windows": [{"index": 0, "word_segments": output}]})
        self.assertEqual(result["words"][-1]["status"], "fallback")
        self.assertEqual(result["words"][-1]["reason"], "invalid_duration_or_bounds")

    def test_overlap_in_candidate_reverts_lower_confidence_word(self):
        effective = sample()
        words = transcript_alignment.flatten(effective)
        windows = alignment_runner.make_windows(words, [(0, 8)], 8)
        output = [{"word": w["text"], "start": w["start"] + 0.2,
                   "end": w["end"] + 0.2, "score": 0.9} for w in words]
        output[0]["end"] = 2.0
        output[0]["score"] = 0.3
        result = alignment_runner.merge(effective, [(0, 8)], windows,
                                        {"windows": [{"index": 0, "word_segments": output}]})
        self.assertEqual(result["words"][0]["reason"], "chronology_conflict")
        self.assertEqual(result["words"][1]["status"], "aligned")
        self.assertEqual(result["chronology_errors"], [])

    def test_failed_worker_does_not_activate_alignment(self):
        with patch.object(alignment_runner, "_run_worker", return_value={"windows": []}):
            with self.assertRaises(transcript_alignment.AlignmentError):
                alignment_runner.align_transcript(self.source, self.path)
        self.assertFalse(transcript_alignment.path_for(self.path).exists())

    def test_valid_partial_alignment_below_old_coverage_gate_activates(self):
        words = [{"word": f"term{i}", "start": float(i), "end": i + 0.4}
                 for i in range(12)]
        transcript = {"source": "sample.mp4", "duration": 13.0,
                      "segments": [{"id": 1, "start": 0, "end": 11.4,
                                    "text": " ".join(w["word"] for w in words),
                                    "words": words}]}
        self.path.write_text(json.dumps(transcript), encoding="utf-8")
        raw_bytes = self.path.read_bytes()
        def worker(_source, _windows, _progress):
            return {"windows": [{"index": 0, "word_segments": [
                {"word": w["word"], "start": w["start"] + 0.1,
                 "end": w["end"] + 0.1, "score": 0.9}
                for i, w in enumerate(words) if i != 5]}]}
        candidate, _ = alignment_runner.align_transcript(
            self.source, self.path, worker_fn=worker)
        self.assertEqual(candidate["validation"]["aligned_words"], 11)
        self.assertEqual(candidate["validation"]["fallback_words"], 1)
        self.assertLess(candidate["validation"]["coverage_percent"], 95)
        self.assertEqual(candidate["validation"]["fallback_reasons"], {"unresolved": 1})
        status = transcript_alignment.status(self.path)
        self.assertEqual(status["status"], "partially_aligned")
        self.assertTrue(status["acceptable"])
        display = transcript_alignment.load_display_transcript(self.path)
        self.assertEqual(display["segments"][0]["words"][5], words[5])
        self.assertEqual([w["word"] for w in display["segments"][0]["words"]],
                         [w["word"] for w in words])
        self.assertEqual(self.path.read_bytes(), raw_bytes)

    def test_invalid_candidates_cannot_activate_or_change_display(self):
        good = self.candidate()
        corruptions = []
        missing = json.loads(json.dumps(good))
        missing["words"].pop()
        corruptions.append(missing)
        invented = json.loads(json.dumps(good))
        invented["words"][0]["text"] = "invented"
        corruptions.append(invented)
        reordered = json.loads(json.dumps(good))
        reordered["words"][0], reordered["words"][1] = reordered["words"][1], reordered["words"][0]
        corruptions.append(reordered)
        invalid_time = json.loads(json.dumps(good))
        invalid_time["words"][1]["aligned_start"] = float("nan")
        corruptions.append(invalid_time)
        chronology = json.loads(json.dumps(good))
        chronology["words"][1]["aligned_start"] = 0.3
        corruptions.append(chronology)
        failed_window = json.loads(json.dumps(good))
        failed_window["failed_windows"] = [0]
        corruptions.append(failed_window)
        for candidate in corruptions:
            with self.subTest(candidate=candidate["words"][0].get("text"),
                              count=len(candidate["words"])):
                with self.assertRaises(transcript_alignment.AlignmentError):
                    transcript_alignment.write(self.path, candidate)
                self.assertFalse(transcript_alignment.path_for(self.path).exists())
        # A sidecar changed after activation is also rejected by readers.
        corrupt = json.loads(json.dumps(good))
        corrupt["words"].pop()
        transcript_alignment.path_for(self.path).write_text(json.dumps(corrupt))
        self.assertEqual(transcript_alignment.status(self.path)["status"], "failed")
        self.assertEqual(transcript_alignment.load_display_transcript(self.path), sample())


if __name__ == "__main__":
    unittest.main()
