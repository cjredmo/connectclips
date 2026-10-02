"""Custom caption persistence and export checks with synthetic fixtures."""

import asyncio
import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.routers.auth import require_admin
from app.services import caption_styles, captions, clip_overrides, jobs


class CustomStyleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.work_patch = patch.object(settings, "data_work_dir", self.root / "work")
        self.source_patch = patch.object(settings, "data_sources_dir", self.root / "sources")
        self.work_patch.start()
        self.source_patch.start()
        self.addCleanup(self.work_patch.stop)
        self.addCleanup(self.source_patch.stop)
        self.addCleanup(self.temp.cleanup)
        self.base = captions.get_style("classic").descriptor()

    def test_crud_revision_reload_and_immutable_builtins(self):
        self.assertEqual(len(caption_styles.list_styles()), 5)
        made = caption_styles.create("Sample", self.base)
        style_id = made["key"]
        self.assertRegex(style_id, r"^custom:[0-9a-f]{32}$")
        self.assertEqual(made["revision"], 1)
        self.assertFalse(made["built_in"])
        self.assertEqual(made["preview_highlight_color"], None)
        revised = caption_styles.update(style_id, "Renamed", {
            **made, "highlight_color": "#123456"}, 1)
        self.assertEqual(revised["key"], style_id)
        self.assertEqual(revised["revision"], 2)
        self.assertEqual(caption_styles.resolve(style_id)[0].highlight_color, "#123456")
        with self.assertRaises(caption_styles.StyleConflict):
            caption_styles.update(style_id, "Stale", revised, 1)
        copy_builtin = caption_styles.duplicate("classic", "Builtin copy")
        copy_custom = caption_styles.duplicate(style_id, "Custom copy")
        self.assertNotEqual(copy_builtin["key"], copy_custom["key"])
        self.assertEqual(copy_custom["highlight_color"], "#123456")
        self.assertEqual(len(caption_styles.list_styles()), 8)
        with self.assertRaisesRegex(ValueError, "read-only"):
            caption_styles.delete("classic")
        with self.assertRaisesRegex(ValueError, "read-only"):
            caption_styles.update("classic", "Bad", self.base, 1)
        caption_styles.delete(copy_custom["key"])
        self.assertEqual(len(caption_styles.list_styles()), 7)
        with self.assertRaisesRegex(ValueError, "unknown caption style"):
            caption_styles.resolve(copy_custom["key"])

    def test_safe_delete_reference_and_unknown_override(self):
        made = caption_styles.create("Sample", self.base)
        untouched = caption_styles.create("Untouched", self.base)
        self.assertEqual(caption_styles.reference_counts(made["key"], "sample.mp4", 0),
                         {"current_clip": False, "other_clips": 0})
        clip_overrides.save_override("sample.mp4", 0, {"caption_style": made["key"]})
        self.assertEqual(caption_styles.reference_counts(made["key"], "sample.mp4", 0),
                         {"current_clip": True, "other_clips": 0})
        with self.assertRaisesRegex(caption_styles.StyleConflict, "still selected"):
            caption_styles.delete(made["key"])
        clip_overrides.save_override("other.mp4", 1, {"caption_style": made["key"]})
        self.assertEqual(caption_styles.reference_counts(made["key"], "sample.mp4", 0),
                         {"current_clip": True, "other_clips": 1})
        with self.assertRaisesRegex(ValueError, "unknown caption style"):
            clip_overrides.save_override("sample.mp4", 0, {"caption_style": "custom:missing"})
        clip_overrides.save_override("sample.mp4", 0, {"caption_style": "classic"})
        self.assertEqual(caption_styles.reference_counts(made["key"], "sample.mp4", 0),
                         {"current_clip": False, "other_clips": 1})
        with self.assertRaises(caption_styles.StyleConflict):
            caption_styles.delete(made["key"])
        clip_overrides.save_override("other.mp4", 1, {"caption_style": "classic"})
        caption_styles.delete(made["key"])
        self.assertEqual(caption_styles.resolve(untouched["key"])[0].key, untouched["key"])
        with self.assertRaisesRegex(ValueError, "read-only"):
            caption_styles.reference_counts("classic", "sample.mp4", 0)

    def test_validation_malformed_store_and_atomic_write(self):
        for key, bad in (("primary_color", "red"), ("background_opacity", 1.5),
                         ("font_size", 0), ("max_words_per_chunk", 21),
                         ("presentation_mode", "invalid"), ("font_name", "Unknown")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                caption_styles.create("Bad", {**self.base, key: bad})
        with patch.object(caption_styles.os, "replace", wraps=os.replace) as atomic:
            caption_styles.create("Sample", self.base)
            atomic.assert_called_once()
        stored = caption_styles.path()
        self.assertEqual(json.loads(stored.read_text())["schema_version"], 1)
        stored.write_text("{bad", encoding="utf-8")
        with self.assertRaises(caption_styles.StyleStoreError):
            caption_styles.list_styles()

    def test_background_persistence_validation_and_legacy_storage(self):
        for mode in ("speech", "linger", "clip"):
            with self.subTest(mode=mode):
                made = caption_styles.create("Sample", {**self.base,
                    "background_persistence": mode, "background_linger_seconds": 1.4})
                self.assertEqual(caption_styles.resolve(made["key"])[0].background_persistence,
                                 mode)
                duplicate = caption_styles.duplicate(made["key"], "Copy")
                self.assertEqual(duplicate["background_persistence"], mode)
                self.assertEqual(duplicate["background_linger_seconds"], 1.4)
                updated = caption_styles.update(made["key"], "Edited", made, 1)
                self.assertEqual(updated["background_persistence"], mode)
        for value in ("invalid", None, [], 3):
            with self.subTest(invalid_mode=value), self.assertRaises(ValueError):
                caption_styles.create("Bad", {**self.base,
                    "background_persistence": value})
        for value in (-.1, 10.1, float("nan"), float("inf"), "1", True):
            with self.subTest(invalid_linger=value), self.assertRaises(ValueError):
                caption_styles.create("Bad", {**self.base,
                    "background_linger_seconds": value})
        made = caption_styles.create("Old", self.base)
        store = caption_styles.path()
        data = json.loads(store.read_text(encoding="utf-8"))
        old = next(record for record in data["styles"] if record["id"] == made["key"])
        old["descriptor"].pop("background_persistence")
        old["descriptor"].pop("background_linger_seconds")
        store.write_text(json.dumps(data), encoding="utf-8")
        before = store.read_bytes()
        listed = next(style for style in caption_styles.list_styles()
                      if style["key"] == made["key"])
        self.assertEqual(listed["background_persistence"], "speech")
        self.assertEqual(listed["background_linger_seconds"], 1.0)
        self.assertEqual(caption_styles.resolve(made["key"])[0].background_persistence,
                         "speech")
        self.assertEqual(store.read_bytes(), before)

    def test_modes_ass_and_snapshot_provenance(self):
        words = [captions.Word("This", 0, .25), captions.Word("is", .3, .5),
                 captions.Word("sample.", .6, .8)]
        full = caption_styles.create("Full", {**self.base,
            "presentation_mode": "full_chunk_highlight", "max_words_per_chunk": 3,
            "background_box": True, "background_opacity": .5})
        style, snap = caption_styles.snapshot(full["key"])
        self.assertEqual(snap["revision"], 1)
        self.assertEqual(len(snap["hash"]), 64)
        self.assertEqual([len(c) for c in captions.chunk_words(words, style)], [3])
        ass = captions.generate_ass(words, style=style, clip_duration=1.5)
        events = [line for line in ass.splitlines() if line.startswith("Dialogue: 1,")]
        self.assertEqual(len(events), 3)
        self.assertNotIn(r"\alpha&HFF&", "\n".join(events))
        self.assertIn("0:00:01.50", events[-1])
        self.assertIn(r"\1a&H7F&", ass)
        progressive = captions.generate_ass(words, style="classic")
        self.assertIn(r"\alpha&HFF&", progressive)
        single = replace(style, presentation_mode="single_word", max_words_per_chunk=9)
        self.assertEqual(single.max_words_per_chunk, 1)
        self.assertEqual(len(captions.chunk_words(words, single)), 3)
        with self.assertRaisesRegex(ValueError, "unknown caption style"):
            caption_styles.snapshot("custom:missing")
        with self.assertRaisesRegex(ValueError, "unknown caption style"):
            caption_styles.snapshot("")
        self.assertEqual(caption_styles.snapshot(None)[1]["id"], "classic")

    def test_export_job_keeps_revision_and_frozen_descriptor(self):
        style = caption_styles.create("Sample", self.base)
        source = settings.data_sources_dir / "sample.mp4"
        source.parent.mkdir(parents=True)
        source.touch()
        clip_file = settings.data_work_dir / "sample" / "clips.json"
        clip_file.parent.mkdir(parents=True)
        clip_file.write_text(json.dumps({"clips_version": "abcd1234", "clips": [
            {"start": 1, "end": 3, "title": "Synthetic"}]}), encoding="utf-8")
        captured = []
        def capture(coro):
            captured.append(coro)
            coro.close()
        with patch.object(jobs, "_new_job", side_effect=lambda **values: jobs.Job(
                id="synthetic", kind="export_clip", **{k: v for k, v in values.items()
                                               if k not in {"kind", "user_login", "user_name"}})), \
                patch.object(asyncio, "create_task", side_effect=capture):
            job = jobs.create_export_clip_job("sample.mp4", 0, caption_style=style["key"])
        self.assertEqual(job.caption_style_id, style["key"])
        self.assertEqual(job.caption_style_revision, 1)
        self.assertEqual(job.caption_style_hash,
                         caption_styles.snapshot(style["key"])[1]["hash"])
        self.assertEqual(json.loads(job.caption_style_descriptor)["key"], style["key"])
        caption_styles.update(style["key"], "Renamed", style, 1)
        self.assertEqual(job.caption_style_revision, 1)
        self.assertEqual(job.caption_style_name, "Sample")
        self.assertEqual(len(captured), 1)

    def test_http_crud_and_clear_validation_errors(self):
        app.dependency_overrides[require_admin] = lambda: None
        self.addCleanup(app.dependency_overrides.pop, require_admin, None)
        client = TestClient(app)
        response = client.post("/api/caption-styles", json={"name": "Sample",
            "descriptor": self.base})
        self.assertEqual(response.status_code, 201)
        style_id = response.json()["key"]
        self.assertEqual(client.get("/api/caption-styles").json()["styles"][-1]["key"], style_id)
        invalid = client.post("/api/caption-styles", json={"name": "Bad",
            "descriptor": {**self.base, "primary_color": "red"}})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(client.put("/api/caption-styles/classic", json={"name": "Bad",
            "descriptor": self.base, "expected_revision": 1}).status_code, 403)
        self.assertEqual(client.delete("/api/caption-styles/custom:missing").status_code, 404)
        clip_overrides.save_override("sample.mp4", 0, {"caption_style": style_id})
        references = client.get(f"/api/caption-styles/{style_id}/references",
                                params={"source": "sample.mp4", "clip_index": 0})
        self.assertEqual(references.status_code, 200)
        self.assertEqual(references.json(), {"current_clip": True, "other_clips": 0})
        self.assertEqual(client.delete(f"/api/caption-styles/{style_id}").status_code, 409)


if __name__ == "__main__":
    unittest.main()
