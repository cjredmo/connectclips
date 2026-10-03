"""Date metadata and one-frame thumbnail caching with synthetic source files."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.routers.auth import require_admin
from app.services import clip_selection, clip_thumbnails, sermon_meta


class ClipLibraryMediaTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for field, path in (("data_sources_dir", root / "sources"),
                            ("data_work_dir", root / "work"),
                            ("data_clips_dir", root / "exports")):
            scope = patch.object(settings, field, path)
            scope.start()
            self.addCleanup(scope.stop)
        self.source = settings.data_sources_dir / "sample.mp4"
        self.source.parent.mkdir()
        self.source.write_bytes(b"synthetic video placeholder")
        app.dependency_overrides[require_admin] = lambda: None
        self.addCleanup(app.dependency_overrides.pop, require_admin, None)
        self.client = TestClient(app)

    def test_optional_date_and_partial_meta_updates(self):
        response = self.client.get("/api/sermons/sample.mp4/meta")
        self.assertIsNone(response.json()["sermon_date"])
        self.assertIsNone(self.client.get("/api/sermons").json()[0]["sermon_date"])
        saved = self.client.put("/api/sermons/sample.mp4/meta",
                                json={"sermon_date": "2026-02-03"})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["sermon_date"], "2026-02-03")
        self.assertEqual(self.client.get("/api/sermons").json()[0]["sermon_date"], "2026-02-03")
        self.client.put("/api/sermons/sample.mp4/meta", json={"program_video_url": None})
        self.assertEqual(sermon_meta.load("sample.mp4")["sermon_date"], "2026-02-03")
        for date in ("2026-02-30", "20260203", "bad-date"):
            self.assertEqual(self.client.put("/api/sermons/sample.mp4/meta",
                                             json={"sermon_date": date}).status_code, 400)
        self.assertEqual(sermon_meta.load("sample.mp4")["sermon_date"], "2026-02-03")
        self.client.put("/api/sermons/sample.mp4/meta", json={"sermon_date": None})
        self.assertEqual(sermon_meta.load("sample.mp4"), {})

    def test_thumbnail_key_changes_with_trim_clip_and_source(self):
        original = clip_thumbnails.cache_path(self.source, 2, "clip-a", 10, 20)
        self.assertNotEqual(original, clip_thumbnails.cache_path(self.source, 2, "clip-a", 11, 20))
        self.assertNotEqual(original, clip_thumbnails.cache_path(self.source, 2, "clip-b", 10, 20))
        self.assertNotEqual(original, clip_thumbnails.cache_path(self.source, 3, "clip-a", 10, 20))
        self.source.write_bytes(b"changed synthetic source")
        self.assertNotEqual(original, clip_thumbnails.cache_path(self.source, 2, "clip-a", 10, 20))

    def test_thumbnail_extracts_once_and_reuses_cache(self):
        calls = []
        def fake_run(command, **_kwargs):
            calls.append(command)
            Path(command[-1]).write_bytes(b"synthetic image")
            return type("Result", (), {"returncode": 0})()
        with patch.object(clip_thumbnails.subprocess, "run", side_effect=fake_run):
            first = clip_thumbnails.thumbnail(self.source, 0, "clip-a", 10, 20)
            second = clip_thumbnails.thumbnail(self.source, 0, "clip-a", 10, 20)
        self.assertEqual(first, second)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][calls[0].index("-ss") + 1], "15.000")
        self.assertEqual(calls[0][calls[0].index("-frames:v") + 1], "1")

    def test_failed_thumbnail_extraction_leaves_no_cached_image(self):
        with patch.object(clip_thumbnails.subprocess, "run",
                          return_value=type("Result", (), {"returncode": 1})()):
            with self.assertRaises(RuntimeError):
                clip_thumbnails.thumbnail(self.source, 0, "clip-a", 10, 20)
        self.assertFalse(clip_thumbnails.cache_path(self.source, 0, "clip-a", 10, 20).exists())

    def test_thumbnail_route_uses_effective_trim_and_rejects_missing_clip(self):
        clips_path = clip_selection.clips_path_for(self.source.name)
        clips_path.parent.mkdir(parents=True)
        clips_path.write_text(json.dumps({"source": self.source.name,
            "clips": [{"id": "clip-a", "title": "Sample", "start": 10, "end": 20}]}))
        overrides = clips_path.parent / "clip_overrides.json"
        overrides.write_text(json.dumps({"0": {"start": 12, "end": 18}}))
        image = clips_path.parent / "sample.jpg"
        image.write_bytes(b"synthetic image")
        with patch.object(clip_thumbnails, "thumbnail", return_value=image) as extract:
            response = self.client.get("/api/sermons/sample.mp4/clips/0/thumbnail.jpg")
            missing = self.client.get("/api/sermons/sample.mp4/clips/1/thumbnail.jpg")
        self.assertEqual(response.status_code, 200)
        extract.assert_called_once_with(self.source, 0, "clip-a", 12.0, 18.0)
        self.assertEqual(missing.status_code, 404)


if __name__ == "__main__":
    unittest.main()
