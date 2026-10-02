"""Canonical clip fields for old and current clips.json records."""

from __future__ import annotations

import uuid


def normalize_for_display(clip: dict, source: str, version: str | None, index: int) -> None:
    """Add canonical fields to a response without rewriting legacy storage."""
    if not clip.get("id"):
        key = f"{source}:{version or 'legacy'}:{index}:{clip.get('title')}:{clip.get('start')}:{clip.get('end')}"
        clip["id"] = uuid.uuid5(uuid.NAMESPACE_URL, key).hex
    if not clip.get("origin"):
        clip["origin"] = ("manual" if set(clip) - {"id"} == {"title", "start", "end"}
                          else "ai")
    for canonical, legacy in (("why_selected", "rationale"),
                              ("hook", "hook_rationale"), ("score", "hook_score")):
        if canonical not in clip and legacy in clip:
            clip[canonical] = clip[legacy]
