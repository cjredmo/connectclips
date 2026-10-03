"""Clip-local ASR and alignment artifacts; never mutates sermon transcripts."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from app.config import settings
from app.services import alignment_runner, captions, clip_metadata, clip_overrides
from app.services import clip_selection, transcribe, transcript_alignment, transcript_edits, transcript_quality


SCHEMA_VERSION = 1
ProgressCB = Callable[[str, float], None]


class PrecisionError(ValueError):
    pass


def artifact_path(source_name: str, clip_id: str) -> Path:
    if Path(source_name).name != source_name or source_name in ("", ".", "..") or not clip_id:
        raise PrecisionError("invalid clip identity")
    # Hashing keeps arbitrary legacy IDs out of filenames and avoids traversal.
    digest = hashlib.sha256(clip_id.encode("utf-8")).hexdigest()
    return settings.data_work_dir / Path(source_name).stem / "clip_precision" / f"{digest}.json"


def source_identity(source: Path) -> dict:
    stat = source.stat()
    return {"name": source.name, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
            "device": stat.st_dev, "inode": stat.st_ino}


def padded_range(start: float, end: float, duration: float | None) -> tuple[float, float]:
    if not all(math.isfinite(value) for value in (start, end)) or start < 0 or end <= start:
        raise PrecisionError("invalid clip range")
    if duration is not None and duration > 0 and end > duration + 0.01:
        raise PrecisionError("clip exceeds source duration")
    padding = settings.clip_preparation_padding_seconds
    if not math.isfinite(padding) or padding < 0:
        raise PrecisionError("invalid clip preparation padding")
    return max(0.0, start - padding), (min(duration, end + padding)
                                          if duration and duration > 0 else end + padding)


def current_clip(source_name: str, clip_id: str) -> tuple[int, float, float]:
    path = clip_selection.clips_path_for(source_name)
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("source") != source_name or not isinstance(data.get("clips"), list):
        raise PrecisionError("clip list is invalid")
    overrides = clip_overrides.load_overrides(source_name)
    for index, stored in enumerate(data["clips"]):
        clip = dict(stored)
        clip_metadata.normalize_for_display(clip, source_name, data.get("clips_version"), index)
        if clip["id"] != clip_id:
            continue
        override = overrides.get(str(index), {})
        start = float(override.get("start", clip["start"]))
        end = float(override.get("end", clip["end"]))
        if not 0 <= start < end:
            raise PrecisionError("clip range is invalid")
        return index, start, end
    raise PrecisionError("clip no longer exists")


def _words_in(effective: dict, start: float, end: float) -> list[dict]:
    return [{"key": word["key"], "text": word["text"],
             "start": word["start"], "end": word["end"]}
            for word in transcript_alignment.flatten(effective)
            if word["start"] < end and word["end"] > start]


def _snapshot_in(saved: list[dict], start: float, end: float) -> list[dict]:
    return [word for word in saved if word["start"] < end and word["end"] > start]


def _human_edit_overlaps(edits: list[dict], start: float, end: float) -> bool:
    return any(edit["affected_start"] < end and edit["affected_end"] > start
               for edit in edits)


def read_artifact(source_name: str, clip_id: str) -> dict | None:
    path = artifact_path(source_name, clip_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(data, dict) or data.get("version") != SCHEMA_VERSION or
                data.get("clip_id") != clip_id or data.get("source_name") != source_name or
                not isinstance(data.get("source_identity"), dict) or
                not isinstance(data.get("effective_fingerprint"), str) or
                not isinstance(data.get("effective_words"), list) or
                not isinstance(data.get("segments"), list) or
                not isinstance(data.get("words"), list)):
            raise ValueError("invalid clip precision schema")
        start, end = data["padded_start"], data["padded_end"]
        if not all(isinstance(value, (int, float)) and math.isfinite(value)
                   for value in (start, end)) or not 0 <= start < end:
            raise ValueError("invalid prepared coverage")
        clip_start, clip_end = data["clip_start"], data["clip_end"]
        if (not all(isinstance(value, (int, float)) and math.isfinite(value)
                    for value in (clip_start, clip_end)) or
                not start <= clip_start < clip_end <= end):
            raise ValueError("invalid prepared clip range")
        for word in data["effective_words"]:
            if (not isinstance(word, dict) or not isinstance(word.get("key"), str) or
                    not isinstance(word.get("text"), str) or
                    not all(isinstance(word.get(field), (int, float)) and
                            math.isfinite(word[field]) for field in ("start", "end")) or
                    word["end"] <= word["start"]):
                raise ValueError("invalid effective transcript snapshot")
        previous = None
        for word in data["words"]:
            if not isinstance(word, dict):
                raise ValueError("invalid prepared word")
            a, b = word["start"], word["end"]
            if (not isinstance(word.get("word"), str) or not word["word"].strip() or
                    not all(isinstance(value, (int, float)) and math.isfinite(value)
                            for value in (a, b)) or a < start - 0.01 or b > end + 0.01 or
                    b <= a or (previous is not None and a < previous - 0.06)):
                raise ValueError("invalid prepared word timing")
            previous = b
        if not data["words"] or not data["segments"]:
            raise ValueError("empty prepared transcript")
        if any(not isinstance(segment, dict) or not isinstance(segment.get("words"), list) or
               not isinstance(segment.get("start"), (int, float)) or
               not isinstance(segment.get("end"), (int, float)) or
               not math.isfinite(segment["start"]) or
               not math.isfinite(segment["end"]) or
               segment["end"] < segment["start"] or
               not isinstance(segment.get("text"), str)
               for segment in data["segments"]):
            raise ValueError("invalid prepared segment")
        flattened = [word for segment in data["segments"] for word in segment["words"]]
        if flattened != data["words"]:
            raise ValueError("prepared words differ from segments")
        return data
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise PrecisionError("clip precision artifact is invalid") from exc


def assess(source_name: str, clip_id: str, start: float, end: float,
           transcript_path: Path | None = None) -> dict:
    """A source of truth shared by scheduling, preview, export, and status."""
    try:
        current_clip(source_name, clip_id)
    except (OSError, ValueError, KeyError, TypeError):
        return {"status": "stale", "reason": "clip_replaced", "artifact": None}
    try:
        artifact = read_artifact(source_name, clip_id)
    except PrecisionError:
        return {"status": "stale", "reason": "invalid_artifact", "artifact": None}
    if artifact is None:
        return {"status": "waiting", "reason": None, "artifact": None}
    source = settings.data_sources_dir / source_name
    try:
        if source_identity(source) != artifact["source_identity"]:
            return {"status": "stale", "reason": "source_changed", "artifact": artifact}
    except OSError:
        return {"status": "stale", "reason": "source_unavailable", "artifact": artifact}
    if start < artifact["padded_start"] - 0.001 or end > artifact["padded_end"] + 0.001:
        return {"status": "stale", "reason": "outside_prepared_range", "artifact": artifact}
    path = transcript_path or transcribe.transcript_path_for(source_name)
    try:
        effective, edits, warnings = transcript_edits.load_effective_transcript(path)
    except (OSError, ValueError):
        return {"status": "stale", "reason": "transcript_unavailable", "artifact": artifact}
    if warnings:
        return {"status": "needs_review", "reason": "human_edits_unresolved", "artifact": artifact}
    if _human_edit_overlaps(edits, start, end):
        return {"status": "needs_review", "reason": "human_correction_overlaps", "artifact": artifact}
    if (_snapshot_in(artifact["effective_words"], start, end) !=
            _words_in(effective, start, end)):
        return {"status": "stale", "reason": "transcript_changed_in_clip", "artifact": artifact}
    return {"status": "ready", "reason": None, "artifact": artifact,
            "transcript_changed_elsewhere": artifact["effective_fingerprint"] !=
            transcript_alignment.fingerprint(effective)}


def caption_words(source_name: str, clip_id: str | None, start: float, end: float,
                  transcript_path: Path) -> tuple[list[captions.Word], str]:
    """Both preview and export use this source priority and boundary rule.

    Include a word when its interval intersects [start, end), then clamp the
    visible interval to the actual clip range. Padding words never appear.
    """
    if clip_id:
        result = assess(source_name, clip_id, start, end, transcript_path)
        if result["status"] == "ready":
            return captions.words_in_range(result["artifact"], start, end), "clip_precision"
    display = transcript_alignment.load_display_transcript(transcript_path)
    return captions.words_in_range(display, start, end), "sermon_fallback"


def _extract_audio(source: Path, start: float, end: float, output: Path) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-ss", f"{start:.6f}", "-i", str(source), "-t", f"{end - start:.6f}",
                    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                    str(output)], check=True, capture_output=True, timeout=180)


def prepare(source_name: str, clip_id: str, start: float, end: float,
            progress_cb: ProgressCB | None = None,
            transcribe_fn=None, align_fn=None) -> dict:
    """Local ASR and isolated WhisperX over one padded range, with atomic output."""
    source = settings.data_sources_dir / source_name
    transcript_path = transcribe.transcript_path_for(source_name)
    identity = source_identity(source)
    effective, _, warnings = transcript_edits.load_effective_transcript(transcript_path)
    if warnings:
        raise PrecisionError("effective transcript corrections need review")
    duration = transcribe._probe_duration(source) or float(effective.get("duration") or 0) or None
    process_start, process_end = padded_range(start, end, duration)
    if progress_cb:
        progress_cb("Extracting clip audio", 0.02)
    with tempfile.TemporaryDirectory(prefix="connectclips-clip-precision-") as temp:
        audio = Path(temp) / "clip.wav"
        _extract_audio(source, process_start, process_end, audio)
        if progress_cb:
            progress_cb("Transcribing clip audio", 0.08)
        local = (transcribe_fn or transcribe.transcribe_file)(audio)
        local["duration"] = process_end - process_start
        words = transcript_alignment.flatten(local)
        if not words:
            raise PrecisionError("clip transcription returned no words")
        quality = transcript_quality.analyze_transcript(local)
        if quality["status"] == "failed":
            raise PrecisionError("clip transcription failed quality checks")
        windows = alignment_runner.make_windows(words, [(0.0, local["duration"])],
                                                local["duration"])
        if progress_cb:
            progress_cb("Aligning clip words", 0.55)
        aligned = (align_fn or alignment_runner._run_worker)(audio, windows)
        candidate = alignment_runner.merge(local, [(0.0, local["duration"])], windows, aligned)
        errors = transcript_alignment.validation_errors(local, candidate)
        if errors:
            raise PrecisionError("clip alignment requires review: " + ", ".join(errors))
    by_key = {word["key"]: word for word in candidate["words"]}
    absolute_segments = []
    absolute_words = []
    for segment in local["segments"]:
        segment_words = []
        for index, raw_word in enumerate(segment.get("words", [])):
            if not raw_word["word"].strip():
                continue
            entry = by_key[transcript_alignment.word_key(segment["id"], index)]
            a = process_start + entry.get("aligned_start", entry["start"])
            b = process_start + entry.get("aligned_end", entry["end"])
            word = {"word": entry["text"], "start": round(max(process_start, a), 3),
                    "end": round(min(process_end, b), 3),
                    "alignment_status": entry["status"]}
            if word["end"] <= word["start"]:
                raise PrecisionError("clip word timing collapsed at processing boundary")
            segment_words.append(word)
            absolute_words.append(word)
        if segment_words:
            absolute_segments.append({"id": segment["id"], "start": segment_words[0]["start"],
                                      "end": segment_words[-1]["end"], "text": segment["text"],
                                      "words": segment_words})
    if source_identity(source) != identity:
        raise PrecisionError("source media changed during clip preparation")
    artifact = {
        "version": SCHEMA_VERSION, "clip_id": clip_id, "source_name": source_name,
        "source_identity": identity,
        "effective_fingerprint": transcript_alignment.fingerprint(effective),
        "effective_words": _words_in(effective, process_start, process_end),
        "clip_start": start, "clip_end": end,
        "padded_start": process_start, "padded_end": process_end,
        "transcription": {"backend": local.get("backend"), "model": local.get("model"),
                          "quality": quality["status"]},
        "alignment": {"backend": "whisperx", "model": settings.alignment_model,
                      "aligned_words": sum(word["status"] == "aligned" for word in candidate["words"]),
                      "fallback_words": sum(word["status"] == "fallback" for word in candidate["words"])},
        "prepared_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "segments": absolute_segments, "words": absolute_words,
    }
    # A clip may be deleted or replaced while inference is running.
    current_clip(source_name, clip_id)
    clip_selection.write_json_atomic(artifact_path(source_name, clip_id), artifact)
    read_artifact(source_name, clip_id)
    if progress_cb:
        progress_cb("Clip ready", 1.0)
    return artifact
