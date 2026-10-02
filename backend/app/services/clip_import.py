"""Validate and append version 1 clip-interchange JSON to the shared clip list."""

from __future__ import annotations

import datetime as dt
import json
import math
import re
import uuid
from pathlib import Path
from typing import Any

from app.services import clip_metadata, clip_selection

_TIME = re.compile(r"^(?:(\d+):)?(\d+):([0-5]\d)(?:\.(\d{1,3}))?$")
_SECONDS = re.compile(r"^\d+(?:\.\d{1,3})?$")
_FIELDS = {"title", "start", "end", "description", "why_selected", "hook", "score"}
_TEXT_LIMITS = {"title": 200, "description": 2000, "why_selected": 2000, "hook": 1000}


class ClipImportError(ValueError):
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


def _seconds(value: Any) -> float:
    if isinstance(value, bool):
        raise ValueError("must be a timestamp or finite number of seconds")
    if isinstance(value, (int, float)):
        seconds = float(value)
    elif isinstance(value, str):
        stripped = value.strip()
        if _SECONDS.fullmatch(stripped):
            seconds = float(stripped)
        else:
            match = _TIME.fullmatch(stripped)
            if not match:
                raise ValueError("must use seconds, MM:SS[.mmm], or HH:MM:SS[.mmm]")
            hours, minutes, seconds_part, fraction = match.groups()
            if hours is None:
                seconds = int(minutes) * 60 + int(seconds_part)
            else:
                if int(minutes) >= 60:
                    raise ValueError("minutes must be below 60")
                seconds = int(hours) * 3600 + int(minutes) * 60 + int(seconds_part)
            if fraction:
                seconds += int(fraction) / (10 ** len(fraction))
    else:
        raise ValueError("must be a timestamp or finite number of seconds")
    if not math.isfinite(seconds):
        raise ValueError("must be finite")
    return seconds


def _duration(transcript_path: Path) -> float | None:
    try:
        transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ClipImportError(["Transcript is unavailable"]) from exc
    value = transcript.get("duration")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        return float(value)
    return None


def validate(document: Any, transcript_path: Path) -> list[dict]:
    if not isinstance(document, dict):
        raise ClipImportError(["Import must be a JSON object"])
    errors = []
    if type(document.get("schema_version")) is not int or document["schema_version"] != 1:
        errors.append("schema_version must be 1")
    extra = set(document) - {"schema_version", "clips"}
    if extra:
        errors.append(f"Unknown top-level fields: {', '.join(sorted(extra))}")
    clips = document.get("clips")
    if not isinstance(clips, list) or not clips:
        errors.append("clips must be a nonempty array")
    if errors:
        raise ClipImportError(errors)
    duration = _duration(transcript_path)
    valid = []
    for index, item in enumerate(clips):
        prefix = f"clip {index + 1}"
        if not isinstance(item, dict):
            errors.append(f"{prefix}: must be an object")
            continue
        if isinstance(item.get("title"), str) and item["title"].strip():
            prefix += f" ({item['title'].strip()[:60]})"
        unknown = set(item) - _FIELDS
        if unknown:
            errors.append(f"{prefix}: unknown fields: {', '.join(sorted(unknown))}")
        clean = {}
        for field, limit in _TEXT_LIMITS.items():
            if field not in item and field != "title":
                continue
            value = item.get(field)
            if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
                errors.append(f"{prefix}: {field} must be 1–{limit} characters")
            else:
                clean[field] = value.strip()
        for field in ("start", "end"):
            try:
                clean[field] = _seconds(item.get(field))
            except ValueError as exc:
                errors.append(f"{prefix}: {field} {exc}")
        if "start" in clean and "end" in clean:
            if clean["start"] < 0:
                errors.append(f"{prefix}: start must be zero or later")
            if clean["end"] <= clean["start"]:
                errors.append(f"{prefix}: end must be after start")
            if duration is not None and clean["end"] > duration:
                errors.append(f"{prefix}: end exceeds sermon duration")
        if "score" in item:
            score = item["score"]
            if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 100:
                errors.append(f"{prefix}: score must be a finite number from 0 to 100")
            else:
                clean["score"] = score
        valid.append(clean)
    if errors:
        raise ClipImportError(errors)
    return valid


def _identity(clip: dict) -> tuple[str, float, float]:
    return (" ".join(clip["title"].split()).casefold(),
            round(float(clip["start"]), 3), round(float(clip["end"]), 3))


def import_clips(source_name: str, transcript_path: Path, document: Any,
                 provenance: Any = None) -> dict:
    candidates = validate(document, transcript_path)
    if provenance is None:
        context = {"selection_method": "json_import",
                   "selection_batch_id": uuid.uuid4().hex,
                   "selection_created_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    else:
        try:
            context = clip_metadata.ai_chat_provenance(source_name, provenance)
        except ValueError as exc:
            raise ClipImportError([str(exc)]) from exc
    path = clip_selection.clips_path_for(source_name)
    with clip_selection.clips_lock:
        if path.exists():
            try:
                collection = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise ClipImportError(["Existing clip list is invalid"]) from exc
            if (not isinstance(collection, dict) or collection.get("source") != source_name or
                    not isinstance(collection.get("clips"), list) or
                    any(not isinstance(clip, dict) or not isinstance(clip.get("title"), str) or
                        any(isinstance(clip.get(key), bool) or
                            not isinstance(clip.get(key), (int, float)) or
                            not math.isfinite(clip[key]) for key in ("start", "end"))
                        for clip in collection["clips"])):
                raise ClipImportError(["Existing clip list is invalid"])
        else:
            collection = {"source": source_name, "clips_version": uuid.uuid4().hex,
                          "created_at": dt.datetime.now(dt.timezone.utc).isoformat(), "clips": []}
        identities = {_identity(clip) for clip in collection["clips"]}
        indices = []
        duplicates = 0
        for candidate in candidates:
            identity = _identity(candidate)
            if identity in identities:
                duplicates += 1
                continue
            identities.add(identity)
            indices.append(len(collection["clips"]))
            collection["clips"].append({"id": uuid.uuid4().hex, "origin": "json_import",
                                        **context, **candidate})
        if indices:
            clip_selection.write_json_atomic(path, collection)
    return {"imported": len(indices), "duplicates_skipped": duplicates, "indices": indices}
