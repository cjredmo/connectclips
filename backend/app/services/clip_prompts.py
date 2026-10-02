"""Built-in and installation-local prompts for external clip-selection chats."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import tempfile
import threading
import uuid
from pathlib import Path

from app.config import settings

STORE_VERSION = 2
DEFAULT_ID = "balanced"
_lock = threading.RLock()
_custom_id = re.compile(r"custom:[0-9a-f]{32}\Z")

OUTPUT_CONTRACT = """Return ONLY valid JSON compatible with ConnectClips schema_version 1. Do not use Markdown code fences or add commentary before or after the JSON. Use this shape:
{
  "schema_version": 1,
  "clips": [
    {
      "title": "...",
      "start": "MM:SS.mmm",
      "end": "MM:SS.mmm",
      "description": "...",
      "why_selected": "...",
      "hook": "...",
      "score": 85
    }
  ]
}
Include title, start, and end for every clip. Also provide a neutral description of what the passage contains, why_selected explaining why it stands alone, a concise account of its opening in hook, and a 0–100 suitability score. Use only timestamps supplied by the transcript and preserve them accurately. Clip boundaries should correspond to the supplied timestamps; avoid beginning or ending mid-thought when possible. Do not invent speech or wording absent from the transcript. Return only the JSON object."""

CORE_RULES = """Analyze the timestamped sermon transcript below and identify strong standalone social-video clips. Preserve the speaker's meaning and choose excerpts that a viewer can understand without earlier sermon context. Favor complete thoughts with natural openings and endings. Do not rewrite or fabricate sermon content."""


def _built_in(key: str, name: str, description: str, focus: str) -> dict:
    return {"id": key, "name": name, "description": description,
            "selection_focus": focus,
            "built_in": True, "editable": False, "revision": None}


BUILT_INS = {
    item["id"]: item for item in (
        _built_in("balanced", "Balanced Clips", "A broad mix of memorable, complete ideas.",
                  "Balance clear teaching, memorable statements, practical application, pastoral moments, and other passages that work well as self-contained social clips. Prefer the strongest overall moments rather than forcing a particular category."),
        _built_in("short-punchy", "Short & Punchy", "Concise clips with immediate openings.",
                  "Prioritize concise passages with immediate openings, memorable language, and a complete idea that can work in a shorter social-video format. Avoid clips that require lengthy setup to make sense."),
        _built_in("teaching-theology", "Teaching / Theology", "Clear explanations and biblical connections.",
                  "Prioritize explanations of Scripture, doctrine, theological concepts, and connections between biblical passages. Choose moments where the speaker develops a teachable idea clearly from premise to conclusion. Preserve necessary context and avoid isolated claims that would misrepresent the explanation."),
        _built_in("pastoral-application", "Pastoral / Application", "Encouragement and lived application.",
                  "Prioritize moments of encouragement, conviction, comfort, practical application, pastoral counsel, and emotionally resonant exhortation. Choose passages that connect biblical truth clearly to the listener's life while still standing alone without prior sermon context."),
    )
}


class PromptStoreError(ValueError):
    pass


class PromptConflict(PromptStoreError):
    pass


class PromptReadOnly(PromptStoreError):
    pass


class PromptNotFound(PromptStoreError):
    pass


def path() -> Path:
    return settings.data_work_dir / "_settings" / "clip_prompts.json"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _clean_name(name: str) -> str:
    if not isinstance(name, str):
        raise ValueError("prompt name must be text")
    name = name.strip()
    if not name or len(name) > 80 or any(ord(char) < 32 for char in name):
        raise ValueError("prompt name must be 1–80 printable characters")
    return name


def _clean_description(description: str) -> str:
    if not isinstance(description, str):
        raise ValueError("description must be text")
    description = description.strip()
    if len(description) > 240 or any(ord(char) < 32 for char in description):
        raise ValueError("description must be at most 240 printable characters")
    return description


def _clean_text(selection_focus: str) -> str:
    if not isinstance(selection_focus, str) or not selection_focus.strip():
        raise ValueError("selection instructions are required")
    if len(selection_focus) > 20000 or any(
            ord(char) < 32 and char not in "\n\r\t" for char in selection_focus):
        raise ValueError("selection instructions must be at most 20,000 characters")
    return selection_focus


def _legacy_focus(prompt_text: str) -> str:
    """Remove known Phase B wrapper sections, retaining every custom addition."""
    focus = prompt_text
    if focus.startswith(CORE_RULES + "\n\n"):
        focus = focus[len(CORE_RULES) + 2:]
    if OUTPUT_CONTRACT in focus:
        before, _, after = focus.partition(OUTPUT_CONTRACT)
        focus = "\n\n".join(part for part in (before.strip(), after.strip()) if part)
    return _clean_text(focus)


def _validate_record(record: object) -> dict:
    if not isinstance(record, dict) or not _custom_id.fullmatch(str(record.get("id", ""))):
        raise PromptStoreError("custom prompt storage is invalid")
    try:
        if (set(record) != {"id", "name", "description", "selection_focus", "revision",
                            "created_at", "updated_at"} or
                record["name"] != _clean_name(record["name"]) or
                record["description"] != _clean_description(record["description"]) or
                _clean_text(record["selection_focus"]) != record["selection_focus"] or
                type(record["revision"]) is not int or record["revision"] < 1 or
                not isinstance(record["created_at"], str) or
                not isinstance(record["updated_at"], str)):
            raise PromptStoreError("custom prompt storage is invalid")
    except (KeyError, TypeError, ValueError) as exc:
        raise PromptStoreError("custom prompt storage is invalid") from exc
    return record


def _load() -> list[dict]:
    store = path()
    if not store.exists():
        return []
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise PromptStoreError("custom prompt storage cannot be read") from exc
    if (not isinstance(data, dict) or set(data) != {"schema_version", "prompts"} or
            type(data["schema_version"]) is not int or data["schema_version"] not in (1, STORE_VERSION) or
            not isinstance(data["prompts"], list)):
        raise PromptStoreError("unsupported custom prompt storage")
    records = []
    for original in data["prompts"]:
        if data["schema_version"] == 1:
            if not isinstance(original, dict) or "prompt_text" not in original:
                raise PromptStoreError("custom prompt storage is invalid")
            try:
                original = {**original, "selection_focus": _legacy_focus(original["prompt_text"])}
            except ValueError as exc:
                raise PromptStoreError("custom prompt storage is invalid") from exc
            del original["prompt_text"]
        records.append(_validate_record(original))
    ids = [record["id"] for record in records]
    if len(set(ids)) != len(ids):
        raise PromptStoreError("duplicate custom prompt IDs")
    return records


def _write(records: list[dict]) -> None:
    store = path()
    store.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=store.parent, encoding="utf-8",
                                         prefix=".clip-prompts-", delete=False) as handle:
            temporary = handle.name
            json.dump({"schema_version": STORE_VERSION, "prompts": records}, handle,
                      indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, store)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def _public(record: dict) -> dict:
    return {**record, "built_in": False, "editable": True}


def list_prompts() -> list[dict]:
    return list(BUILT_INS.values()) + [_public(record) for record in _load()]


def _find(records: list[dict], prompt_id: str) -> dict:
    if prompt_id in BUILT_INS:
        raise PromptReadOnly("built-in prompts are read-only")
    record = next((item for item in records if item["id"] == prompt_id), None)
    if record is None:
        raise PromptNotFound(f"unknown prompt: {prompt_id}")
    return record


def _unique_name(records: list[dict], name: str, exclude: str | None = None) -> None:
    if any(record["id"] != exclude and record["name"].casefold() == name.casefold()
           for record in records):
        raise PromptConflict("a custom prompt with this name already exists")


def create(name: str, description: str, selection_focus: str) -> dict:
    name = _clean_name(name)
    description = _clean_description(description)
    selection_focus = _clean_text(selection_focus)
    with _lock:
        records = _load()
        _unique_name(records, name)
        now = _now()
        record = {"id": f"custom:{uuid.uuid4().hex}", "name": name,
                  "description": description, "selection_focus": selection_focus,
                  "revision": 1, "created_at": now, "updated_at": now}
        records.append(record)
        _write(records)
        return _public(record)


def update(prompt_id: str, name: str, description: str, selection_focus: str,
           expected_revision: int) -> dict:
    name = _clean_name(name)
    description = _clean_description(description)
    selection_focus = _clean_text(selection_focus)
    with _lock:
        records = _load()
        record = _find(records, prompt_id)
        if type(expected_revision) is not int or record["revision"] != expected_revision:
            raise PromptConflict("prompt changed; reload before saving")
        _unique_name(records, name, exclude=prompt_id)
        record.update(name=name, description=description, selection_focus=selection_focus,
                      revision=record["revision"] + 1, updated_at=_now())
        _write(records)
        return _public(record)


def duplicate(prompt_id: str, name: str) -> dict:
    if prompt_id in BUILT_INS:
        source = BUILT_INS[prompt_id]
    else:
        source = _find(_load(), prompt_id)
    return create(name, source["description"], source["selection_focus"])


def delete(prompt_id: str) -> None:
    with _lock:
        records = _load()
        record = _find(records, prompt_id)
        records.remove(record)
        _write(records)
