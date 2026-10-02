"""Canonical clip fields for old and current clips.json records."""

from __future__ import annotations

import datetime as dt
import re
import uuid

from app.services import clip_prompts


SELECTION_FIELDS = ("selection_method", "selection_batch_id", "selection_prompt_id",
                    "selection_prompt_name", "selection_prompt_revision", "selection_created_at")
SELECTION_METHODS = {"ai_chat", "claude_api", "json_import", "manual"}
_CUSTOM_PROMPT_ID = re.compile(r"custom:[0-9a-f]{32}\Z")
SCRIPTURE_REFERENCE_MAX_LENGTH = 120


def clean_scripture_reference(value: object) -> str | None:
    """Normalize optional display text without inferring a reference."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("scripture_reference must be a string or null")
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > SCRIPTURE_REFERENCE_MAX_LENGTH or not all(c.isprintable() for c in cleaned):
        raise ValueError(f"scripture_reference must be at most {SCRIPTURE_REFERENCE_MAX_LENGTH} printable characters")
    return cleaned


def ai_chat_provenance(source: str, value: object) -> dict:
    """Validate ConnectClips-owned import context, separate from AI-returned JSON."""
    expected = {"source", *SELECTION_FIELDS}
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError("invalid AI Chat provenance fields")
    if value["source"] != source or value["selection_method"] != "ai_chat":
        raise ValueError("AI Chat provenance does not match this sermon or method")
    try:
        batch = uuid.UUID(value["selection_batch_id"])
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError("invalid selection batch ID") from exc
    if batch.version != 4 or value["selection_batch_id"] != batch.hex:
        raise ValueError("invalid selection batch ID")
    prompt_id = value["selection_prompt_id"]
    if not isinstance(prompt_id, str) or not (
            prompt_id in clip_prompts.BUILT_INS or _CUSTOM_PROMPT_ID.fullmatch(prompt_id)):
        raise ValueError("invalid selection prompt ID")
    name = value["selection_prompt_name"]
    if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 80 or
            name != name.strip() or any(not char.isprintable() for char in name)):
        raise ValueError("invalid selection prompt name")
    revision = value["selection_prompt_revision"]
    if revision is not None and (type(revision) is not int or revision < 1):
        raise ValueError("invalid selection prompt revision")
    created_at = value["selection_created_at"]
    if not isinstance(created_at, str):
        raise ValueError("invalid selection timestamp")
    try:
        parsed = dt.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("invalid selection timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("selection timestamp needs a timezone")
    return {key: value[key] for key in SELECTION_FIELDS}


def normalize_for_display(clip: dict, source: str, version: str | None, index: int) -> None:
    """Add canonical fields to a response without rewriting legacy storage."""
    stored_origin = clip.get("origin")
    if not clip.get("id"):
        key = f"{source}:{version or 'legacy'}:{index}:{clip.get('title')}:{clip.get('start')}:{clip.get('end')}"
        clip["id"] = uuid.uuid5(uuid.NAMESPACE_URL, key).hex
    if not clip.get("origin"):
        clip["origin"] = ("manual" if set(clip) - {"id"} == {"title", "start", "end"}
                          else "ai")
    if clip.get("selection_method") not in SELECTION_METHODS:
        # Only these origins establish a historical method with confidence.
        clip["selection_method"] = ("manual" if clip["origin"] == "manual" else
                                    "claude_api" if stored_origin == "ai" else None)
    for key in SELECTION_FIELDS[1:]:
        clip.setdefault(key, None)
    try:
        clip["scripture_reference"] = clean_scripture_reference(clip.get("scripture_reference"))
    except ValueError:
        clip["scripture_reference"] = None
    for canonical, legacy in (("why_selected", "rationale"),
                              ("hook", "hook_rationale"), ("score", "hook_score")):
        if canonical not in clip and legacy in clip:
            clip[canonical] = clip[legacy]
