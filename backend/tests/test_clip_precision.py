"""Synthetic clip-local preparation without media decoding, ASR, or WhisperX."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app import db
from app.config import settings
from app.routers import sermons
from app.services import (alignment_runner, clip_overrides, clip_precision,
                          clip_selection, jobs, reframe, transcript_alignment, transcript_edits)
from app.services.transcribe import transcript_path_for


class ClipPrecisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for field, value in (("data_sources_dir", root / "sources"),
                             ("data_work_dir", root / "work"),
                             ("data_clips_dir", root / "exports"),
                             ("clip_preparation_padding_seconds", 8.0)):
            scoped = patch.object(settings, field, value)
            scoped.start()
            self.addCleanup(scoped.stop)
        connection = patch.object(db, "_conn", None)
        connection.start()
        self.addCleanup(connection.stop)
        db.init()
        self.addCleanup(lambda: db._conn.close())

        self.source = settings.data_sources_dir / "sample.mp4"
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b"synthetic source")
        self.path = transcript_path_for(self.source.name)
        self.path.parent.mkdir(parents=True)
        self.raw = {"source": self.source.name, "duration": 20.0, "segments": [
            {"id": 1, "start": 0.5, "end": 0.8, "text": "intro",
             "words": [{"word": "intro", "start": 0.5, "end": 0.8}]},
            {"id": 2, "start": 10.1, "end": 11.4, "text": "alpha beta",
             "words": [{"word": "alpha", "start": 10.1, "end": 10.4},
                       {"word": "beta", "start": 11.1, "end": 11.4}]},
        ]}
        self.path.write_text(json.dumps(self.raw), encoding="utf-8")
        self.raw_bytes = self.path.read_bytes()
        self.clip_id = "stable-synthetic-id"
        self.clips_path = clip_selection.clips_path_for(self.source.name)
        clip_selection.write_json_atomic(self.clips_path, {
            "source": self.source.name, "clips_version": "synthetic-version",
            "clips": [{"id": self.clip_id, "origin": "manual", "title": "Sample",
                       "start": 10.0, "end": 12.0}],
        })

    def _local_transcript(self, _audio):
        return {"source": "clip.wav", "duration": 18.0, "backend": "synthetic",
                "model": "synthetic", "segments": [
                    {"id": 0, "start": 8.1, "end": 9.4, "text": "alpha beta",
                     "words": [{"word": "alpha", "start": 8.1, "end": 8.4},
                               {"word": "beta", "start": 9.1, "end": 9.4}]},
                ]}

    def _aligned(self, _audio, windows):
        local_words = transcript_alignment.flatten(self._local_transcript(None))
        by_key = {word["key"]: word for word in local_words}
        return {"windows": [{"index": window["index"], "word_segments": [
            {"word": by_key[key]["text"],
             "start": by_key[key]["start"] + 0.2 - window["audio_start"],
             "end": by_key[key]["end"] + 0.2 - window["audio_start"],
             "score": 0.9} for key in window["keys"]]}
            for window in windows]}

    def _prepare(self):
        with patch.object(clip_precision.transcribe, "_probe_duration", return_value=20.0), \
             patch.object(clip_precision, "_extract_audio",
                          side_effect=lambda _s, _a, _b, path: path.write_bytes(b"synthetic")):
            return clip_precision.prepare(self.source.name, self.clip_id, 10.0, 12.0,
                                          transcribe_fn=self._local_transcript,
                                          align_fn=self._aligned)

    def _queued_without_execution(self):
        def queue(coroutine):
            coroutine.close()
            return None
        return patch.object(jobs.asyncio, "create_task", side_effect=queue)

    def test_padding_absolute_conversion_sidecar_and_shared_caption_reader(self):
        self.assertEqual(clip_precision.padded_range(1, 5, 20), (0, 13))
        self.assertEqual(clip_precision.padded_range(16, 19, 20), (8, 20))
        artifact = self._prepare()
        self.assertEqual((artifact["padded_start"], artifact["padded_end"]), (2, 20))
        self.assertEqual([word["start"] for word in artifact["words"]], [10.3, 11.3])
        self.assertEqual(artifact["alignment"]["aligned_words"], 2)
        self.assertEqual(artifact["clip_id"], self.clip_id)
        self.assertEqual(artifact["transcription"],
                         {"backend": "synthetic", "model": "synthetic", "quality": "clean"})
        self.assertEqual(self.path.read_bytes(), self.raw_bytes)
        self.assertTrue(clip_precision.artifact_path(self.source.name, self.clip_id).exists())
        self.assertNotEqual(clip_precision.artifact_path(self.source.name, self.clip_id),
                            clip_precision.artifact_path(self.source.name, "other-id"))
        words, provenance = clip_precision.caption_words(self.source.name, self.clip_id,
                                                          10.35, 11.2, self.path)
        self.assertEqual(provenance, "clip_precision")
        self.assertEqual([(w.text, round(w.start, 2), round(w.end, 2)) for w in words],
                         [("alpha", 0.0, 0.25)])
        response = sermons.get_transcript_words(self.source.name, 10.35, 11.2, self.clip_id)
        self.assertEqual(response["words"], [{"text": "alpha", "start": words[0].start,
                                               "end": words[0].end}])
        self.assertEqual(sermons.get_clip_preparation(self.source.name, 0, self.clip_id)
                         ["status"], "ready")
        with self.assertRaises(HTTPException) as changed:
            sermons.get_clip_preparation(self.source.name, 0, "replacement-id")
        self.assertEqual(changed.exception.status_code, 409)

    def test_legacy_alignment_and_unprepared_fallback(self):
        words, provenance = clip_precision.caption_words(self.source.name, self.clip_id,
                                                          10, 12, self.path)
        self.assertEqual(provenance, "sermon_fallback")
        self.assertAlmostEqual(words[0].start, 0.1)
        effective, _, _ = transcript_edits.load_effective_transcript(self.path)
        aligned = [{**word, "status": "aligned", "aligned_start": word["start"] + 0.4,
                    "aligned_end": word["end"] + 0.4, "score": 0.9}
                   for word in transcript_alignment.flatten(effective)]
        candidate = transcript_alignment.new_candidate(effective, model="synthetic",
            ranges=[(0, 20)], words=aligned, diagnostics=[], failed_windows=[])
        transcript_alignment.write(self.path, candidate)
        words, provenance = clip_precision.caption_words(self.source.name, self.clip_id,
                                                          10, 12, self.path)
        self.assertEqual(provenance, "sermon_fallback")
        self.assertAlmostEqual(words[0].start, 0.5)
        self._prepare()
        words, provenance = clip_precision.caption_words(self.source.name, self.clip_id,
                                                          10, 12, self.path)
        self.assertEqual(provenance, "clip_precision")
        self.assertAlmostEqual(words[0].start, 0.3)

    def test_preview_and_export_use_identical_prepared_words(self):
        self._prepare()
        response = sermons.get_transcript_words(self.source.name, 10, 12, self.clip_id)
        stream = SimpleNamespace(width=1920, height=1080, average_rate=30)
        probe = SimpleNamespace(streams=SimpleNamespace(video=[stream]), close=lambda: None)
        with patch.object(reframe, "_ffmpeg_extract"), \
             patch.object(reframe.av, "open", return_value=probe), \
             patch.object(reframe, "_encode_stage") as encode, \
             patch.object(reframe.captions, "generate_ass", return_value="synthetic ASS") as ass:
            rendered = reframe.export_clip(self.source, 10, 12, "synthetic.mp4",
                                            self.path, zoom_level="stage", clip_id=self.clip_id)
        self.assertTrue(rendered["captioned"])
        self.assertEqual(rendered["n_caption_words"], len(response["words"]))
        self.assertEqual([{"text": word.text, "start": word.start, "end": word.end}
                          for word in ass.call_args.args[0]], response["words"])
        encode.assert_called_once()

    def test_trim_reuse_outside_requeue_and_rapid_save_dedup(self):
        self._prepare()
        with self._queued_without_execution():
            self.assertIsNone(jobs.create_prepare_clip_job(self.source.name, self.clip_id))
            clip_overrides.save_override(self.source.name, 0, {"start": 10.35, "end": 11.2})
            self.assertEqual(clip_precision.assess(self.source.name, self.clip_id,
                              10.35, 11.2)["status"], "ready")
            self.assertIsNone(jobs.create_prepare_clip_job(self.source.name, self.clip_id))
            clip_overrides.save_override(self.source.name, 0, {"start": 1.0, "end": 11.2})
            self.assertEqual(clip_precision.assess(self.source.name, self.clip_id,
                              1.0, 11.2)["reason"], "outside_prepared_range")
            first = jobs.create_prepare_clip_job(self.source.name, self.clip_id)
            clip_overrides.save_override(self.source.name, 0, {"start": 0.9, "end": 11.2})
            again = jobs.create_prepare_clip_job(self.source.name, self.clip_id)
        self.assertEqual(first.id, again.id)
        self.assertEqual(first.status, "queued")
        self.assertEqual(len([job for job in jobs.list_jobs()
                              if job.kind == "prepare_clip"]), 1)

    def test_source_transcript_human_edit_and_replaced_clip_invalidation(self):
        self._prepare()
        self.source.write_bytes(b"synthetic source changed")
        self.assertEqual(clip_precision.assess(self.source.name, self.clip_id, 10, 12)["reason"],
                         "source_changed")
        self.source.write_bytes(b"synthetic source")
        # A byte-identical rewrite can still change mtime, so prepare again.
        self._prepare()
        changed = json.loads(self.path.read_text())
        changed["segments"][0]["words"][0]["word"] = "opening"
        self.path.write_text(json.dumps(changed))
        self.assertEqual(clip_precision.assess(self.source.name, self.clip_id, 10, 12)["status"],
                         "ready")
        changed["segments"][1]["words"][0]["word"] = "changed"
        self.path.write_text(json.dumps(changed))
        self.assertEqual(clip_precision.assess(self.source.name, self.clip_id, 10, 12)["reason"],
                         "transcript_changed_in_clip")
        self.path.write_bytes(self.raw_bytes)
        self._prepare()
        transcript_edits.save_edit(self.path, 2, 0, [self.raw["segments"][1]["words"][0]],
                                   "corrected")
        self.assertEqual(clip_precision.assess(self.source.name, self.clip_id, 10, 12)["reason"],
                         "human_correction_overlaps")
        data = json.loads(self.clips_path.read_text())
        data["clips"] = [{"id": "replacement-id", "title": "Other", "start": 10, "end": 12}]
        clip_selection.write_json_atomic(self.clips_path, data)
        self.assertEqual(clip_precision.assess(self.source.name, self.clip_id, 10, 12)["reason"],
                         "clip_replaced")

    def test_invalid_sidecar_never_becomes_caption_source(self):
        self._prepare()
        path = clip_precision.artifact_path(self.source.name, self.clip_id)
        artifact = json.loads(path.read_text())
        artifact["words"][0]["start"] = 999.0
        path.write_text(json.dumps(artifact))
        self.assertEqual(clip_precision.assess(self.source.name, self.clip_id, 10, 12)["reason"],
                         "invalid_artifact")
        words, provenance = clip_precision.caption_words(self.source.name, self.clip_id,
                                                          10, 12, self.path)
        self.assertEqual(provenance, "sermon_fallback")
        self.assertAlmostEqual(words[0].start, 0.1)

    def test_failed_local_transcription_quality_is_not_activated(self):
        with patch.object(clip_precision.transcript_quality, "analyze_transcript",
                          return_value={"status": "failed", "findings": []}):
            with self.assertRaisesRegex(clip_precision.PrecisionError, "quality checks"):
                self._prepare()
        self.assertFalse(clip_precision.artifact_path(self.source.name, self.clip_id).exists())

    def test_failed_preparation_preserves_clip_and_explicit_retry(self):
        with patch.object(clip_precision, "prepare", side_effect=RuntimeError("synthetic failure")):
            job = jobs._new_job(kind="prepare_clip", source=self.source.name,
                                clip_id=self.clip_id, clip_index=0, start=10, end=12)
            asyncio.run(jobs._run_prepare_clip(job))
        self.assertEqual(jobs.latest_preparation(self.source.name, self.clip_id).status, "failed")
        self.assertEqual(clip_precision.current_clip(self.source.name, self.clip_id)[1:], (10, 12))
        self.assertEqual(jobs.preparation_status(self.source.name, self.clip_id, 10, 12)["status"],
                         "failed")
        with self._queued_without_execution(), \
             patch.object(jobs.transcribe, "transcribe_file", side_effect=AssertionError), \
             patch.object(jobs.clip_selection, "select_clips", side_effect=AssertionError):
            self.assertIsNone(jobs.create_prepare_clip_job(self.source.name, self.clip_id))
            retry = jobs.create_prepare_clip_job(self.source.name, self.clip_id, force=True)
        self.assertEqual(retry.status, "queued")
        self.assertNotEqual(retry.id, job.id)

    def test_scheduling_failure_is_recorded_without_losing_clip(self):
        with patch.object(jobs, "create_prepare_clip_job", side_effect=RuntimeError("unavailable")):
            result = jobs.schedule_saved_clip(self.source.name, self.clip_id)
        self.assertEqual(result.status, "failed")
        self.assertEqual(jobs.preparation_status(self.source.name, self.clip_id, 10, 12)["status"],
                         "failed")
        self.assertEqual(clip_precision.current_clip(self.source.name, self.clip_id)[0], 0)

    def test_ai_batch_schedules_after_persistence_without_inline_inference(self):
        result = {"source": self.source.name, "clips_version": "next-batch", "clips": [
            {"title": "AI sample", "start": 12, "end": 15}]}
        scheduled = []

        def schedule(source, clip_id, **_kwargs):
            stored = json.loads(self.clips_path.read_text())["clips"]
            self.assertIn(clip_id, [clip["id"] for clip in stored])
            scheduled.append((source, clip_id))

        job = jobs.Job(id="synthetic-selection", kind="select_clips", source=self.source.name)
        with patch.object(jobs, "_ensure_transcript_selectable"), \
             patch.object(clip_selection, "select_clips", return_value=result), \
             patch.object(jobs, "schedule_saved_clip", side_effect=schedule), \
             patch.object(clip_precision, "prepare", side_effect=AssertionError):
            asyncio.run(jobs._run_select_clips(job, self.path, 1, 1))
        stored = json.loads(self.clips_path.read_text())["clips"]
        self.assertEqual(job.status, "done")
        self.assertEqual(len(stored), 2)
        self.assertEqual({clip_id for _, clip_id in scheduled},
                         {clip["id"] for clip in stored})
        self.assertEqual(stored[1]["id"], self.clip_id)

    def test_bounded_synthetic_job_lifecycle(self):
        with self._queued_without_execution():
            job = jobs.create_prepare_clip_job(self.source.name, self.clip_id)
        self.assertEqual(job.status, "queued")
        with patch.object(clip_precision.transcribe, "_probe_duration", return_value=20.0), \
             patch.object(clip_precision, "_extract_audio",
                          side_effect=lambda _s, _a, _b, path: path.write_bytes(b"synthetic")), \
             patch.object(clip_precision.transcribe, "transcribe_file",
                          side_effect=self._local_transcript), \
             patch.object(alignment_runner, "_run_worker", side_effect=self._aligned):
            asyncio.run(jobs._run_prepare_clip(job))
        self.assertEqual(job.status, "done")
        self.assertEqual(clip_precision.read_artifact(self.source.name, self.clip_id)
                         ["words"][0]["start"], 10.3)
        self.assertEqual(jobs.preparation_status(self.source.name, self.clip_id, 10, 12)["status"],
                         "ready")
        clip_overrides.save_override(self.source.name, 0, {"start": 10.3, "end": 11.3})
        with self._queued_without_execution():
            self.assertIsNone(jobs.create_prepare_clip_job(self.source.name, self.clip_id))
            clip_overrides.save_override(self.source.name, 0, {"start": 1, "end": 11.3})
            queued = jobs.create_prepare_clip_job(self.source.name, self.clip_id)
        self.assertEqual(queued.status, "queued")
        self.assertNotEqual(queued.id, job.id)
        with patch.object(clip_precision, "prepare", side_effect=RuntimeError("synthetic failure")):
            asyncio.run(jobs._run_prepare_clip(queued))
        self.assertEqual(queued.status, "failed")
        self.assertEqual(clip_precision.current_clip(self.source.name, self.clip_id)[1:],
                         (1, 11.3))
        with self._queued_without_execution():
            retry = jobs.create_prepare_clip_job(self.source.name, self.clip_id, force=True)
        self.assertEqual(retry.status, "queued")


if __name__ == "__main__":
    unittest.main()
