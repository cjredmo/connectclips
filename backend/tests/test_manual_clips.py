"""Manual clip creation against synthetic media metadata and clip lists."""

import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.routers.auth import require_admin
from app.services import clip_overrides, clip_selection, jobs, manual_clips
from app.services.transcribe import transcript_path_for


class ManualClipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for field, value in (("data_sources_dir", root / "sources"),
                             ("data_work_dir", root / "work"),
                             ("data_clips_dir", root / "exports")):
            scoped = patch.object(settings, field, value)
            scoped.start()
            self.addCleanup(scoped.stop)
        source = settings.data_sources_dir / "sample.mp4"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"synthetic source")
        self.transcript = transcript_path_for(source.name)
        self.transcript.parent.mkdir(parents=True)
        self.transcript.write_text(json.dumps({"source": source.name, "duration": 120,
            "segments": [{"id": 0, "start": 0, "end": 2,
                          "text": "Generic sample words.", "words": []}]}), encoding="utf-8")
        self.original_transcript = self.transcript.read_bytes()
        export_lookup = patch.object(jobs, "latest_export_for_clip", return_value=None)
        export_lookup.start()
        self.addCleanup(export_lookup.stop)
        for name, value in (("schedule_saved_clip", None),
                            ("preparation_status", {"status": "waiting"})):
            scoped = patch.object(jobs, name, return_value=value)
            scoped.start()
            self.addCleanup(scoped.stop)

    def test_create_and_retrieve_without_ai_metadata(self):
        app.dependency_overrides[require_admin] = lambda: None
        self.addCleanup(app.dependency_overrides.pop, require_admin, None)
        client = TestClient(app)
        response = client.post("/api/sermons/sample.mp4/clips/manual", json={
            "title": "  A generic clip title  ", "start": 0, "end": 40.25})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["clip_index"], 0)
        clip = response.json()["clip"]
        self.assertEqual((clip["title"], clip["start"], clip["end"]),
                         ("A generic clip title", 0, 40.25))
        self.assertEqual(clip["user_edits"], {})
        self.assertEqual(clip["origin"], "manual")
        self.assertEqual(clip["selection_method"], "manual")
        self.assertTrue(clip["id"])
        self.assertFalse(clip["exported"])
        listed = client.get("/api/sermons/sample.mp4/clips").json()
        self.assertEqual(listed["clips"][0]["title"], clip["title"])
        self.assertNotIn("model", listed)
        self.assertNotIn("usage", listed)
        self.assertNotIn("hook_score", listed["clips"][0])
        self.assertNotIn("rationale", listed["clips"][0])
        self.assertIsNone(clip["scripture_reference"])
        self.assertEqual(self.transcript.read_bytes(), self.original_transcript)
        jobs.schedule_saved_clip.assert_called_once_with("sample.mp4", clip["id"])

    def test_optional_scripture_reference_on_manual_clip(self):
        app.dependency_overrides[require_admin] = lambda: None
        self.addCleanup(app.dependency_overrides.pop, require_admin, None)
        client = TestClient(app)
        response = client.post("/api/sermons/sample.mp4/clips/manual", json={
            "title": "Referenced sample", "start": 1, "end": 5,
            "scripture_reference": "  Ezekiel 8–11  "})
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["clip"]["scripture_reference"], "Ezekiel 8–11")
        stored = json.loads(clip_selection.clips_path_for("sample.mp4").read_text())["clips"][0]
        self.assertEqual(stored["scripture_reference"], "Ezekiel 8–11")
        for value in ({"book": "Ezekiel"}, "A" * 121):
            invalid = client.post("/api/sermons/sample.mp4/clips/manual", json={
                "title": "Invalid sample", "start": 6, "end": 8,
                "scripture_reference": value})
            self.assertIn(invalid.status_code, (400, 422))
        self.assertEqual(len(json.loads(clip_selection.clips_path_for("sample.mp4").read_text())["clips"]), 1)

    def test_scripture_reference_edit_and_clear_preserve_clip_identity_and_transcript(self):
        app.dependency_overrides[require_admin] = lambda: None
        self.addCleanup(app.dependency_overrides.pop, require_admin, None)
        client = TestClient(app)
        created = client.post("/api/sermons/sample.mp4/clips/manual", json={
            "title": "Synthetic clip", "start": 3, "end": 8}).json()["clip"]
        path = clip_selection.clips_path_for("sample.mp4")
        before = json.loads(path.read_text(encoding="utf-8"))
        route = "/api/sermons/sample.mp4/clips/0/scripture-reference"
        updated = client.patch(route, json={"clip_id": created["id"],
                                           "scripture_reference": "  Example 2:3  "})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json(), {"scripture_reference": "Example 2:3"})
        saved = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(saved["clips_version"], before["clips_version"])
        self.assertEqual({k: v for k, v in saved["clips"][0].items() if k != "scripture_reference"},
                         before["clips"][0])
        self.assertEqual(client.get("/api/sermons/sample.mp4/clips").json()["clips"][0]["scripture_reference"],
                         "Example 2:3")
        for payload in ({"clip_id": "stale", "scripture_reference": "Other 1"},
                        {"clip_id": created["id"], "scripture_reference": "X" * 121}):
            self.assertIn(client.patch(route, json=payload).status_code, (400, 409))
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["clips"][0]["scripture_reference"],
                         "Example 2:3")
        cleared = client.patch(route, json={"clip_id": created["id"], "scripture_reference": "  "})
        self.assertEqual(cleared.json(), {"scripture_reference": None})
        self.assertNotIn("scripture_reference", json.loads(path.read_text(encoding="utf-8"))["clips"][0])
        self.assertEqual(self.transcript.read_bytes(), self.original_transcript)

    def test_rerun_preserves_manual_clip_and_reindexes_its_overrides(self):
        source = "sample.mp4"
        path = clip_selection.clips_path_for(source)
        old_ai = {"title": "Old suggestion", "start": 1, "end": 9,
                  "rationale": "Synthetic suggestion"}
        legacy_ai = {"title": "Older suggestion", "start": 10, "end": 19,
                     "rationale": "Older synthetic suggestion"}
        manual = {"id": "stable-manual-id", "origin": "manual",
                  "title": "User clip", "start": 30, "end": 40,
                  "scripture_reference": "Isaiah 6",
                  "custom_field": {"kept": True}}
        path.write_text(json.dumps({"source": source,
            "clips_version": "old-version", "clips": [old_ai, legacy_ai, manual]}), encoding="utf-8")
        old_override = {"start": 31, "caption_style": "classic", "include_hook_title": False}
        manual_override = {"end": 41, "caption_style": "classic", "zoom_level": "wide"}
        clip_overrides.replace_all(source, {"0": old_override, "2": manual_override})

        for generation in (1, 2):
            result = {"source": source, "clips_version": f"version-{generation}",
                      "model": "synthetic-model", "clips": [{
                          "title": f"New suggestion {generation}",
                          "start": 5 * generation, "end": 10 * generation + 1,
                          "rationale": "Synthetic result",
                      }]}
            clip_selection.write_clips(result)
            stored = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(stored["clips_version"], result["clips_version"])
            self.assertEqual(len(stored["clips"]), 2)
            self.assertEqual(stored["clips"][0]["title"], f"New suggestion {generation}")
            self.assertEqual(stored["clips"][0]["origin"], "ai")
            self.assertEqual(stored["clips"][0]["selection_method"], "claude_api")
            self.assertEqual(stored["clips"][1], manual)
            self.assertEqual(clip_overrides.load_overrides(source), {"1": manual_override})
            self.assertEqual(len([clip for clip in stored["clips"]
                                  if clip.get("id") == manual["id"]]), 1)
            self.assertNotIn("Old suggestion", [clip["title"] for clip in stored["clips"]])
            self.assertNotIn("Older suggestion", [clip["title"] for clip in stored["clips"]])

        app.dependency_overrides[require_admin] = lambda: None
        self.addCleanup(app.dependency_overrides.pop, require_admin, None)
        listed = TestClient(app).get("/api/sermons/sample.mp4/clips")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json()["clips"][1]["user_edits"], manual_override)

    def test_first_generation_minimal_manual_clip_survives_rerun(self):
        source = "sample.mp4"
        path = clip_selection.clips_path_for(source)
        legacy_manual = {"title": "Earlier manual clip", "start": 30, "end": 40}
        path.write_text(json.dumps({"source": source, "clips": [legacy_manual]}), encoding="utf-8")
        result = {"source": source, "clips_version": "new-version", "clips": []}
        clip_selection.write_clips(result)
        stored = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(stored["clips"][0]["origin"], "manual")
        self.assertTrue(stored["clips"][0]["id"])
        self.assertEqual({key: stored["clips"][0][key] for key in legacy_manual}, legacy_manual)
        first_id = stored["clips"][0]["id"]
        clip_selection.write_clips(result)
        stored_again = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(len(stored_again["clips"]), 1)
        self.assertEqual(stored_again["clips"][0]["id"], first_id)

    def test_validation_and_duration_boundary(self):
        for title, start, end, message in (
            (" ", 0, 2, "title"),
            ("Sample", 3, 3, "after start"),
            ("Sample", 3, 2, "after start"),
            ("Sample", -1, 2, "zero or later"),
            ("Sample", 0, math.nan, "finite"),
            ("Sample", math.inf, 2, "finite"),
            ("Sample", 0, 121, "duration"),
        ):
            with self.subTest(start=start, end=end), self.assertRaisesRegex(ValueError, message):
                manual_clips.create("sample.mp4", self.transcript, title, start, end)
        self.assertFalse(clip_selection.clips_path_for("sample.mp4").exists())

        app.dependency_overrides[require_admin] = lambda: None
        self.addCleanup(app.dependency_overrides.pop, require_admin, None)
        client = TestClient(app)
        invalid = client.post("/api/sermons/sample.mp4/clips/manual", json={
            "title": "Sample", "start": 20, "end": 10})
        self.assertEqual(invalid.status_code, 400)
        self.assertIn("after start", invalid.json()["detail"])
        malformed = client.post("/api/sermons/sample.mp4/clips/manual", json={
            "title": "Sample", "start": "invalid", "end": 10})
        self.assertEqual(malformed.status_code, 422)
        self.assertFalse(clip_selection.clips_path_for("sample.mp4").exists())

    def test_existing_ai_clips_and_version_are_preserved(self):
        existing = {"source": "sample.mp4", "model": "synthetic-model",
                    "usage": {"input_tokens": 1}, "clips_version": "fixed-version",
                    "created_at": "2020-01-01T00:00:00Z", "clips": [{
                        "title": "Existing suggestion", "start": 10, "end": 20,
                        "rationale": "Synthetic rationale", "hook_score": 70,
                    }]}
        path = clip_selection.clips_path_for("sample.mp4")
        path.write_text(json.dumps(existing), encoding="utf-8")
        index, clip = manual_clips.create("sample.mp4", self.transcript,
                                          "Another clip", 30.125, 51.5)
        after = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(index, 1)
        self.assertEqual(after["clips"][0], existing["clips"][0])
        self.assertEqual(after["clips_version"], "fixed-version")
        self.assertEqual(after["model"], "synthetic-model")
        self.assertEqual(after["clips"][1], clip)
        self.assertEqual((clip["start"], clip["end"]), (30.125, 51.5))
        self.assertEqual(self.transcript.read_bytes(), self.original_transcript)


if __name__ == "__main__":
    unittest.main()
