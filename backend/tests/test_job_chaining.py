"""Automatic transcript jobs stop before explicit clip selection."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.services import jobs


class TranscriptChainTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name) / "sample.mp4"
        self.source.touch()
        self.transcript = Path(self.temp.name) / "transcript.json"
        self.transcript.touch()

    def tearDown(self):
        self.temp.cleanup()

    async def test_clean_transcription_stops_after_qc_and_prescan(self):
        job = jobs.Job(id="synthetic", kind="transcribe", source="sample.mp4")
        quality = {"raw_quality": {"status": "clean"},
                   "effective_quality": {"status": "clean"}, "human_review_required": False}
        with patch.object(jobs, "_start", new_callable=AsyncMock), \
             patch.object(jobs, "_save"), patch.object(jobs, "_finish"), \
             patch.object(jobs.transcribe, "transcribe_file", return_value={}), \
             patch.object(jobs.transcribe, "write_transcript", return_value=self.transcript), \
             patch.object(jobs.transcribe, "transcript_path_for", return_value=self.transcript), \
             patch.object(jobs.transcript_repairs, "transcript_status", return_value=quality), \
             patch.object(jobs, "create_repair_job") as repair, \
             patch.object(jobs, "create_alignment_job") as alignment, \
             patch.object(jobs, "_maybe_chain_prescan") as prescan, \
             patch.object(jobs, "create_select_clips_job") as selection:
            await jobs._run_transcribe(job, self.source)
        repair.assert_not_called()
        alignment.assert_not_called()
        prescan.assert_called_once_with("sample.mp4", user_login=None, user_name=None)
        selection.assert_not_called()

    async def test_failed_transcription_chains_repair_and_prescan_only(self):
        job = jobs.Job(id="synthetic", kind="transcribe", source="sample.mp4")
        quality = {"raw_quality": {"status": "failed"},
                   "effective_quality": {"status": "failed"}, "human_review_required": True}
        with patch.object(jobs, "_start", new_callable=AsyncMock), \
             patch.object(jobs, "_save"), patch.object(jobs, "_finish"), \
             patch.object(jobs.transcribe, "transcribe_file", return_value={}), \
             patch.object(jobs.transcribe, "write_transcript", return_value=self.transcript), \
             patch.object(jobs.transcribe, "transcript_path_for", return_value=self.transcript), \
             patch.object(jobs.transcript_repairs, "transcript_status", return_value=quality), \
             patch.object(jobs, "create_repair_job") as repair, \
             patch.object(jobs, "create_alignment_job") as alignment, \
             patch.object(jobs, "_maybe_chain_prescan") as prescan, \
             patch.object(jobs, "create_select_clips_job") as selection:
            await jobs._run_transcribe(job, self.source)
        repair.assert_called_once_with("sample.mp4", user_login=None, user_name=None)
        alignment.assert_not_called()
        prescan.assert_called_once()
        selection.assert_not_called()

    async def test_repair_completion_stops_at_transcript_ready(self):
        job = jobs.Job(id="synthetic", kind="repair_transcript", source="sample.mp4")
        with patch.object(jobs, "_start", new_callable=AsyncMock), \
             patch.object(jobs, "_save"), patch.object(jobs, "_finish"), \
             patch.object(jobs.transcript_repair_runner, "repair_transcript",
                          return_value={"human_review_required": False}), \
             patch.object(jobs, "create_alignment_job") as alignment, \
             patch.object(jobs, "create_select_clips_job") as selection:
            await jobs._run_repair(job, self.source, self.transcript)
        alignment.assert_not_called()
        selection.assert_not_called()

    async def test_failed_repair_requires_review_and_stops(self):
        job = jobs.Job(id="synthetic", kind="repair_transcript", source="sample.mp4")
        with patch.object(jobs, "_start", new_callable=AsyncMock), \
             patch.object(jobs, "_save"), patch.object(jobs, "_finish") as finish, \
             patch.object(jobs.transcript_repair_runner, "repair_transcript",
                          return_value={"human_review_required": True}), \
             patch.object(jobs, "create_alignment_job") as alignment, \
             patch.object(jobs, "create_select_clips_job") as selection:
            await jobs._run_repair(job, self.source, self.transcript)
        finish.assert_called_once_with(job, "Transcript repair requires human review")
        alignment.assert_not_called()
        selection.assert_not_called()

    async def test_alignment_completion_stops(self):
        job = jobs.Job(id="synthetic", kind="align_transcript", source="sample.mp4")
        with patch.object(jobs, "_start", new_callable=AsyncMock), \
             patch.object(jobs, "_save"), patch.object(jobs, "_finish") as finish, \
             patch.object(jobs.alignment_runner, "align_transcript"), \
             patch.object(jobs.transcript_alignment, "status", return_value={"acceptable": True}), \
             patch.object(jobs, "create_select_clips_job") as selection:
            await jobs._run_alignment(job, self.source, self.transcript)
        finish.assert_called_once_with(job)
        selection.assert_not_called()

    async def test_youtube_download_starts_transcription_only(self):
        job = jobs.Job(id="synthetic", kind="youtube_download")
        with patch.object(jobs, "_start", new_callable=AsyncMock), \
             patch.object(jobs, "_save"), patch.object(jobs, "_finish"), \
             patch.object(jobs.ingest, "download_youtube", return_value=self.source), \
             patch.object(jobs, "_maybe_chain_transcribe") as transcription, \
             patch.object(jobs, "create_select_clips_job") as selection:
            await jobs._run_youtube(job, "https://example.com/video")
        transcription.assert_called_once_with("sample.mp4", user_login=None, user_name=None)
        selection.assert_not_called()


class ExplicitSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.transcript = Path(self.temp.name) / "transcript.json"
        self.transcript.touch()

    def tearDown(self):
        self.temp.cleanup()

    def test_explicit_job_preserves_count_and_starts_runner(self):
        job = jobs.Job(id="synthetic", kind="select_clips", source="sample.mp4")
        def close_task(coroutine):
            coroutine.close()
        with patch.object(jobs.transcribe, "transcript_path_for", return_value=self.transcript), \
             patch.object(jobs.transcript_repairs, "transcript_status", return_value={
                 "effective_quality": {"status": "clean"}, "human_review_required": False}), \
             patch.object(jobs.transcript_alignment, "status",
                          side_effect=AssertionError("alignment is optional")), \
             patch.object(jobs, "_new_job", return_value=job) as new_job, \
             patch.object(jobs, "_run_select_clips", new_callable=AsyncMock) as runner, \
             patch.object(jobs.asyncio, "create_task", side_effect=close_task):
            result = jobs.create_select_clips_job("sample.mp4", 4, 9)
        self.assertIs(result, job)
        self.assertEqual(new_job.call_args.kwargs["kind"], "select_clips")
        runner.assert_called_once_with(job, self.transcript, 4, 9)

    def test_explicit_job_keeps_quality_gate_without_alignment_gate(self):
        with patch.object(jobs.transcribe, "transcript_path_for", return_value=self.transcript), \
             patch.object(jobs.transcript_repairs, "transcript_status", return_value={
                 "effective_quality": {"status": "failed"}, "human_review_required": False}), \
             patch.object(jobs, "_new_job") as new_job:
            with self.assertRaisesRegex(ValueError, "quality"):
                jobs.create_select_clips_job("sample.mp4")
        new_job.assert_not_called()
        with patch.object(jobs.transcribe, "transcript_path_for", return_value=self.transcript), \
             patch.object(jobs.transcript_repairs, "transcript_status", return_value={
                 "effective_quality": {"status": "clean"}, "human_review_required": True}), \
             patch.object(jobs, "_new_job") as new_job:
            with self.assertRaisesRegex(ValueError, "review"):
                jobs.create_select_clips_job("sample.mp4")
        new_job.assert_not_called()
        with patch.object(jobs.transcript_repairs, "transcript_status", return_value={
                 "effective_quality": {"status": "clean"}, "human_review_required": False}), \
             patch.object(jobs.transcript_alignment, "status",
                          side_effect=AssertionError("alignment must not be checked")):
            jobs._ensure_transcript_selectable(self.transcript)


if __name__ == "__main__":
    unittest.main()
