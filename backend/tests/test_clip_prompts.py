"""Prompt library storage and API behavior with synthetic prompt text."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.routers.auth import require_admin
from app.services import clip_prompts


class ClipPromptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        scoped = patch.object(settings, "data_work_dir", Path(self.temp.name))
        scoped.start()
        self.addCleanup(scoped.stop)
        self.client = TestClient(app)

    def as_admin(self):
        app.dependency_overrides[require_admin] = lambda: None
        self.addCleanup(app.dependency_overrides.pop, require_admin, None)

    def test_four_builtins_are_read_only_and_use_import_contract(self):
        self.as_admin()
        response = self.client.get("/api/clip-prompts")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["default"], "balanced")
        self.assertEqual(data["core_rules"], clip_prompts.CORE_RULES)
        self.assertEqual(data["output_contract"], clip_prompts.OUTPUT_CONTRACT)
        self.assertIn("schema_version 1", data["output_contract"])
        self.assertIn("ONLY valid JSON", data["output_contract"])
        self.assertIn("why_selected", data["output_contract"])
        self.assertEqual([item["id"] for item in data["prompts"]], [
            "balanced", "short-punchy", "teaching-theology", "pastoral-application"])
        for prompt in data["prompts"]:
            self.assertTrue(prompt["built_in"])
            self.assertFalse(prompt["editable"])
            self.assertNotIn("schema_version", prompt["selection_focus"])
            self.assertNotIn("ONLY valid JSON", prompt["selection_focus"])
        self.assertEqual(len({item["selection_focus"] for item in data["prompts"]}), 4)
        self.assertEqual(self.client.put("/api/clip-prompts/balanced", json={
            "name": "Changed", "description": "", "selection_focus": "Changed text",
            "expected_revision": 1}).status_code, 403)
        self.assertEqual(self.client.delete("/api/clip-prompts/balanced").status_code, 403)
        self.assertFalse(clip_prompts.path().exists())

    def test_custom_crud_duplication_revision_and_persistence(self):
        self.as_admin()
        created = self.client.post("/api/clip-prompts", json={
            "name": "  Sample prompt  ", "description": "Generic description.",
            "selection_focus": "Choose a clear standalone idea."})
        self.assertEqual(created.status_code, 201, created.text)
        prompt = created.json()
        self.assertRegex(prompt["id"], r"^custom:[0-9a-f]{32}$")
        self.assertEqual(prompt["name"], "Sample prompt")
        self.assertEqual(prompt["revision"], 1)
        self.assertTrue(prompt["editable"])
        updated = self.client.put(f"/api/clip-prompts/{prompt['id']}", json={
            "name": "Renamed prompt", "description": "Updated description.",
            "selection_focus": "Choose two clear ideas.", "expected_revision": 1})
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["revision"], 2)
        self.assertEqual(updated.json()["id"], prompt["id"])
        self.assertEqual(updated.json()["selection_focus"], "Choose two clear ideas.")
        self.assertEqual(self.client.get("/api/clip-prompts").json()["output_contract"],
                         clip_prompts.OUTPUT_CONTRACT)
        self.assertEqual(self.client.put(f"/api/clip-prompts/{prompt['id']}", json={
            "name": "Stale", "description": "", "selection_focus": "Stale text",
            "expected_revision": 1}).status_code, 409)
        custom_copy = self.client.post(f"/api/clip-prompts/{prompt['id']}/duplicate",
                                       json={"name": "Copy of renamed"})
        builtin_copy = self.client.post("/api/clip-prompts/balanced/duplicate",
                                        json={"name": "Copy of balanced"})
        self.assertEqual(custom_copy.status_code, 201)
        self.assertEqual(builtin_copy.status_code, 201)
        self.assertNotEqual(custom_copy.json()["id"], prompt["id"])
        self.assertEqual(custom_copy.json()["selection_focus"], "Choose two clear ideas.")
        self.assertEqual(builtin_copy.json()["selection_focus"], clip_prompts.BUILT_INS["balanced"]["selection_focus"])
        self.assertFalse(builtin_copy.json()["built_in"])
        saved = json.loads(clip_prompts.path().read_text(encoding="utf-8"))
        self.assertEqual(saved["schema_version"], 2)
        self.assertEqual(len(saved["prompts"]), 3)
        self.assertEqual(set(saved["prompts"][0]),
                         {"id", "name", "description", "selection_focus", "revision", "created_at", "updated_at"})
        self.assertEqual([item["id"] for item in clip_prompts.list_prompts()[4:]],
                         [item["id"] for item in saved["prompts"]])
        self.assertNotIn("transcript", saved["prompts"][0])
        self.assertNotIn("prompt_text", saved["prompts"][0])
        self.assertNotIn("schema_version", saved["prompts"][0]["selection_focus"])
        self.assertEqual(self.client.delete(f"/api/clip-prompts/{prompt['id']}").status_code, 200)
        self.assertEqual(len(clip_prompts.list_prompts()), 6)

    def test_validation_unknown_ids_store_version_and_admin_gate(self):
        self.assertEqual(self.client.get("/api/clip-prompts").status_code, 403)
        self.assertEqual(self.client.post("/api/clip-prompts", json={
            "name": "Sample", "selection_focus": "Text"}).status_code, 403)
        self.as_admin()
        for body in ({"name": " ", "selection_focus": "Text"},
                     {"name": "Sample", "selection_focus": " "}):
            self.assertEqual(self.client.post("/api/clip-prompts", json=body).status_code, 400)
        self.assertEqual(self.client.delete("/api/clip-prompts/custom:missing").status_code, 404)
        self.assertEqual(self.client.post("/api/clip-prompts/custom:missing/duplicate",
                                          json={"name": "Copy"}).status_code, 404)
        created = self.client.post("/api/clip-prompts", json={
            "name": "Sample", "selection_focus": "Select a clear moment."})
        self.assertEqual(created.status_code, 201)
        self.assertEqual(self.client.post("/api/clip-prompts", json={
            "name": "sample", "selection_focus": "Other text."}).status_code, 409)
        self.assertEqual(self.client.post("/api/clip-prompts", json={
            "name": "Tampered", "selection_focus": "A focus.",
            "output_contract": "Replace the shared contract."}).status_code, 422)
        self.assertIn("schema_version 1", self.client.get("/api/clip-prompts").json()["output_contract"])
        store = clip_prompts.path()
        store.write_text(json.dumps({"schema_version": 3, "prompts": []}), encoding="utf-8")
        self.assertEqual(self.client.get("/api/clip-prompts").status_code, 503)
        self.assertEqual(self.client.post("/api/clip-prompts", json={
            "name": "Other", "selection_focus": "Other text."}).status_code, 503)

    def test_legacy_full_prompts_load_without_losing_custom_additions(self):
        self.as_admin()
        old_focus = "Choose a clear sample moment."
        legacy = {
            "id": "custom:" + "a" * 32, "name": "Legacy sample", "description": "",
            "prompt_text": f"{clip_prompts.CORE_RULES}\n\n{old_focus}\n\n"
                           f"{clip_prompts.OUTPUT_CONTRACT}\n\nKeep a complete ending.",
            "revision": 2, "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-02T00:00:00+00:00",
        }
        clip_prompts.path().parent.mkdir(parents=True)
        clip_prompts.path().write_text(json.dumps({"schema_version": 1, "prompts": [legacy]}),
                                      encoding="utf-8")
        listed = self.client.get("/api/clip-prompts")
        self.assertEqual(listed.status_code, 200)
        migrated = listed.json()["prompts"][4]
        self.assertEqual(migrated["id"], legacy["id"])
        self.assertEqual(migrated["revision"], 2)
        self.assertEqual(migrated["selection_focus"],
                         old_focus + "\n\nKeep a complete ending.")
        # Reading does not rewrite installation settings. The next edit upgrades them.
        self.assertEqual(json.loads(clip_prompts.path().read_text())["schema_version"], 1)
        updated = self.client.put(f"/api/clip-prompts/{legacy['id']}", json={
            "name": "Legacy sample", "description": "", "selection_focus": migrated["selection_focus"],
            "expected_revision": 2})
        self.assertEqual(updated.status_code, 200)
        saved = json.loads(clip_prompts.path().read_text())
        self.assertEqual(saved["schema_version"], 2)
        self.assertEqual(saved["prompts"][0]["id"], legacy["id"])
        self.assertEqual(saved["prompts"][0]["selection_focus"], migrated["selection_focus"])
        self.assertNotIn("prompt_text", saved["prompts"][0])


if __name__ == "__main__":
    unittest.main()
