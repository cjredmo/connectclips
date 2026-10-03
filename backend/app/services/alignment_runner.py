"""Contextual, text-preserving WhisperX alignment and candidate validation."""

from __future__ import annotations

import json
import math
import re
import subprocess
import tempfile
import time
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable

from app.config import settings
from app.services import transcript_alignment, transcript_repairs
from app.services.transcript_edits import load_effective_transcript

OWNED_SECONDS = 20.0
CONTEXT_SECONDS = 6.0
MAX_OVERLAP_DISAGREEMENT = 0.35
MIN_SCORE = 0.10


def _norm(text: str) -> str:
    return re.sub(r"[^\w]+", "", text, flags=re.UNICODE).casefold()


def make_windows(words: list[dict], ranges: list[tuple[float, float]], duration: float) -> list[dict]:
    windows = []
    for range_start, range_end in ranges:
        if not 0 <= range_start < range_end <= duration + 0.01:
            raise ValueError("invalid alignment range")
        owned_start = range_start
        while owned_start < range_end - 0.001:
            owned_end = min(range_end, owned_start + OWNED_SECONDS)
            audio_start = max(0.0, owned_start - CONTEXT_SECONDS)
            audio_end = min(duration, owned_end + CONTEXT_SECONDS)
            selected = [w for w in words if audio_start <= w["start"] < audio_end]
            windows.append({"index": len(windows), "owned_start": owned_start,
                            "owned_end": owned_end, "audio_start": audio_start,
                            "audio_end": audio_end, "keys": [w["key"] for w in selected],
                            "text": " ".join(w["text"] for w in selected)})
            owned_start = owned_end
    return windows


def _run_worker(source: Path, windows: list[dict], progress_cb=None) -> dict:
    python = settings.alignment_python.strip()
    if not python or not Path(python).is_file():
        raise transcript_alignment.AlignmentError("configure ALIGNMENT_PYTHON with an isolated WhisperX interpreter")
    payload = {"source": str(source), "windows": windows,
               "language": settings.alignment_language, "device": settings.alignment_device,
               "model": settings.alignment_model,
               "model_dir": settings.alignment_model_dir}
    with tempfile.TemporaryDirectory(prefix="connectclips-alignment-") as temp:
        input_path, output_path = Path(temp) / "input.json", Path(temp) / "output.json"
        input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        if progress_cb:
            progress_cb("Loading alignment model", 0.01)
        stdout_path, stderr_path = Path(temp) / "stdout.log", Path(temp) / "stderr.log"
        with stdout_path.open("w") as stdout, stderr_path.open("w") as stderr:
            process = subprocess.Popen(
                [python, str(Path(__file__).with_name("alignment_worker.py")),
                 str(input_path), str(output_path)], stdout=stdout, stderr=stderr)
            last_reported = -1
            while process.poll() is None:
                if progress_cb and output_path.exists():
                    try:
                        completed = len(json.loads(output_path.read_text(encoding="utf-8"))["windows"])
                    except (OSError, ValueError, KeyError):
                        completed = last_reported
                    if completed != last_reported:
                        last_reported = completed
                        progress_cb(f"Aligning window {completed}/{len(windows)}",
                                    completed / len(windows))
                time.sleep(0.5)
            returncode = process.wait()
        if returncode:
            raise transcript_alignment.AlignmentError(
                f"alignment worker failed ({returncode}): "
                f"{stderr_path.read_text(encoding='utf-8')[-1200:]}")
        if not output_path.exists():
            raise transcript_alignment.AlignmentError("alignment worker did not return results")
        return json.loads(output_path.read_text(encoding="utf-8"))


def _map_output(window: dict, result: dict, by_key: dict[str, dict]) -> dict[str, dict]:
    expected = [by_key[k] for k in window["keys"]]
    received = result.get("word_segments", [])
    left = [_norm(w["text"]) for w in expected]
    right = [_norm(w.get("word", "")) for w in received]
    mapped = {}
    for block in SequenceMatcher(None, left, right, autojunk=False).get_matching_blocks():
        for offset in range(block.size):
            original = expected[block.a + offset]
            aligned = received[block.b + offset]
            if not original["text"].strip() or not left[block.a + offset]:
                continue
            start, end = aligned.get("start"), aligned.get("end")
            if isinstance(start, (int, float)) and isinstance(end, (int, float)):
                mapped[original["key"]] = {
                    "start": window["audio_start"] + float(start),
                    "end": window["audio_start"] + float(end),
                    "score": aligned.get("score"),
                }
    return mapped


def merge(effective: dict, ranges: list[tuple[float, float]], windows: list[dict],
          worker_result: dict) -> dict:
    words = transcript_alignment.flatten(effective)
    by_key = {w["key"]: w for w in words}
    results = {r["index"]: r for r in worker_result.get("windows", [])}
    mapped = {w["index"]: _map_output(w, results[w["index"]], by_key)
              for w in windows if w["index"] in results}
    diagnostics = []
    failed_windows = [w["index"] for w in windows if w["index"] not in results]
    output = []
    for word in words:
        if not any(a <= word["start"] < b for a, b in ranges):
            continue
        owner = next((w for w in windows if w["owned_start"] <= word["start"] < w["owned_end"]), None)
        entry = {**word, "status": "fallback", "reason": "unresolved"}
        primary = mapped.get(owner["index"], {}).get(word["key"]) if owner else None
        if primary:
            start, end, score = primary["start"], primary["end"], primary["score"]
            checks = [other[word["key"]] for index, other in mapped.items()
                      if index != owner["index"] and word["key"] in other]
            disagreement = max((abs(start - other["start"]) for other in checks), default=0.0)
            rounded_start, rounded_end = round(start, 3), round(end, 3)
            if not (math.isfinite(start) and math.isfinite(end) and
                    transcript_alignment.valid_aligned_duration(start, end) and
                    transcript_alignment.valid_aligned_duration(rounded_start, rounded_end) and
                    0 <= start < end <= float(effective["duration"]) + 0.01):
                entry["reason"] = "invalid_duration_or_bounds"
            elif score is not None and (not isinstance(score, (int, float)) or
                                        not math.isfinite(score) or score < MIN_SCORE):
                entry["reason"] = "low_score"
            elif disagreement > MAX_OVERLAP_DISAGREEMENT:
                entry["reason"] = "overlap_disagreement"
            else:
                entry.update(status="aligned", reason=None, aligned_start=rounded_start,
                             aligned_end=rounded_end, score=score,
                             overlap_max_start_shift=round(disagreement, 3))
                if abs(start - word["start"]) > 1.5:
                    diagnostics.append(f"{word['key']}: large_start_shift")
        if entry["status"] != "aligned":
            diagnostics.append(f"{word['key']}: {entry['reason']}")
        output.append(entry)
    # A lone large shift unsupported by the words on either side is usually
    # a forced-alignment jump across a pause, not a credible acoustic onset.
    for index in range(1, len(output) - 1):
        current, before, after = output[index], output[index - 1], output[index + 1]
        if not all(w["status"] == "aligned" for w in (before, current, after)):
            continue
        shifts = [w["aligned_start"] - w["start"] for w in (before, current, after)]
        if (abs(shifts[1]) > 1.0 and abs(shifts[1] - shifts[0]) > 0.8 and
                abs(shifts[1] - shifts[2]) > 0.8 and
                current["start"] - before["start"] < 3.0 and
                after["start"] - current["start"] < 3.0):
            current.update(status="fallback", reason="isolated_large_shift")
            current.pop("aligned_start", None)
            current.pop("aligned_end", None)
            diagnostics.append(f"{current['key']}: isolated_large_shift")
    # Revert an aligned word (and, if necessary, its aligned neighbor) when
    # mixed native/aligned timing would overlap. Native fallback is unchanged.
    def times(entry):
        return (entry.get("aligned_start", entry["start"]),
                entry.get("aligned_end", entry["end"]))

    def revert(entry):
        entry.update(status="fallback", reason="chronology_conflict")
        entry.pop("aligned_start", None)
        entry.pop("aligned_end", None)
        diagnostics.append(f"{entry['key']}: chronology_conflict")

    for _ in range(len(output)):
        changed = False
        for before, after in zip(output, output[1:]):
            before_start, before_end = times(before)
            after_start, after_end = times(after)
            if (after_start >= before_start and after_end >= before_end and
                    after_start >= before_end - 0.06):
                continue
            if before["status"] == "aligned" and after["status"] != "aligned":
                revert(before)
            elif after["status"] == "aligned" and before["status"] != "aligned":
                revert(after)
            elif before["status"] == after["status"] == "aligned":
                before_score = before.get("score") or 0.0
                after_score = after.get("score") or 0.0
                revert(before if before_score < after_score else after)
            else:
                continue
            changed = True
        if not changed:
            break
    chronology_errors = [after["key"] for before, after in zip(output, output[1:])
                         if times(after)[0] < times(before)[0] or
                         times(after)[1] < times(before)[1] or
                         times(after)[0] < times(before)[1] - 0.06]
    candidate = transcript_alignment.new_candidate(
        effective, model=settings.alignment_model, ranges=ranges,
        words=output, diagnostics=diagnostics, failed_windows=failed_windows)
    candidate["chronology_errors"] = chronology_errors
    return candidate


def align_transcript(source: Path, transcript_path: Path,
                     ranges: list[tuple[float, float]] | None = None,
                     activate: bool = True,
                     progress_cb: Callable[[str, float], None] | None = None,
                     worker_fn=None) -> tuple[dict, dict]:
    quality = transcript_repairs.transcript_status(transcript_path)
    if quality["effective_quality"]["status"] == "failed" or quality["human_review_required"]:
        raise transcript_alignment.AlignmentError("effective transcript requires review")
    effective, _, warnings = load_effective_transcript(transcript_path)
    if warnings:
        raise transcript_alignment.AlignmentError("effective transcript has unresolved corrections")
    duration = float(effective["duration"])
    target = ranges or [(0.0, duration)]
    words = transcript_alignment.flatten(effective)
    windows = make_windows(words, target, duration)
    if not windows:
        raise transcript_alignment.AlignmentError("no alignment windows")
    result = (worker_fn or _run_worker)(source, windows, progress_cb)
    candidate = merge(effective, target, windows, result)
    candidate["model_load_seconds"] = result.get("model_load_seconds")
    candidate["window_count"] = len(windows)
    candidate["window_seconds"] = [w.get("seconds") for w in result.get("windows", [])]
    aligned = sum(w["status"] == "aligned" for w in candidate["words"])
    reasons = Counter(w.get("reason") or "unspecified" for w in candidate["words"]
                      if w["status"] == "fallback")
    candidate["validation"] = {"aligned_words": aligned,
                               "fallback_words": len(candidate["words"]) - aligned,
                               "word_count": len(candidate["words"]),
                               "coverage_percent": round(100 * aligned / len(candidate["words"]), 2),
                               "fallback_reasons": dict(sorted(reasons.items())),
                               "failed_windows": candidate["failed_windows"],
                               "chronology_errors": candidate["chronology_errors"]}
    if activate:
        errors = transcript_alignment.validation_errors(effective, candidate)
        if ranges is not None or not candidate["words"] or not aligned or errors:
            raise transcript_alignment.AlignmentError(
                "alignment candidate requires review: " + ", ".join(errors or ["no aligned words"]))
        # The fingerprint is checked again just before the atomic sidecar write.
        current, _, _ = load_effective_transcript(transcript_path)
        if transcript_alignment.fingerprint(current) != candidate["effective_fingerprint"]:
            raise transcript_alignment.AlignmentError("effective transcript changed during alignment")
        transcript_alignment.write(transcript_path, candidate)
    if progress_cb:
        progress_cb("Alignment complete", 1.0)
    return candidate, result
