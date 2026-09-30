"""Human text corrections layered over an immutable Whisper transcript.

The sidecar contains only edits. Original word timing slots are retained;
words inserted into one slot appear together until a later alignment pass.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import tempfile
import threading
import uuid
from pathlib import Path


_write_lock = threading.Lock()
MAX_WORDS_PER_EDIT = 12


class EditError(ValueError):
    pass


def edits_path_for(transcript_path: Path) -> Path:
    return transcript_path.with_name("transcript_edits.json")


def _read_sidecar(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("edits"), list):
            raise ValueError("invalid sidecar format")
        return data["edits"]
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise EditError("transcript edits sidecar is malformed") from exc


def _raw_word_ref(segment: dict, index: int, count: int) -> list[dict]:
    words = segment.get("words", [])
    if count < 1 or count > MAX_WORDS_PER_EDIT or index < 0 or index + count > len(words):
        raise EditError("word range is out of bounds")
    return [{"word": w["word"], "start": w["start"], "end": w["end"]}
            for w in words[index:index + count]]


def _locate(raw: dict, edit: dict) -> tuple[dict, int, int]:
    if not isinstance(edit, dict):
        raise EditError("invalid edit")
    matches = [s for s in raw.get("segments", []) if s.get("id") == edit.get("segment_id")]
    if len(matches) != 1:
        raise EditError("segment reference is stale or ambiguous")
    index = edit.get("word_index")
    original = edit.get("original_words")
    if not isinstance(index, int) or isinstance(index, bool) or not isinstance(original, list):
        raise EditError("invalid word reference")
    actual = _raw_word_ref(matches[0], index, len(original))
    if actual != original:
        raise EditError("original words or timestamps no longer match")
    return matches[0], index, len(original)


def _replacement_slots(text: str, count: int) -> list[str]:
    if not isinstance(text, str):
        raise EditError("replacement must be text")
    tokens = text.split()
    if not tokens or "\n" in text or "\r" in text or len(text) > 500:
        raise EditError("replacement must be nonempty single-line text under 500 characters")
    if count == 1:
        return [" ".join(tokens)]
    if len(tokens) >= count:
        return tokens[:count - 1] + [" ".join(tokens[count - 1:])]
    if len(tokens) == 1:
        return [tokens[0]] + [""] * (count - 1)
    return tokens[:-1] + [""] * (count - len(tokens)) + [tokens[-1]]


def _validated_edits(raw: dict, edits: list[dict]) -> tuple[list[dict], list[str]]:
    valid: list[dict] = []
    errors: list[str] = []
    occupied: set[tuple[object, int]] = set()
    seen_ids: set[str] = set()
    for edit in edits:
        try:
            _, index, count = _locate(raw, edit)
            _replacement_slots(edit.get("corrected_text", ""), count)
            edit_id = edit.get("id")
            if not isinstance(edit_id, str) or not edit_id or edit_id in seen_ids:
                raise EditError("duplicate or invalid correction ID")
            if edit.get("original_text") != " ".join(w["word"] for w in edit["original_words"]):
                raise EditError("original text reference is stale")
            if edit.get("affected_start") != edit["original_words"][0]["start"] or \
                    edit.get("affected_end") != edit["original_words"][-1]["end"]:
                raise EditError("affected time range is stale")
            slots = {(edit["segment_id"], i) for i in range(index, index + count)}
            if occupied & slots:
                raise EditError("edit overlaps another correction")
            seen_ids.add(edit_id)
            occupied.update(slots)
            valid.append(edit)
        except (EditError, TypeError, KeyError) as exc:
            errors.append(str(exc))
    return valid, errors


def load_effective_transcript(transcript_path: Path) -> tuple[dict, list[dict], list[str]]:
    """Return (effective transcript, valid edits, warnings) without writing raw data."""
    raw = json.loads(transcript_path.read_text(encoding="utf-8"))
    try:
        edits = _read_sidecar(edits_path_for(transcript_path))
    except EditError as exc:
        return raw, [], [str(exc)]
    valid, warnings = _validated_edits(raw, edits)
    if not valid:
        return raw, [], warnings
    # JSON round trip ensures nested words and segment text in the raw object
    # remain untouched while downstream consumers receive the edited copy.
    effective = json.loads(json.dumps(raw))
    by_id = {s["id"]: s for s in effective.get("segments", [])}
    for edit in valid:
        seg = by_id[edit["segment_id"]]
        index = edit["word_index"]
        slots = _replacement_slots(edit["corrected_text"], len(edit["original_words"]))
        for offset, text in enumerate(slots):
            seg["words"][index + offset]["word"] = text
    changed_ids = {edit["segment_id"] for edit in valid}
    for seg in effective.get("segments", []):
        if seg["id"] not in changed_ids:
            continue
        seg["text"] = " ".join(w["word"] for w in seg.get("words", []) if w["word"])
    return effective, valid, warnings


def _atomic_write(path: Path, edits: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                         prefix=".transcript-edits-", delete=False) as handle:
            temp_name = handle.name
            json.dump({"version": 1, "edits": edits}, handle, indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def save_edit(transcript_path: Path, segment_id: int, word_index: int,
              original_words: list[dict], corrected_text: str, edit_id: str | None = None) -> dict:
    with _write_lock:
        raw = json.loads(transcript_path.read_text(encoding="utf-8"))
        path = edits_path_for(transcript_path)
        edits = _read_sidecar(path)
        _, errors = _validated_edits(raw, edits)
        if errors:
            raise EditError("existing transcript edits require review")
        existing = next((e for e in edits if e.get("id") == edit_id), None) if edit_id else None
        if edit_id and existing is None:
            raise EditError("correction not found")
        if not isinstance(original_words, list) or not all(isinstance(w, dict) for w in original_words):
            raise EditError("invalid original words")
        proposed = {
            "id": edit_id or uuid.uuid4().hex,
            "segment_id": segment_id,
            "word_index": word_index,
            "original_words": original_words,
            "original_text": " ".join(w.get("word", "") for w in original_words),
            "corrected_text": corrected_text.strip(),
            "edited_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "affected_start": original_words[0]["start"] if original_words else None,
            "affected_end": original_words[-1]["end"] if original_words else None,
            "timing_needs_alignment": True,
        }
        _locate(raw, proposed)
        _replacement_slots(proposed["corrected_text"], len(original_words))
        updated = [e for e in edits if e.get("id") != edit_id] + [proposed]
        _, errors = _validated_edits(raw, updated)
        if errors:
            raise EditError(errors[0])
        _atomic_write(path, updated)
        return proposed


def delete_edit(transcript_path: Path, edit_id: str) -> bool:
    with _write_lock:
        path = edits_path_for(transcript_path)
        edits = _read_sidecar(path)
        updated = [edit for edit in edits if edit.get("id") != edit_id]
        if len(updated) == len(edits):
            return False
        _atomic_write(path, updated)
        return True
