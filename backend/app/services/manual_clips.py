"""Add a user-selected range to the existing per-sermon clip list."""

from __future__ import annotations

import datetime as dt
import json
import math
import uuid
from pathlib import Path

from app.services import clip_selection

def create(source_name: str, transcript_path: Path, title: str,
           start: float, end: float) -> tuple[int, dict]:
    """Append a clip without changing AI clip records or transcript data."""
    if not isinstance(title, str) or not title.strip() or len(title.strip()) > 200:
        raise ValueError("title must be 1–200 characters")
    title = title.strip()
    if (isinstance(start, bool) or isinstance(end, bool) or
            not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or
            not math.isfinite(start) or not math.isfinite(end)):
        raise ValueError("start and end must be finite seconds")
    if start < 0:
        raise ValueError("start time must be zero or later")
    if end <= start:
        raise ValueError("end time must be after start time")
    try:
        transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("transcript is unavailable") from exc
    duration = transcript.get("duration")
    if isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0:
        if end > duration:
            raise ValueError("end time exceeds sermon duration")

    path = clip_selection.clips_path_for(source_name)
    clip = {"id": uuid.uuid4().hex, "origin": "manual", "selection_method": "manual",
            "title": title, "start": float(start), "end": float(end)}
    with clip_selection.clips_lock:
        if path.exists():
            try:
                collection = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise ValueError("existing clip list is invalid") from exc
            if (not isinstance(collection, dict) or
                    collection.get("source") != source_name or
                    not isinstance(collection.get("clips"), list)):
                raise ValueError("existing clip list is invalid")
        else:
            collection = {
                "source": source_name,
                "clips_version": uuid.uuid4().hex,
                "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "clips": [],
            }
        index = len(collection["clips"])
        collection["clips"].append(clip)
        clip_selection.write_json_atomic(path, collection)
    return index, clip
