"""Bounded, independent local Whisper decodes for failed transcript spans."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from pathlib import Path
from typing import Callable

from app.config import settings
from app.services import transcribe, transcript_edits, transcript_repairs
from app.services.transcript_quality import analyze_transcript


OWNED_SECONDS = 50.0
CONTEXT_SECONDS = 5.0
ProgressCB = Callable[[str, float], None]


def choose_span(raw: dict, finding: dict) -> tuple[float, float]:
    """Splice at intact neighboring segment boundaries, not a guessed word cut."""
    segments = raw.get("segments", [])
    if finding["reason"] == "transcript_coverage_gap":
        # Include the final clean segment in the owned range so the missing
        # tail reconnects to speech, not just an unanchored silence boundary.
        if not segments:
            raise transcript_repairs.RepairError("coverage finding has no anchor")
        start = float(segments[max(0, len(segments) - 2)]["start"])
        end = float(raw["duration"])
        if end <= start:
            raise transcript_repairs.RepairError("invalid splice boundaries")
        return start, end
    first = next((i for i, s in enumerate(segments)
                  if s["start"] >= finding["start_time"] - 0.01), None)
    last = next((i for i in range(len(segments) - 1, -1, -1)
                 if segments[i]["end"] <= finding["end_time"] + 0.01), None)
    if first is None or last is None or last < first:
        raise transcript_repairs.RepairError("quality finding does not map to source segments")
    # Own one clean neighboring segment when available; each decode also gets
    # five seconds of acoustic context outside its owned window.
    start = float(segments[max(0, first - 2)]["end"]) if first else 0.0
    end = float(segments[last + 1]["start"]) if last + 1 < len(segments) else float(raw["duration"])
    if end <= start:
        raise transcript_repairs.RepairError("invalid splice boundaries")
    return start, end


def owned_windows(start: float, end: float, duration: float,
                  owned_seconds: float = OWNED_SECONDS,
                  context_seconds: float = CONTEXT_SECONDS) -> list[dict]:
    if not 0 <= start < end <= duration or owned_seconds <= 0 or context_seconds < 0:
        raise ValueError("invalid window settings")
    windows = []
    cursor = start
    while cursor < end - 0.001:
        owned_end = min(end, cursor + owned_seconds)
        windows.append({
            "owned_start": cursor, "owned_end": owned_end,
            "audio_start": max(0.0, cursor - context_seconds),
            "audio_end": min(duration, owned_end + context_seconds),
        })
        cursor = owned_end
    return windows


def _extract_audio(source: Path, start: float, end: float, output: Path) -> None:
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{start:.3f}", "-i", str(source), "-t", f"{end - start:.3f}",
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output),
    ], check=True, capture_output=True, timeout=180)


def _transcribe_audio(audio: Path, backend: str, model_name: str) -> list[dict]:
    """Return word-level times relative to this independent audio file."""
    if backend == "whispercpp":
        if model_name != settings.whisper_model:
            raise transcript_repairs.RepairError(
                "whispercpp repair model must match the normal transcription model"
            )
        model = transcribe._get_whispercpp_model()
        result = model.transcribe(str(audio), token_timestamps=True, max_len=1,
                                  split_on_word=True, language="", no_context=True)
        return [{"word": seg.text.strip(), "start": seg.t0 / 100.0, "end": seg.t1 / 100.0}
                for seg in result if seg.text.strip() and not seg.text.strip().startswith("<|")]
    if backend == "ctranslate2":
        model = transcribe._get_ct2_model(model_name)
        segments, _ = model.transcribe(str(audio), word_timestamps=True,
                                       condition_on_previous_text=False, vad_filter=False)
        return [{"word": word.word.strip(), "start": float(word.start), "end": float(word.end)}
                for seg in segments for word in (seg.words or []) if word.word.strip()]
    if backend == "whispercli":
        result = transcribe._transcribe_whispercli(audio, None)
        return [{"word": word["word"].strip(), "start": word["start"], "end": word["end"]}
                for seg in result["segments"] for word in seg["words"] if word["word"].strip()]
    raise transcript_repairs.RepairError(f"unsupported repair backend: {backend}")


class _InferenceWorker:
    """Keep one model in a subprocess; contain native crashes and timeouts."""

    def __init__(self, backend: str, model_name: str):
        env = os.environ.copy()
        backend_root = str(Path(__file__).resolve().parents[2])
        env["PYTHONPATH"] = backend_root + os.pathsep + env.get("PYTHONPATH", "")
        self.process = subprocess.Popen(
            [sys.executable, "-m", "app.services.transcript_repair_worker", backend, model_name],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, env=env,
        )
        self.reader = ThreadPoolExecutor(max_workers=1)

    def transcribe(self, audio: Path) -> list[dict]:
        if self.process.stdin is None or self.process.stdout is None:
            raise transcript_repairs.RepairError("repair inference worker is unavailable")
        try:
            self.process.stdin.write(json.dumps({"audio": str(audio)}) + "\n")
            self.process.stdin.flush()
        except BrokenPipeError as exc:
            raise transcript_repairs.RepairError("repair inference worker exited") from exc
        future = self.reader.submit(self.process.stdout.readline)
        try:
            line = future.result(timeout=900)
        except FutureTimeout as exc:
            self.process.kill()
            raise transcript_repairs.RepairError("repair window exceeded inference timeout") from exc
        if not line:
            self.process.poll()
            raise transcript_repairs.RepairError(
                f"repair inference worker exited with code {self.process.returncode}")
        result = json.loads(line)
        if "error" in result:
            raise transcript_repairs.RepairError(f"repair inference failed: {result['error']}")
        return result["words"]

    def close(self) -> None:
        if self.process.poll() is None:
            if self.process.stdin:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.reader.shutdown(wait=True)


def transcribe_span(source: Path, start: float, end: float, duration: float,
                    backend: str, progress_cb: ProgressCB | None = None,
                    owned_seconds: float = OWNED_SECONDS,
                    context_seconds: float = CONTEXT_SECONDS,
                    transcribe_fn: Callable[[Path, str], list[dict]] | None = None,
                    model_name: str | None = None,
                    retry_gaps: bool = True) -> tuple[list[dict], dict]:
    """Decode each owned window with context, retaining only owned words."""
    windows = owned_windows(start, end, duration, owned_seconds, context_seconds)
    words: list[dict] = []
    counts: list[int] = []
    deduplicated = 0
    resolved_model = model_name or settings.whisper_model
    worker = _InferenceWorker(backend, resolved_model) if transcribe_fn is None else None
    try:
        for index, window in enumerate(windows):
            with tempfile.TemporaryDirectory(prefix="connectclips-repair-") as temp_dir:
                wav = Path(temp_dir) / "window.wav"
                _extract_audio(source, window["audio_start"], window["audio_end"], wav)
                decoded = worker.transcribe(wav) if worker else transcribe_fn(wav, backend)
            retained = 0
            for word in decoded:
                text = word["word"].strip()
                if not text or text.startswith("<|") or (text.startswith("[") and text.endswith("]")):
                    continue
                word_start = float(word["start"]) + window["audio_start"]
                word_end = float(word["end"]) + window["audio_start"]
                midpoint = (word_start + word_end) / 2
                if not window["owned_start"] <= midpoint < window["owned_end"] + (0.001 if index == len(windows) - 1 else 0):
                    continue
                word_start = max(window["owned_start"], word_start)
                word_end = min(window["owned_end"], word_end)
                if word_end <= word_start:
                    continue
                if (words and index > 0 and retained == 0 and
                        re.sub(r"\W+", "", words[-1]["word"].casefold()) ==
                        re.sub(r"\W+", "", text.casefold()) and
                        word_start - words[-1]["end"] <= 0.15 and
                        abs(word_start - window["owned_start"]) < 0.5):
                    deduplicated += 1
                    continue
                words.append({"word": text, "start": round(word_start, 3),
                              "end": round(word_end, 3)})
                retained += 1
            counts.append(retained)
            if progress_cb:
                progress_cb(f"Repairing audio window {index + 1}/{len(windows)}", (index + 1) / len(windows))
    finally:
        if worker:
            worker.close()
    words.sort(key=lambda w: (w["start"], w["end"]))
    gap_retries = 0
    gap_words_added = 0
    if retry_gaps:
        additions: list[dict] = []
        long_gaps = [(previous, following) for previous, following in zip(words, words[1:])
                     if following["start"] - previous["end"] > 3.0]
        for index, (previous, following) in enumerate(long_gaps):
            gap_retries += 1
            # A fresh, short decode can recover speech that Whisper skipped
            # inside a longer window. Keep only words wholly in the gap, and
            # require a phrase so an isolated silence hallucination is ignored.
            retry_words, _ = transcribe_span(
                source, max(start, previous["end"] - 1.0),
                min(end, following["start"] + 1.0), duration, backend,
                owned_seconds=owned_seconds, context_seconds=context_seconds,
                transcribe_fn=transcribe_fn, model_name=resolved_model,
                retry_gaps=False,
            )
            interior = [word for word in retry_words
                        if previous["end"] + 0.2 < word["start"] and
                        word["end"] < following["start"] - 0.2]
            if len(interior) >= 3 and not _has_word_loop(interior):
                additions.extend(interior)
                gap_words_added += len(interior)
            if progress_cb:
                progress_cb(f"Checking speech gap {index + 1}/{len(long_gaps)}", 1.0)
        words.extend(additions)
        words.sort(key=lambda w: (w["start"], w["end"]))
    # Whisper can assign an end past the next onset. Bound the new candidate's
    # end to that onset so stitched segments stay chronological.
    for current, following in zip(words, words[1:]):
        current["end"] = max(current["start"], min(current["end"], following["start"]))
    words = [w for w in words if w["end"] > w["start"]]
    return words, {"windows": len(windows), "window_word_counts": counts,
                   "boundary_duplicates_removed": deduplicated,
                   "gap_retries": gap_retries, "gap_words_added": gap_words_added,
                   "owned_seconds": owned_seconds, "context_seconds": context_seconds,
                   "no_previous_text_context": True, "model": resolved_model}


def _segments_from_words(words: list[dict], repair_id: str) -> list[dict]:
    segments = []
    current: list[dict] = []
    for word in words:
        if current and word["start"] - current[-1]["end"] > 0.8:
            segments.append(current)
            current = []
        current.append(word)
        if word["word"].endswith((".", "?", "!")) or len(current) >= 30:
            segments.append(current)
            current = []
    if current:
        segments.append(current)
    return [{"id": f"repair:{repair_id}:{i}", "start": group[0]["start"],
             "end": group[-1]["end"], "text": " ".join(w["word"] for w in group),
             "words": group} for i, group in enumerate(segments)]


def _same_failure_present(report: dict, finding: dict) -> bool:
    return any(f["severity"] == "failed" and f["reason"] == finding["reason"] and
               min(f["end_time"], finding["end_time"]) -
               max(f["start_time"], finding["start_time"]) > 1.0
               for f in report["findings"])


def _has_word_loop(words: list[dict]) -> bool:
    """Catch token-level hallucination loops that sentence QC cannot see."""
    tokens = [re.sub(r"\W+", "", w["word"].casefold()) for w in words]
    for period in range(1, 13):
        if len(tokens) < max(24, period * 8):
            continue
        for index in range(len(tokens) - max(24, period * 8) + 1):
            pattern = tokens[index:index + period]
            if not all(pattern):
                continue
            count = 0
            while index + count < len(tokens) and tokens[index + count] == pattern[count % period]:
                count += 1
            if count >= max(24, period * 8) and count // period >= 8 and \
                    words[index + count - 1]["end"] - words[index]["start"] >= 8:
                return True
    return False


def validate_candidate(raw: dict, existing_repairs: list[dict], candidate: dict,
                       finding: dict, human_edits: list[dict]) -> dict:
    """Reject suspicious stitching and require an improved full transcript."""
    errors: list[str] = []
    warnings: list[str] = []
    start, end = candidate["replace_start"], candidate["replace_end"]
    try:
        transcript_repairs._validate_record(candidate, float(raw["duration"]))
        proposed = [r for r in existing_repairs if
                    r["replace_end"] <= start or r["replace_start"] >= end] + [candidate]
        base = transcript_repairs.apply_records(raw, proposed)
    except (transcript_repairs.RepairError, KeyError, TypeError) as exc:
        return {"accepted": False, "errors": [str(exc)], "warnings": []}
    words = [w for s in candidate["replacement_segments"] for w in s["words"]]
    density = len(words) / (end - start)
    if not 0.3 <= density <= 8.0:
        errors.append("replacement word density is implausible")
    if any(count == 0 for count in candidate["strategy"]["window_word_counts"]):
        errors.append("one or more owned windows contain no words")
    if candidate["strategy"]["boundary_duplicates_removed"] > max(2, len(words) * 0.02):
        errors.append("too many duplicated words at chunk boundaries")
    for previous, following in zip(words, words[1:]):
        if following["start"] < previous["start"] or following["start"] < previous["end"] - 0.06:
            errors.append("replacement words are not monotonic")
            break
    isolated = analyze_transcript({"segments": candidate["replacement_segments"]})
    if isolated["status"] == "failed":
        errors.append("replacement still has a catastrophic repeated-text loop")
    if _has_word_loop(words):
        errors.append("replacement contains a sustained repeated-word loop")
    effective, valid_edits, edit_warnings = transcript_edits.apply_edits_to_base(base, human_edits)
    if edit_warnings or len(valid_edits) != len(human_edits):
        errors.append("human correction would become stale")
    full_quality = analyze_transcript(effective)
    if any(later["start"] < earlier["start"] - 0.01 for earlier, later in
           zip(effective["segments"], effective["segments"][1:])):
        errors.append("effective transcript is not chronological")
    if _same_failure_present(full_quality, finding):
        errors.append("original catastrophic failure remains in effective transcript")
    previous_base = transcript_repairs.apply_records(raw, existing_repairs)
    previous_effective, _, _ = transcript_edits.apply_edits_to_base(previous_base, human_edits)
    previous_quality = analyze_transcript(previous_effective)
    previous_failed = sum(f["severity"] == "failed" for f in previous_quality["findings"])
    new_failed = sum(f["severity"] == "failed" for f in full_quality["findings"])
    if (previous_failed and new_failed >= previous_failed) or (not previous_failed and new_failed):
        errors.append("full effective transcript is not materially healthier")
    before = [s for s in raw["segments"] if s["end"] <= start]
    after = [s for s in raw["segments"] if s["start"] >= end]
    if before and words[0]["start"] - before[-1]["end"] > 15:
        errors.append("large gap at repair start boundary")
    if after and after[0]["start"] - words[-1]["end"] > 15:
        errors.append("large gap at repair end boundary")
    if before and words[0]["start"] < before[-1]["end"] - 0.01:
        errors.append("replacement overlaps intact text before splice")
    if after and words[-1]["end"] > after[0]["start"] + 0.01:
        errors.append("replacement overlaps intact text after splice")
    return {"accepted": not errors, "errors": errors, "warnings": warnings,
            "word_count": len(words), "segment_count": len(candidate["replacement_segments"]),
            "word_density_per_second": round(density, 3),
            "effective_quality": full_quality["status"]}


def _fallback_available() -> tuple[bool, str]:
    if settings.transcript_repair_backend != "ctranslate2":
        return False, "fallback disabled"
    model_name = settings.transcript_repair_model or settings.whisper_model
    if settings.transcript_repair_allow_model_download:
        return True, "download allowed by configuration"
    try:
        from faster_whisper.utils import download_model
        download_model(model_name, local_files_only=True)
        return True, "model weights cached locally"
    except Exception:
        return False, "faster-whisper model weights are not cached locally"


def repair_transcript(source: Path, transcript_path: Path,
                      progress_cb: ProgressCB | None = None,
                      recheck_accepted: bool = False) -> dict:
    """Attempt supported failed spans; never overwrite raw or a valid repair."""
    raw = json.loads(transcript_path.read_text(encoding="utf-8"))
    raw_quality = analyze_transcript(raw)
    supported = {"repeated_phrase_loop", "repeated_ngram_loop",
                 "vocabulary_collapse", "transcript_coverage_gap"}
    findings = [f for f in raw_quality["findings"] if
                f["severity"] == "failed" and f["reason"] in supported]
    if not findings:
        return transcript_repairs.transcript_status(transcript_path)
    try:
        human_edits = transcript_edits._read_sidecar(transcript_edits.edits_path_for(transcript_path))
    except transcript_edits.EditError as exc:
        raise transcript_repairs.RepairError("human corrections require review") from exc
    # An explicitly chosen repair model is an operator choice for repair only.
    # Otherwise retain the normal-backend-first behavior and cached fallback.
    configured_model = settings.transcript_repair_model.strip()
    if configured_model:
        available, reason = _fallback_available()
        if not available:
            raise transcript_repairs.RepairError(reason)
        primary = settings.transcript_repair_backend
        primary_model = configured_model
    else:
        primary = transcribe._resolve_backend()
        primary_model = settings.whisper_model
    for finding in findings:
        status = transcript_repairs.transcript_status(transcript_path)
        if not recheck_accepted and not _same_failure_present(status["effective_quality"], finding):
            continue
        start, end = choose_span(raw, finding)
        conflicts = transcript_repairs.edit_conflicts(transcript_path, start, end)
        if conflicts:
            transcript_repairs.record_attempt(transcript_path, {
                "id": uuid.uuid4().hex, "status": "conflict", "finding": finding,
                "replace_start": start, "replace_end": end,
                "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "failure_reason": "existing human corrections overlap this range",
                "conflicting_edit_ids": conflicts,
            })
            continue
        attempts = [(primary, primary_model)]
        fallback_note = None
        for backend, model_name in attempts:
            repair_id = uuid.uuid4().hex
            started = time.monotonic()
            attempt = {"id": repair_id, "status": "failed", "finding": finding,
                       "replace_start": start, "replace_end": end,
                       "backend": backend, "model": model_name,
                       "generated_at": dt.datetime.now(dt.timezone.utc).isoformat()}
            try:
                words, strategy = transcribe_span(source, start, end, float(raw["duration"]),
                                                  backend, progress_cb, model_name=model_name)
                candidate = {**attempt, "status": "accepted", "strategy": strategy,
                             "replacement_segments": _segments_from_words(words, repair_id)}
                data = transcript_repairs.read_sidecar(transcript_path)
                validation = validate_candidate(raw, data["repairs"], candidate, finding, human_edits)
                attempt["validation"] = validation
                attempt["runtime_seconds"] = round(time.monotonic() - started, 2)
                if validation["accepted"]:
                    candidate["validation"] = validation
                    candidate["generated_at"] = attempt["generated_at"]
                    attempt["status"] = "accepted"
                    transcript_repairs.record_attempt(transcript_path, attempt, accepted=candidate)
                    break
                attempt["failure_reason"] = "; ".join(validation["errors"])
            except Exception as exc:
                attempt["runtime_seconds"] = round(time.monotonic() - started, 2)
                attempt["failure_reason"] = (str(exc) if isinstance(exc, transcript_repairs.RepairError)
                                             else f"{type(exc).__name__}: repair attempt could not complete")
            transcript_repairs.record_attempt(transcript_path, attempt)
            if backend == primary and primary != "ctranslate2":
                available, reason = _fallback_available()
                if available:
                    fallback_model = settings.transcript_repair_model or settings.whisper_model
                    attempts.append((settings.transcript_repair_backend, fallback_model))
                else:
                    fallback_note = reason
        else:
            if fallback_note is not None:
                transcript_repairs.record_attempt(transcript_path, {
                    "id": uuid.uuid4().hex, "status": "unavailable",
                    "finding": finding, "replace_start": start, "replace_end": end,
                    "backend": settings.transcript_repair_backend,
                    "model": settings.transcript_repair_model or settings.whisper_model,
                    "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "failure_reason": fallback_note,
                })
    return transcript_repairs.transcript_status(transcript_path)
