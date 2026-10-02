"""Version 1 JSON imports use synthetic clips and the existing clip list."""

import json
import math
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.routers.auth import require_admin
from app.services import clip_import, clip_metadata, clip_overrides, clip_selection, jobs, manual_clips
from app.services.transcribe import transcript_path_for


class ClipImportTests(unittest.TestCase):
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
        self.transcript.write_text(json.dumps({"source": source.name, "duration": 5000,
            "segments": []}), encoding="utf-8")
        app.dependency_overrides[require_admin] = lambda: None
        self.addCleanup(app.dependency_overrides.pop, require_admin, None)
        self.client = TestClient(app)
        lookup = patch.object(jobs, "latest_export_for_clip", return_value=None)
        lookup.start()
        self.addCleanup(lookup.stop)
        self.path = clip_selection.clips_path_for(source.name)

    def import_json(self, clips, version=1):
        return self.client.post("/api/sermons/sample.mp4/clips/import",
                                json={"schema_version": version, "clips": clips})

    def test_multi_clip_import_metadata_times_ids_and_duplicates(self):
        clips = [{"title": "First sample", "start": "9:18", "end": "9:18.2",
                  "description": "Neutral summary.", "why_selected": "Complete thought.",
                  "hook": "Clear opening.", "score": 82},
                 {"title": "Second sample", "start": "1:09:18.250", "end": 4160.5}]
        response = self.import_json(clips)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.json()["imported"], response.json()["duplicates_skipped"]), (2, 0))
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        first, second = stored["clips"]
        self.assertEqual((first["start"], first["end"]), (558, 558.2))
        self.assertEqual((second["start"], second["end"]), (4158.25, 4160.5))
        self.assertEqual({key: first[key] for key in ("description", "why_selected", "hook", "score")},
                         {key: clips[0][key] for key in ("description", "why_selected", "hook", "score")})
        self.assertEqual(first["origin"], "json_import")
        self.assertEqual(first["selection_method"], "json_import")
        self.assertEqual(first["selection_batch_id"], second["selection_batch_id"])
        self.assertTrue(first["selection_created_at"])
        self.assertNotEqual(first["id"], second["id"])
        self.assertNotIn("score", second)
        version = stored["clips_version"]
        duplicate = self.import_json(clips)
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual((duplicate.json()["imported"], duplicate.json()["duplicates_skipped"]), (0, 2))
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["clips"], stored["clips"])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["clips_version"], version)

    def test_ai_chat_import_uses_snapshot_and_keeps_duplicates_unchanged(self):
        batch = uuid.uuid4().hex
        context = {"source": "sample.mp4", "selection_method": "ai_chat",
                   "selection_batch_id": batch, "selection_prompt_id": "teaching-theology",
                   "selection_prompt_name": "Teaching / Theology",
                   "selection_prompt_revision": None,
                   "selection_created_at": "2026-01-02T03:04:05.000Z"}
        document = {"schema_version": 1, "clips": [
            {"title": "Sample A", "start": 10, "end": 20},
            {"title": "Sample B", "start": 30, "end": 40}]}
        response = self.client.post("/api/sermons/sample.mp4/clips/import",
                                    json={"payload": document, "provenance": context})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["imported"], 2)
        before = json.loads(self.path.read_text(encoding="utf-8"))["clips"]
        for clip in before:
            self.assertEqual(clip["origin"], "json_import")
            self.assertEqual(clip["selection_method"], "ai_chat")
            self.assertEqual(clip["selection_batch_id"], batch)
            self.assertEqual(clip["selection_prompt_id"], "teaching-theology")
            self.assertEqual(clip["selection_prompt_name"], "Teaching / Theology")
            self.assertIsNone(clip["selection_prompt_revision"])
        duplicate = self.client.post("/api/sermons/sample.mp4/clips/import",
            json={"payload": document, "provenance": {**context,
                  "selection_batch_id": uuid.uuid4().hex,
                  "selection_prompt_name": "Renamed prompt"}})
        self.assertEqual((duplicate.json()["imported"], duplicate.json()["duplicates_skipped"]), (0, 2))
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["clips"], before)
        imported_override = {"end": 21, "caption_style": "classic"}
        clip_overrides.replace_all("sample.mp4", {"0": imported_override})
        clip_selection.write_clips({"source": "sample.mp4", "clips_version": "next",
            "clips": [{"title": "New Claude A", "start": 50, "end": 60},
                      {"title": "New Claude B", "start": 70, "end": 80}]})
        after = json.loads(self.path.read_text(encoding="utf-8"))["clips"]
        self.assertEqual(after[2:], before)
        self.assertEqual(after[0]["selection_method"], "claude_api")
        self.assertEqual(after[0]["selection_batch_id"], after[1]["selection_batch_id"])
        self.assertEqual(after[0]["selection_created_at"], after[1]["selection_created_at"])
        self.assertNotEqual(after[0]["selection_batch_id"], batch)
        self.assertEqual(clip_overrides.load_overrides("sample.mp4"), {"2": imported_override})

    def test_import_rejects_spoofed_or_malformed_provenance(self):
        clip = {"title": "Sample", "start": 1, "end": 2}
        context = {"source": "sample.mp4", "selection_method": "ai_chat",
                   "selection_batch_id": uuid.uuid4().hex,
                   "selection_prompt_id": "custom:" + "a" * 32,
                   "selection_prompt_name": "Original name", "selection_prompt_revision": 2,
                   "selection_created_at": "2026-01-02T03:04:05+00:00"}
        for key in ("origin", "selection_method", "selection_batch_id",
                    "selection_prompt_id", "selection_prompt_name", "selection_prompt_revision"):
            with self.subTest(key=key):
                response = self.import_json([{**clip, key: "spoofed"}])
                self.assertEqual(response.status_code, 400)
                self.assertFalse(self.path.exists())
        invalid = [{**context, "source": "another.mp4"},
                   {**context, "selection_method": "claude_api"},
                   {**context, "selection_batch_id": "bad"},
                   {**context, "selection_prompt_id": "bad id"},
                   {**context, "selection_prompt_id": "unknown-preset"},
                   {**context, "selection_prompt_name": " "},
                   {**context, "selection_prompt_revision": 0},
                   {**context, "selection_created_at": "not a date"},
                   {**context, "unknown": "field"}]
        for provenance in invalid:
            with self.subTest(provenance=provenance):
                response = self.client.post("/api/sermons/sample.mp4/clips/import",
                    json={"payload": {"schema_version": 1, "clips": [clip]},
                          "provenance": provenance})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertFalse(self.path.exists())
        self.assertEqual(self.client.post("/api/sermons/sample.mp4/clips/import", json={
            "payload": {"schema_version": 1, "clips": [clip]}}).status_code, 400)
        self.assertEqual(self.client.post("/api/sermons/sample.mp4/clips/import", json={
            "payload": {"schema_version": 1, "clips": [clip]},
            "provenance": None}).status_code, 400)

    def test_custom_prompt_revision_snapshot_is_stored(self):
        context = {"source": "sample.mp4", "selection_method": "ai_chat",
                   "selection_batch_id": uuid.uuid4().hex,
                   "selection_prompt_id": "custom:" + "a" * 32,
                   "selection_prompt_name": "Custom selection at copy time",
                   "selection_prompt_revision": 3,
                   "selection_created_at": "2026-01-02T03:04:05+00:00"}
        response = self.client.post("/api/sermons/sample.mp4/clips/import", json={
            "payload": {"schema_version": 1, "clips": [
                {"title": "Custom sample", "start": 12, "end": 24}]},
            "provenance": context})
        self.assertEqual(response.status_code, 200, response.text)
        stored = json.loads(self.path.read_text(encoding="utf-8"))["clips"][0]
        self.assertEqual(stored["selection_prompt_id"], context["selection_prompt_id"])
        self.assertEqual(stored["selection_prompt_name"], context["selection_prompt_name"])
        self.assertEqual(stored["selection_prompt_revision"], 3)

    def test_legacy_normalization_does_not_invent_selection_batches(self):
        legacy = [
            {"origin": "ai", "title": "Earlier Claude", "start": 1, "end": 2},
            {"origin": "json_import", "title": "Earlier import", "start": 3, "end": 4},
            {"title": "Unclassified", "start": 5, "end": 6, "rationale": "Old metadata"},
            {"title": "Earlier manual", "start": 7, "end": 8},
        ]
        normalized = [dict(clip) for clip in legacy]
        for index, clip in enumerate(normalized):
            clip_metadata.normalize_for_display(clip, "sample.mp4", "old", index)
        self.assertEqual([clip["selection_method"] for clip in normalized],
                         ["claude_api", None, None, "manual"])
        self.assertTrue(all(clip["selection_batch_id"] is None for clip in normalized))
        self.assertEqual(legacy[0].get("selection_method"), None)

    def test_all_friendly_timestamp_forms_and_numeric_seconds(self):
        starts = [("9:18", 558), ("9:18.2", 558.2), ("09:18.240", 558.24),
                  ("45:35.760", 2735.76), ("1:09:18", 4158),
                  ("1:09:18.250", 4158.25), (34.5, 34.5), ("34.2", 34.2)]
        items = [{"title": f"Sample {index}", "start": value, "end": expected + 1}
                 for index, (value, expected) in enumerate(starts)]
        validated = clip_import.validate({"schema_version": 1, "clips": items}, self.transcript)
        self.assertEqual([clip["start"] for clip in validated], [expected for _, expected in starts])

    def test_atomic_validation_and_per_clip_errors(self):
        valid = {"title": "Valid sample", "start": "09:18.240", "end": "10:00"}
        invalid = [
            (None, "must be an object"), ({"start": 1, "end": 2}, "title"),
            ({"title": "   ", "start": 1, "end": 2}, "title"),
            ({"title": "Bad time", "start": "9:99", "end": 20}, "start"),
            ({"title": "Negative", "start": -1, "end": 20}, "zero or later"),
            ({"title": "Reverse", "start": 20, "end": 10}, "after start"),
            ({"title": "Too late", "start": 1, "end": 5001}, "duration"),
            ({"title": "Bad score", "start": 1, "end": 2, "score": 101}, "score"),
            ({"title": "Wrong field", "start": 1, "end": 2, "origin": "manual"}, "unknown fields"),
        ]
        for bad, expected in invalid:
            with self.subTest(expected=expected):
                response = self.import_json([valid, bad])
                self.assertEqual(response.status_code, 400)
                self.assertIn("clip 2", response.json()["detail"])
                self.assertIn(expected, response.json()["detail"])
                self.assertFalse(self.path.exists())
        for bad, expected in (({"title": "Nonfinite score", "start": 1, "end": 2,
                                "score": math.nan}, "score"),
                              ({"title": "Nonfinite time", "start": math.inf,
                                "end": 2}, "finite")):
            with self.assertRaisesRegex(clip_import.ClipImportError, expected):
                clip_import.validate({"schema_version": 1, "clips": [valid, bad]}, self.transcript)
        for document in ({"schema_version": 2, "clips": [valid]},
                         {"schema_version": 1, "clips": []}):
            response = self.client.post("/api/sermons/sample.mp4/clips/import", json=document)
            self.assertEqual(response.status_code, 400)
            self.assertFalse(self.path.exists())

    def test_import_adds_to_manual_and_ai_and_survives_ai_rerun_with_overrides(self):
        source = "sample.mp4"
        old_ai = {"title": "Old AI", "start": 1, "end": 9,
                  "rationale": "Works as a standalone clip.",
                  "hook_rationale": "Strong opening.", "hook_score": 75}
        clip_selection.write_clips({"source": source, "clips_version": "version-1",
                                    "clips": [old_ai]})
        _, manual = manual_clips.create(source, self.transcript, "Manual sample", 20, 30)
        skipped = self.import_json([{"title": " manual  sample ", "start": "0:20", "end": "0:30"}])
        self.assertEqual((skipped.json()["imported"], skipped.json()["duplicates_skipped"]), (0, 1))
        response = self.import_json([{"title": "Imported sample", "start": "40:00", "end": "40:35",
                                      "description": "A neutral summary."}])
        self.assertEqual(response.status_code, 200, response.text)
        imported = json.loads(self.path.read_text(encoding="utf-8"))["clips"][2]
        manual_override = {"start": 21, "caption_style": "classic"}
        imported_override = {"end": 2436, "caption_style": "classic", "zoom_level": "wide"}
        clip_overrides.replace_all(source, {"1": manual_override, "2": imported_override})
        before = self.client.get("/api/sermons/sample.mp4/clips").json()["clips"]
        self.assertEqual(before[0]["why_selected"], old_ai["rationale"])
        self.assertEqual(before[0]["hook"], old_ai["hook_rationale"])
        self.assertEqual(before[0]["score"], old_ai["hook_score"])
        self.assertEqual(before[1]["id"], manual["id"])
        self.assertEqual(before[2]["description"], "A neutral summary.")

        for number, ai_count in ((2, 2), (3, 1)):
            clip_selection.write_clips({"source": source, "clips_version": f"version-{number}",
                "clips": [{"title": f"New AI {number}-{i}", "start": 50 + i,
                           "end": 60 + i, "rationale": "New suggestion"}
                          for i in range(ai_count)]})
            stored = json.loads(self.path.read_text(encoding="utf-8"))["clips"]
            self.assertEqual([clip["title"] for clip in stored],
                             [f"New AI {number}-{i}" for i in range(ai_count)] +
                             ["Manual sample", "Imported sample"])
            self.assertEqual(stored[ai_count], manual)
            self.assertEqual(stored[ai_count + 1], imported)
            self.assertEqual(clip_overrides.load_overrides(source),
                             {str(ai_count): manual_override, str(ai_count + 1): imported_override})
            self.assertEqual(len({clip["id"] for clip in stored}), len(stored))
        listed = self.client.get("/api/sermons/sample.mp4/clips").json()["clips"]
        self.assertEqual(listed[1]["user_edits"], manual_override)
        self.assertEqual(listed[2]["user_edits"], imported_override)


if __name__ == "__main__":
    unittest.main()
