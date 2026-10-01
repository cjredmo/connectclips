"""Accepted audio retranscription spans layered over an immutable transcript.

Only replacement segments and audit metadata are persisted. Failed attempts
remain diagnostic records and never become part of the effective transcript.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from pathlib import Path

from app.services.transcript_quality import analyze_transcript


_write_lock = threading.Lock()


class RepairError(ValueError):
    pass


def repairs_path_for(transcript_path: Path) -> Path:
    return transcript_path.with_name("transcript_repairs.json")


def raw_digest(transcript_path: Path) -> str:
    return hashlib.sha256(transcript_path.read_bytes()).hexdigest()


def _empty(digest: str) -> dict:
    return {"version": 1, "raw_sha256": digest, "repairs": [], "attempts": []}


def read_sidecar(transcript_path: Path) -> dict:
    path = repairs_path_for(transcript_path)
    digest = raw_digest(transcript_path)
    if not path.exists():
        return _empty(digest)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(data, dict) or data.get("version") != 1 or
                not isinstance(data.get("repairs"), list) or
                not isinstance(data.get("attempts"), list)):
            raise ValueError("invalid repair sidecar schema")
    except (OSError, ValueError) as exc:
        raise RepairError("repair sidecar is malformed") from exc
    if data.get("raw_sha256") != digest:
        raise RepairError("repair sidecar references a different raw transcript")
    return data


def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                         prefix=".transcript-repairs-", delete=False) as handle:
            temp_name = handle.name
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def _validate_record(record: dict, duration: float) -> None:
    if not isinstance(record, dict) or record.get("status") != "accepted":
        raise RepairError("invalid accepted repair")
    start, end = record.get("replace_start"), record.get("replace_end")
    if (not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or
            not 0 <= start < end <= duration + 0.01):
        raise RepairError("invalid repair range")
    segments = record.get("replacement_segments")
    if not isinstance(segments, list) or not segments:
        raise RepairError("accepted repair has no replacement segments")
    previous_end = start
    seen_ids: set[str] = set()
    for seg in segments:
        if not isinstance(seg, dict) or not isinstance(seg.get("id"), str) or seg["id"] in seen_ids:
            raise RepairError("invalid repair segment ID")
        seen_ids.add(seg["id"])
        if not start <= seg.get("start", -1) <= seg.get("end", -1) <= end + 0.001:
            raise RepairError("repair segment leaves owned source range")
        if seg["start"] < previous_end - 0.06:
            raise RepairError("repair segments are not chronological")
        previous_end = seg["end"]
        words = seg.get("words")
        if not isinstance(words, list) or not words:
            raise RepairError("repair segment has no words")
        previous_word_start = start
        for word in words:
            if (not isinstance(word, dict) or not isinstance(word.get("word"), str) or
                    not word["word"].strip() or
                    not seg["start"] - 0.001 <= word.get("start", -1) <=
                    word.get("end", -1) <= seg["end"] + 0.001 or
                    word["start"] < previous_word_start - 0.001):
                raise RepairError("invalid repair word timing")
            previous_word_start = word["start"]
        if seg.get("text") != " ".join(word["word"] for word in words):
            raise RepairError("repair segment text does not match its words")


def apply_records(raw: dict, records: list[dict]) -> dict:
    """Build a replacement view; raw is never modified."""
    duration = float(raw.get("duration") or float("inf"))
    ordered = sorted(records, key=lambda r: r["replace_start"])
    previous_end = -1.0
    for record in ordered:
        _validate_record(record, duration)
        if record["replace_start"] < previous_end:
            raise RepairError("accepted repairs overlap")
        previous_end = record["replace_end"]
        for original in raw.get("segments", []):
            if (original["start"] < record["replace_start"] < original["end"] - 0.001 or
                    original["start"] + 0.001 < record["replace_end"] < original["end"]):
                raise RepairError("repair splice would cut an original segment")
    effective = json.loads(json.dumps(raw))
    segments = effective.get("segments", [])
    for record in ordered:
        start, end = record["replace_start"], record["replace_end"]
        segments = [s for s in segments if s["end"] <= start or s["start"] >= end]
        segments.extend(json.loads(json.dumps(record["replacement_segments"])))
    segments.sort(key=lambda s: (s["start"], s["end"]))
    effective["segments"] = segments
    return effective


def load_repaired_base(transcript_path: Path, raw: dict) -> tuple[dict, list[dict], list[str]]:
    try:
        data = read_sidecar(transcript_path)
        base = apply_records(raw, data["repairs"])
        return base, data["repairs"], []
    except (RepairError, TypeError, KeyError) as exc:
        return raw, [], [str(exc)]


def edit_conflicts(transcript_path: Path, start: float, end: float) -> list[str]:
    """Conservatively block a repair that would displace a human correction."""
    from app.services.transcript_edits import EditError, _read_sidecar, edits_path_for
    try:
        edits = _read_sidecar(edits_path_for(transcript_path))
    except EditError as exc:
        raise RepairError(str(exc)) from exc
    conflicts = []
    for edit in edits:
        if not isinstance(edit, dict):
            raise RepairError("human correction sidecar requires review")
        first, last = edit.get("affected_start"), edit.get("affected_end")
        if not isinstance(first, (int, float)) or not isinstance(last, (int, float)):
            raise RepairError("human correction range requires review")
        if (first < end and last > start) or (first == last and start <= first < end):
            conflicts.append(str(edit.get("id", "unknown")))
    return conflicts


def record_attempt(transcript_path: Path, attempt: dict, accepted: dict | None = None) -> None:
    """Append diagnostics; activate a candidate only after caller validation."""
    with _write_lock:
        data = read_sidecar(transcript_path)
        if accepted is not None:
            validation = accepted.get("validation")
            if not isinstance(validation, dict) or validation.get("accepted") is not True:
                raise RepairError("repair candidate did not pass validation")
            raw = json.loads(transcript_path.read_text(encoding="utf-8"))
            proposed = [r for r in data["repairs"] if
                        r["replace_end"] <= accepted["replace_start"] or
                        r["replace_start"] >= accepted["replace_end"]]
            proposed.append(accepted)
            apply_records(raw, proposed)
            conflicts = edit_conflicts(transcript_path, accepted["replace_start"], accepted["replace_end"])
            if conflicts:
                raise RepairError("repair overlaps existing human corrections")
            data["repairs"] = sorted(proposed, key=lambda r: r["replace_start"])
        data["attempts"].append(attempt)
        _atomic_write(repairs_path_for(transcript_path), data)


def transcript_status(transcript_path: Path) -> dict:
    from app.services.transcript_edits import load_effective_transcript
    raw = json.loads(transcript_path.read_text(encoding="utf-8"))
    raw_quality = analyze_transcript(raw)
    effective, _, warnings = load_effective_transcript(transcript_path)
    effective_quality = analyze_transcript(effective)
    try:
        data = read_sidecar(transcript_path)
        repairs = data["repairs"]
        last = data["attempts"][-1] if data["attempts"] else None
        repair_status = last["status"] if last else ("accepted" if repairs else "none")
        failure_reason = last.get("failure_reason") if last and last["status"] != "accepted" else None
        recent_attempts = [{"status": a.get("status"), "backend": a.get("backend"),
                            "failure_reason": a.get("failure_reason")}
                           for a in data["attempts"][-3:]]
    except RepairError:
        repairs, repair_status = [], "requires_review"
        failure_reason = "repair sidecar requires review"
        recent_attempts = []
    return {
        "raw_quality": raw_quality,
        "effective_quality": effective_quality,
        "repair_exists": bool(repairs),
        "repair_status": repair_status,
        "repair_failure_reason": failure_reason,
        "recent_repair_attempts": recent_attempts,
        "repaired_ranges": [{"start": r["replace_start"], "end": r["replace_end"],
                             "backend": r["backend"], "model": r["model"]} for r in repairs],
        "human_review_required": effective_quality["status"] == "failed" or bool(warnings),
        "warnings": warnings,
    }
