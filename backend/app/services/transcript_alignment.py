"""Optional forced-alignment timings layered over the effective transcript.

The transcript remains the authority for words. This sidecar can change only
display timings, and stale or untrusted entries fall back to effective timing.
"""

from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
import math
import os
import tempfile
from pathlib import Path

from app.services.transcript_edits import load_effective_transcript

SCHEMA_VERSION = 1
CONTEXT_SECONDS = 6.0
MIN_ALIGNED_DURATION = 0.02
MAX_ALIGNED_DURATION = 2.0
_DURATION_FLOAT_TOLERANCE = 1e-9


def valid_aligned_duration(start: float, end: float) -> bool:
    """Check duration without rejecting millisecond values for float roundoff."""
    duration = end - start
    return (MIN_ALIGNED_DURATION - _DURATION_FLOAT_TOLERANCE <= duration <=
            MAX_ALIGNED_DURATION + _DURATION_FLOAT_TOLERANCE)


class AlignmentError(ValueError):
    pass


def path_for(transcript_path: Path) -> Path:
    return transcript_path.with_name("alignment.json")


def word_key(segment_id: int | str, index: int) -> str:
    return json.dumps([segment_id, index], separators=(",", ":"), ensure_ascii=False)


def flatten(transcript: dict) -> list[dict]:
    return [
        {"key": word_key(segment["id"], index), "text": word["word"],
         "start": float(word["start"]), "end": float(word["end"])}
        for segment in transcript.get("segments", [])
        for index, word in enumerate(segment.get("words", [])) if word["word"].strip()
    ]


def fingerprint(transcript: dict) -> str:
    payload = {"source": transcript.get("source"), "duration": transcript.get("duration"),
               "words": [(w["key"], w["text"]) for w in flatten(transcript)]}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def read(transcript_path: Path) -> dict | None:
    path = path_for(transcript_path)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AlignmentError("alignment sidecar is malformed") from exc
    if (not isinstance(data, dict) or data.get("version") != SCHEMA_VERSION or
            not isinstance(data.get("effective_fingerprint"), str) or
            not isinstance(data.get("words"), list) or
            not isinstance(data.get("ranges"), list) or
            not isinstance(data.get("failed_windows", []), list) or
            not isinstance(data.get("chronology_errors", []), list) or
            any(not isinstance(item, list) or len(item) != 2 or
                not all(isinstance(value, (int, float)) and math.isfinite(value)
                        for value in item) or item[0] >= item[1]
                for item in data["ranges"])):
        raise AlignmentError("unsupported alignment sidecar schema")
    keys = set()
    for entry in data["words"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("key"), str) or \
                entry["key"] in keys or not isinstance(entry.get("text"), str) or \
                entry.get("status") not in ("aligned", "fallback"):
            raise AlignmentError("alignment sidecar has invalid or duplicate words")
        keys.add(entry["key"])
        start, end = entry.get("start"), entry.get("end")
        if (not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or
                not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start):
            raise AlignmentError("alignment sidecar has invalid source timings")
        if entry["status"] == "aligned":
            aligned_start, aligned_end = entry.get("aligned_start"), entry.get("aligned_end")
            score = entry.get("score")
            if (not isinstance(aligned_start, (int, float)) or
                    not isinstance(aligned_end, (int, float)) or
                    not math.isfinite(aligned_start) or not math.isfinite(aligned_end) or
                    aligned_start < 0 or not valid_aligned_duration(
                        aligned_start, aligned_end) or
                    (score is not None and (not isinstance(score, (int, float)) or
                                            not math.isfinite(score) or score < 0.10))):
                raise AlignmentError("alignment sidecar has invalid aligned timings")
        elif "aligned_start" in entry or "aligned_end" in entry:
            raise AlignmentError("fallback word contains aligned timings")
    return data


def validation_errors(effective: dict, data: dict, *, full_range: bool = True) -> list[str]:
    """Reject structural corruption; fallback coverage is not an error."""
    current = flatten(effective)
    saved = data.get("words", [])
    errors = []
    if data.get("version") != SCHEMA_VERSION or not isinstance(saved, list):
        return ["unsupported alignment candidate schema"]
    ranges = data.get("ranges")
    if not isinstance(ranges, list) or any(
            not isinstance(item, (list, tuple)) or len(item) != 2 or
            not all(isinstance(value, (int, float)) and math.isfinite(value)
                    for value in item) or item[0] >= item[1] for item in ranges):
        return ["invalid alignment ranges"]
    if (not isinstance(data.get("failed_windows", []), list) or
            not isinstance(data.get("chronology_errors", []), list)):
        return ["invalid alignment diagnostics"]
    if len(saved) != len(current) or any(
            not isinstance(entry, dict) or
            (entry.get("key"), entry.get("text"), entry.get("start"), entry.get("end")) !=
            (word["key"], word["text"], word["start"], word["end"])
            for entry, word in zip(saved, current)):
        errors.append("alignment words differ from the effective transcript")
    if data.get("effective_fingerprint") != fingerprint(effective):
        errors.append("effective transcript fingerprint changed")
    duration = float(effective.get("duration", 0))
    if full_range and not any(a <= 0.01 and b >= duration - 0.01
                              for a, b in ranges):
        errors.append("alignment does not cover the full sermon")
    if data.get("failed_windows"):
        errors.append("alignment windows failed")
    if data.get("chronology_errors"):
        errors.append("alignment has unresolved chronology errors")
    if current and not any(entry.get("status") == "aligned" for entry in saved
                           if isinstance(entry, dict)):
        errors.append("alignment has no aligned words")
    previous = None
    keys = set()
    for entry in saved:
        if not isinstance(entry, dict):
            errors.append("alignment contains invalid word entries")
            break
        key = entry.get("key")
        if (not isinstance(key, str) or key in keys or
                entry.get("status") not in ("aligned", "fallback")):
            errors.append("alignment contains invalid or duplicate word entries")
            break
        keys.add(key)
        if entry["status"] == "fallback" and ("aligned_start" in entry or "aligned_end" in entry):
            errors.append("fallback word contains aligned timings")
            break
        if entry["status"] == "aligned" and (
                "aligned_start" not in entry or "aligned_end" not in entry):
            errors.append("aligned word is missing timings")
            break
        score = entry.get("score")
        if entry["status"] == "aligned" and score is not None and (
                not isinstance(score, (int, float)) or not math.isfinite(score) or score < 0.10):
            errors.append("alignment contains invalid confidence score")
            break
        start = entry.get("aligned_start", entry.get("start"))
        end = entry.get("aligned_end", entry.get("end"))
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or \
                not math.isfinite(start) or not math.isfinite(end) or start < 0 or \
                end < start or end > duration + 0.01:
            errors.append("alignment contains invalid display timings")
            break
        if entry.get("status") == "aligned" and not valid_aligned_duration(start, end):
            errors.append("alignment contains invalid word duration")
            break
        if previous and (start < previous[0] or end < previous[1] or
                         start < previous[1] - 0.06):
            errors.append("alignment contains a chronology conflict")
            break
        previous = (start, end)
    return errors


def write(transcript_path: Path, data: dict) -> None:
    if data.get("version") != SCHEMA_VERSION or not isinstance(data.get("words"), list):
        raise AlignmentError("invalid alignment candidate")
    effective, _, warnings = load_effective_transcript(transcript_path)
    if warnings or validation_errors(effective, data):
        raise AlignmentError("alignment candidate failed structural validation")
    path = path_for(transcript_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=path.parent, encoding="utf-8",
                                         prefix=".alignment-", delete=False) as handle:
            temp_name = handle.name
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def _usable_entries(effective: dict, data: dict) -> tuple[dict[str, dict], list[tuple[float, float]]]:
    current = {w["key"]: w for w in flatten(effective)}
    saved = {w.get("key"): w for w in data["words"] if isinstance(w, dict)}
    changed = [w for key, w in current.items() if key in saved and saved[key].get("text") != w["text"]]
    changed.extend(w for key, w in current.items() if key not in saved and
                   any(a <= w["start"] < b for a, b in data["ranges"]))
    changed.extend(w for key, w in saved.items() if key not in current and
                   isinstance(w.get("start"), (int, float)))
    stale_ranges = [(max(0.0, w["start"] - CONTEXT_SECONDS),
                     w["end"] + CONTEXT_SECONDS) for w in changed]
    usable = {}
    for key, entry in saved.items():
        word = current.get(key)
        if (word is None or entry.get("text") != word["text"] or
                entry.get("status") != "aligned"):
            continue
        start, end = entry.get("aligned_start"), entry.get("aligned_end")
        if (not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or
                not math.isfinite(start) or not math.isfinite(end) or end <= start or
                any(a <= word["start"] < b for a, b in stale_ranges)):
            continue
        usable[key] = entry
    return usable, stale_ranges


def status(transcript_path: Path) -> dict:
    effective, _, warnings = load_effective_transcript(transcript_path)
    words = flatten(effective)
    try:
        data = read(transcript_path)
    except AlignmentError as exc:
        return {"status": "failed", "acceptable": False, "aligned_words": 0,
                "total_words": len(words), "fallback_words": len(words),
                "stale_ranges": [], "diagnostics": [str(exc)]}
    if data is None:
        return {"status": "not_aligned", "acceptable": False, "aligned_words": 0,
                "total_words": len(words), "fallback_words": len(words),
                "stale_ranges": [], "diagnostics": []}
    same = data["effective_fingerprint"] == fingerprint(effective)
    if same:
        errors = validation_errors(effective, data)
        if errors or warnings:
            return {"status": "failed", "acceptable": False, "aligned_words": 0,
                    "total_words": len(words), "fallback_words": len(words),
                    "stale_ranges": [], "diagnostics": errors + warnings}
    usable, stale_ranges = _usable_entries(effective, data)
    aligned = len(usable)
    acceptable = same and not warnings and not stale_ranges and aligned > 0
    state = "stale" if not same else ("aligned" if aligned == len(words) else "partially_aligned")
    return {"status": state, "acceptable": acceptable, "aligned_words": aligned,
            "total_words": len(words), "fallback_words": len(words) - aligned,
            "coverage_percent": round(100 * aligned / len(words), 2) if words else 0.0,
            "stale_ranges": stale_ranges, "diagnostics": data.get("diagnostics", [])}


def load_display_transcript(transcript_path: Path) -> dict:
    """One timing source for preview and ASS, retaining authoritative text."""
    effective, _, _ = load_effective_transcript(transcript_path)
    try:
        data = read(transcript_path)
    except AlignmentError:
        data = None
    if data is None:
        return effective
    if data["effective_fingerprint"] == fingerprint(effective) and \
            validation_errors(effective, data):
        return effective
    usable, _ = _usable_entries(effective, data)
    display = copy.deepcopy(effective)
    for segment in display.get("segments", []):
        for index, word in enumerate(segment.get("words", [])):
            entry = usable.get(word_key(segment["id"], index))
            if entry:
                word["start"] = entry["aligned_start"]
                word["end"] = entry["aligned_end"]
        timed = [w for w in segment.get("words", []) if w["word"].strip()]
        if timed:
            segment["start"] = min(w["start"] for w in timed)
            segment["end"] = max(w["end"] for w in timed)
    return display


def new_candidate(effective: dict, *, model: str, ranges: list[tuple[float, float]],
                  words: list[dict], diagnostics: list[str], failed_windows: list[int]) -> dict:
    return {"version": SCHEMA_VERSION, "effective_fingerprint": fingerprint(effective),
            "backend": "whisperx", "model": model,
            "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "ranges": ranges, "words": words, "diagnostics": diagnostics,
            "failed_windows": failed_windows}
