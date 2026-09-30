"""Repair-layer tests with synthetic text and mocked inference."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.services import transcript_edits, transcript_repairs, transcript_repair_runner
from app.services.transcript_quality import analyze_transcript


def segment(seg_id, start, end, text):
    tokens = text.split()
    width = (end - start) / len(tokens)
    words = [{"word": token, "start": round(start + i * width, 3),
              "end": round(start + (i + 1) * width, 3)}
             for i, token in enumerate(tokens)]
    return {"id": seg_id, "start": start, "end": end, "text": text, "words": words}


def corrupted_transcript():
    segments = [segment(0, 0, 3, "A calm beginning.")]
    segments += [segment(i + 1, 3 + 2 * i, 5 + 2 * i, "Synthetic echo repeats.")
                 for i in range(12)]
    segments.append(segment(13, 27, 30, "A different ending."))
    return {"source": "sample.mp4", "duration": 30, "segments": segments}


def candidate(raw, repair_id="sample", start=3, end=27):
    words = [{"word": f"unique{i}", "start": float(i), "end": i + 0.8}
             for i in range(start, end)]
    return {
        "id": repair_id, "status": "accepted", "finding": analyze_transcript(raw)["findings"][0],
        "replace_start": start, "replace_end": end, "backend": "whispercpp", "model": "sample-model",
        "strategy": {"owned_seconds": 50, "context_seconds": 5,
                     "window_word_counts": [len(words)], "boundary_duplicates_removed": 0},
        "generated_at": "2020-01-01T00:00:00Z", "validation": {"accepted": True},
        "replacement_segments": transcript_repair_runner._segments_from_words(words, repair_id),
    }


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "transcript.json"
        self.source = Path(self.temp.name) / "sample.mp4"
        self.source.touch()
        self.raw = corrupted_transcript()
        self.path.write_text(json.dumps(self.raw), encoding="utf-8")
        self.original_bytes = self.path.read_bytes()
        self.finding = analyze_transcript(self.raw)["findings"][0]

    def tearDown(self):
        self.temp.cleanup()

    def activate(self, repair=None):
        repair = repair or candidate(self.raw)
        transcript_repairs.record_attempt(self.path, {"id": repair["id"], "status": "accepted"},
                                          accepted=repair)
        return repair

    def test_accepted_repair_preserves_raw_and_unaffected_text(self):
        repair = self.activate()
        effective, _, warnings = transcript_edits.load_effective_transcript(self.path)
        self.assertEqual(self.path.read_bytes(), self.original_bytes)
        self.assertEqual(effective["segments"][0], self.raw["segments"][0])
        self.assertEqual(effective["segments"][-1], self.raw["segments"][-1])
        self.assertFalse(any(s["text"] == "Synthetic echo repeats." for s in effective["segments"]))
        self.assertEqual(warnings, [])
        self.assertEqual(repair["replace_start"], 3)
        self.assertEqual(repair["replace_end"], 27)
        self.assertEqual([(s["start"], s["end"]) for s in effective["segments"]],
                         sorted((s["start"], s["end"]) for s in effective["segments"]))
        status = transcript_repairs.transcript_status(self.path)
        self.assertEqual(status["raw_quality"]["status"], "failed")
        self.assertEqual(status["effective_quality"]["status"], "clean")
        self.assertFalse(status["human_review_required"])
        from app.services.clip_selection import _segment_view
        self.assertIn("unique3", _segment_view(effective))
        self.assertNotIn("Synthetic echo repeats.", _segment_view(effective))

    def test_transcript_and_caption_apis_read_repaired_text(self):
        from app.routers import sermons
        self.activate()
        with patch.object(sermons.settings, "data_sources_dir", Path(self.temp.name)), \
             patch.object(sermons, "transcript_path_for", return_value=self.path):
            words = sermons.get_transcript_words("sample.mp4", 3, 27)
            display = sermons.get_transcript("sample.mp4", 3, 27)
        self.assertEqual(words["words"][0]["text"], "unique3")
        self.assertEqual(display["segments"][0]["words"][0]["word"], "unique3")
        self.assertEqual(display["segments"][0]["reference_words"][0]["word"], "unique3")
        self.assertEqual(display["raw_quality"]["status"], "failed")
        self.assertEqual(display["effective_quality"]["status"], "clean")

    def test_candidate_validation_rejects_unhealthy_result(self):
        bad = candidate(self.raw)
        bad["replacement_segments"] = [
            segment(f"repair:bad:{i}", 3 + 2 * i, 5 + 2 * i,
                    "Synthetic echo repeats.") for i in range(12)
        ]
        verdict = transcript_repair_runner.validate_candidate(
            self.raw, [], bad, self.finding, [])
        self.assertFalse(verdict["accepted"])
        transcript_repairs.record_attempt(self.path, {"id": "bad", "status": "failed",
                                                      "validation": verdict})
        effective, _, _ = transcript_edits.load_effective_transcript(self.path)
        self.assertEqual(effective, self.raw)
        self.assertEqual(self.path.read_bytes(), self.original_bytes)

    def test_token_loop_detected_even_without_repeated_segments(self):
        words = [{"word": ("alpha" if i % 2 == 0 else "beta"),
                  "start": i * 0.5, "end": i * 0.5 + 0.4} for i in range(60)]
        self.assertTrue(transcript_repair_runner._has_word_loop(words))
        for index in range(10, 60, 10):
            words[index]["word"] = f"different{index}"
        self.assertFalse(transcript_repair_runner._has_word_loop(words))

    def test_failed_retry_preserves_previously_accepted_repair(self):
        self.activate()
        before = transcript_edits.load_effective_transcript(self.path)[0]
        transcript_repairs.record_attempt(self.path, {"id": "retry", "status": "failed"})
        after = transcript_edits.load_effective_transcript(self.path)[0]
        self.assertEqual(before, after)
        self.assertEqual(transcript_repairs.transcript_status(self.path)["effective_quality"]["status"],
                         "clean")

    def test_failed_validation_cannot_activate_or_replace_repair(self):
        self.activate()
        before = transcript_repairs.read_sidecar(self.path)
        rejected = candidate(self.raw, "rejected")
        rejected["validation"] = {"accepted": False, "errors": ["synthetic failure"]}
        with self.assertRaises(transcript_repairs.RepairError):
            transcript_repairs.record_attempt(
                self.path, {"id": "rejected", "status": "accepted"}, accepted=rejected)
        self.assertEqual(transcript_repairs.read_sidecar(self.path), before)
        self.assertEqual(self.path.read_bytes(), self.original_bytes)

    def test_multiple_nonoverlapping_repairs_merge_in_time_order(self):
        first = candidate(self.raw, "first", 3, 11)
        second = candidate(self.raw, "second", 19, 27)
        merged = transcript_repairs.apply_records(self.raw, [second, first])
        ids = [s["id"] for s in merged["segments"]]
        self.assertIn("repair:first:0", ids)
        self.assertIn("repair:second:0", ids)
        self.assertEqual(merged["segments"][0], self.raw["segments"][0])
        self.assertEqual(merged["segments"][-1], self.raw["segments"][-1])
        self.assertLess(ids.index("repair:first:0"), ids.index("repair:second:0"))

    def test_human_edits_outside_repair_survive_and_future_edits_target_repaired_base(self):
        before_word = self.raw["segments"][0]["words"][1]
        transcript_edits.save_edit(self.path, 0, 1, [before_word], "quiet")
        self.activate()
        effective, edits, warnings = transcript_edits.load_effective_transcript(self.path)
        self.assertEqual(effective["segments"][0]["words"][1]["word"], "quiet")
        self.assertEqual(len(edits), 1)
        self.assertEqual(warnings, [])
        repaired_seg = effective["segments"][1]
        transcript_edits.save_edit(self.path, repaired_seg["id"], 0,
                                   [repaired_seg["words"][0]], "corrected")
        effective, edits, warnings = transcript_edits.load_effective_transcript(self.path)
        self.assertEqual(effective["segments"][1]["words"][0]["word"], "corrected")
        self.assertEqual(len(edits), 2)
        self.assertEqual(warnings, [])

    def test_human_edit_overlap_blocks_activation_and_is_retained(self):
        word = self.raw["segments"][1]["words"][0]
        edit = transcript_edits.save_edit(self.path, 1, 0, [word], "corrected")
        with self.assertRaises(transcript_repairs.RepairError):
            self.activate()
        effective, valid, _ = transcript_edits.load_effective_transcript(self.path)
        self.assertEqual(effective["segments"][1]["words"][0]["word"], "corrected")
        self.assertEqual(valid[0]["id"], edit["id"])
        self.assertFalse(transcript_repairs.repairs_path_for(self.path).exists())

    def test_runner_flags_overlapping_human_edit_without_inference(self):
        word = self.raw["segments"][1]["words"][0]
        transcript_edits.save_edit(self.path, 1, 0, [word], "corrected")
        with patch.object(transcript_repair_runner, "transcribe_span",
                          side_effect=AssertionError("inference must not run")):
            status = transcript_repair_runner.repair_transcript(self.source, self.path)
        self.assertTrue(status["human_review_required"])
        self.assertEqual(status["repair_status"], "conflict")
        self.assertFalse(status["repair_exists"])
        self.assertEqual(transcript_edits.load_effective_transcript(self.path)[0]
                         ["segments"][1]["words"][0]["word"], "corrected")

    def test_stale_repair_digest_is_safely_ignored(self):
        self.activate()
        sidecar = transcript_repairs.repairs_path_for(self.path)
        data = json.loads(sidecar.read_text())
        data["raw_sha256"] = hashlib.sha256(b"different raw bytes").hexdigest()
        sidecar.write_text(json.dumps(data))
        effective, _, warnings = transcript_edits.load_effective_transcript(self.path)
        self.assertEqual(effective, self.raw)
        self.assertTrue(warnings)

    def test_existing_raw_transcript_cannot_be_overwritten(self):
        from app.services import transcribe
        with patch.object(transcribe, "transcript_path_for", return_value=self.path):
            with self.assertRaises(FileExistsError):
                transcribe.write_transcript({"source": "sample.mp4", "segments": []})
        self.assertEqual(self.path.read_bytes(), self.original_bytes)

    def test_owned_context_windows_do_not_duplicate_overlap(self):
        windows = transcript_repair_runner.owned_windows(0, 20, 20, 10, 5)
        self.assertEqual([(w["owned_start"], w["owned_end"]) for w in windows],
                         [(0, 10), (10, 20)])
        decoded = [
            [{"word": "one", "start": 9.4, "end": 9.8}],
            [{"word": "one", "start": 4.4, "end": 4.8},
             {"word": "two", "start": 5.2, "end": 5.6}],
        ]
        with patch.object(transcript_repair_runner, "_extract_audio"):
            def fake_transcribe(_audio, _backend):
                return decoded.pop(0)
            words, meta = transcript_repair_runner.transcribe_span(
                self.source, 0, 20, 20, "whispercpp", owned_seconds=10,
                context_seconds=5, transcribe_fn=fake_transcribe)
        self.assertEqual([w["word"] for w in words], ["one", "two"])
        self.assertEqual(meta["window_word_counts"], [1, 1])
        self.assertGreaterEqual(words[1]["start"], words[0]["end"])

    def test_fallback_only_runs_after_primary_candidate_fails(self):
        good_words = [{"word": f"unique{i}", "start": float(i), "end": i + 0.8}
                      for i in range(3, 27)]
        with patch.object(transcript_repair_runner.transcribe, "_resolve_backend", return_value="whispercpp"), \
             patch.object(transcript_repair_runner.settings, "transcript_repair_backend", "ctranslate2"), \
             patch.object(transcript_repair_runner.settings, "transcript_repair_model", "small.en"), \
             patch.object(transcript_repair_runner, "_fallback_available", return_value=(True, "cached")), \
             patch.object(transcript_repair_runner, "transcribe_span",
                          side_effect=[([], {"window_word_counts": [0],
                                            "boundary_duplicates_removed": 0}),
                                       (good_words, {"window_word_counts": [24],
                                                     "boundary_duplicates_removed": 0})]) as run:
            status = transcript_repair_runner.repair_transcript(self.source, self.path)
        self.assertEqual(run.call_count, 2)
        self.assertEqual([call.args[4] for call in run.call_args_list],
                         ["whispercpp", "ctranslate2"])
        self.assertEqual([call.kwargs["model_name"] for call in run.call_args_list],
                         ["large-v3", "small.en"])
        self.assertEqual(status["effective_quality"]["status"], "clean")
        self.assertEqual([a["status"] for a in transcript_repairs.read_sidecar(self.path)["attempts"]],
                         ["failed", "accepted"])

    def test_fallback_cache_check_uses_repair_model(self):
        with patch.object(transcript_repair_runner.settings, "transcript_repair_backend", "ctranslate2"), \
             patch.object(transcript_repair_runner.settings, "transcript_repair_model", "small.en"), \
             patch.object(transcript_repair_runner.settings,
                          "transcript_repair_allow_model_download", False), \
             patch("faster_whisper.utils.download_model", return_value="cached") as download:
            available, reason = transcript_repair_runner._fallback_available()
        self.assertTrue(available)
        self.assertEqual(reason, "model weights cached locally")
        download.assert_called_once_with("small.en", local_files_only=True)

    def test_successful_primary_does_not_run_fallback_inference(self):
        good_words = [{"word": f"unique{i}", "start": float(i), "end": i + 0.8}
                      for i in range(3, 27)]
        with patch.object(transcript_repair_runner.transcribe, "_resolve_backend", return_value="whispercpp"), \
             patch.object(transcript_repair_runner, "_fallback_available",
                          side_effect=AssertionError("fallback should not be checked")), \
             patch.object(transcript_repair_runner, "transcribe_span",
                          return_value=(good_words, {"window_word_counts": [24],
                                                    "boundary_duplicates_removed": 0})) as run:
            status = transcript_repair_runner.repair_transcript(self.source, self.path)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(status["effective_quality"]["status"], "clean")

    def test_normal_transcript_never_invokes_repair_backend(self):
        normal = {"source": "sample.mp4", "duration": 3,
                  "segments": [segment(0, 0, 3, "A normal example.")]}
        self.path.write_text(json.dumps(normal))
        with patch.object(transcript_repair_runner.transcribe, "_resolve_backend",
                          side_effect=AssertionError("model must not be selected")):
            status = transcript_repair_runner.repair_transcript(self.source, self.path)
        self.assertEqual(status["effective_quality"]["status"], "clean")
        self.assertFalse(transcript_repairs.repairs_path_for(self.path).exists())

    def test_clip_selection_guard_blocks_failed_effective_transcript(self):
        from app.services import jobs
        with self.assertRaises(ValueError):
            jobs._ensure_transcript_selectable(self.path)
        with patch.object(jobs.transcribe, "transcript_path_for", return_value=self.path), \
             patch.object(jobs.clip_selection, "clips_path_for",
                          return_value=Path(self.temp.name) / "clips.json"), \
             patch.object(jobs, "create_select_clips_job") as select:
            jobs._maybe_chain_select_clips("sample.mp4")
        select.assert_not_called()
        self.activate()
        jobs._ensure_transcript_selectable(self.path)


class RepairWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_new_transcript_queues_repair_before_selection(self):
        from app.services import jobs
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "sample.mp4"
            source.touch()
            path = Path(temp_dir) / "transcript.json"
            path.write_text(json.dumps(corrupted_transcript()))
            job = jobs.Job(id="synthetic", kind="transcribe", source="sample.mp4")
            with patch.object(jobs, "_start", new_callable=AsyncMock), \
                 patch.object(jobs, "_save"), patch.object(jobs, "_finish"), \
                 patch.object(jobs.transcribe, "transcribe_file", return_value=corrupted_transcript()), \
                 patch.object(jobs.transcribe, "write_transcript", return_value=path), \
                 patch.object(jobs.transcribe, "transcript_path_for", return_value=path), \
                 patch.object(jobs, "create_repair_job") as repair, \
                 patch.object(jobs, "_maybe_chain_select_clips") as select, \
                 patch.object(jobs, "_maybe_chain_prescan"):
                await jobs._run_transcribe(job, source)
            repair.assert_called_once()
            self.assertTrue(repair.call_args.kwargs["auto_chain"])
            select.assert_not_called()

    async def test_clean_new_transcript_skips_repair(self):
        from app.services import jobs
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "sample.mp4"
            source.touch()
            path = Path(temp_dir) / "transcript.json"
            clean = {"source": "sample.mp4", "duration": 3,
                     "segments": [segment(0, 0, 3, "A normal example.")]}
            path.write_text(json.dumps(clean))
            job = jobs.Job(id="synthetic", kind="transcribe", source="sample.mp4")
            with patch.object(jobs, "_start", new_callable=AsyncMock), \
                 patch.object(jobs, "_save"), patch.object(jobs, "_finish"), \
                 patch.object(jobs.transcribe, "transcribe_file", return_value=clean), \
                 patch.object(jobs.transcribe, "write_transcript", return_value=path), \
                 patch.object(jobs.transcribe, "transcript_path_for", return_value=path), \
                 patch.object(jobs, "create_repair_job") as repair, \
                 patch.object(jobs, "_maybe_chain_select_clips") as select, \
                 patch.object(jobs, "_maybe_chain_prescan"):
                await jobs._run_transcribe(job, source)
            repair.assert_not_called()
            select.assert_called_once()


if __name__ == "__main__":
    unittest.main()
