"""Acquire a conservative sermon transcript from native YouTube VTT captions.

Caption timing is only for sermon review and clip discovery. Saved clips still
use the separate precision preparation path for publication timing.
"""

from __future__ import annotations

import datetime as dt
import html
import math
import re
from pathlib import Path

import yt_dlp
from yt_dlp.networking.common import Request

from app.services.transcript_quality import analyze_transcript

_TIME = re.compile(r"(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})")
_TAG = re.compile(r"<[^>]*>")
_NON_SPEECH = re.compile(r"^\s*[\[(](?:music|applause|laughter|noise|silence)[\])]\s*$", re.I)


class CaptionUnavailable(ValueError):
    """No native caption track passed acquisition and quality checks."""


def _seconds(value: str) -> float:
    match = _TIME.fullmatch(value.strip())
    if not match:
        raise CaptionUnavailable("malformed VTT timing")
    hours, minutes, seconds, millis = match.groups()
    return int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def _clean(text: str) -> str:
    text = html.unescape(_TAG.sub("", text))
    return " ".join(text.split())


def parse_vtt(vtt: str) -> list[tuple[float, float, str]]:
    """Parse timed VTT cues, rejecting corrupt timing rather than guessing."""
    if not vtt.lstrip("\ufeff \t\r\n").startswith("WEBVTT"):
        raise CaptionUnavailable("caption track is not VTT")
    cues = []
    for block in re.split(r"\r?\n\s*\r?\n", vtt.replace("\r\n", "\n")):
        lines = block.splitlines()
        timing = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if timing is None:
            continue
        left, right = lines[timing].split("-->", 1)
        start, end = _seconds(left), _seconds(right.split()[0])
        if not 0 <= start < end or not all(map(math.isfinite, (start, end))):
            raise CaptionUnavailable("invalid VTT cue range")
        text = _clean(" ".join(lines[timing + 1:]))
        if text and not _NON_SPEECH.fullmatch(text):
            cues.append((start, end, text))
    return cues


def _tokens(text: str) -> list[str]:
    return text.split()


def _same(a: str, b: str) -> bool:
    left, right = (re.sub(r"\W+", "", word.casefold()) for word in (a, b))
    return bool(left) and left == right


def normalize_cues(cues: list[tuple[float, float, str]]) -> list[dict]:
    """Remove rolling text only at overlapping or contiguous cue boundaries.

    A repeated word in later, separate speech remains intact. We only remove
    an exact whole-word prefix/suffix overlap, and single-word overlap needs
    actual temporal overlap. Equal adjacent duplicate cues are deduplicated.
    """
    segments: list[dict] = []
    previous_tokens: list[str] = []
    previous_start = -1.0
    previous_end = 0.0
    for start, end, text in cues:
        if start < previous_start - 0.001:
            raise CaptionUnavailable("caption cues are out of order")
        tokens = _tokens(text)
        overlap = 0
        near = start <= previous_end + 0.03
        if previous_tokens and near:
            same_text = len(tokens) == len(previous_tokens) and all(
                _same(a, b) for a, b in zip(tokens, previous_tokens)
            )
            if same_text:
                # Separate, repeated speech may reuse the same words. Only
                # collapse an immediately contiguous or overlapping replay.
                overlap = len(tokens) if start <= previous_end + 0.01 else 0
            else:
                for size in range(min(len(previous_tokens), len(tokens)), 0, -1):
                    if size == 1 and start >= previous_end - 0.01:
                        continue
                    if all(_same(a, b) for a, b in zip(previous_tokens[-size:], tokens[:size])):
                        overlap = size
                        break
                # Rolling cues may grow by appending words while keeping their
                # original prefix, rather than repeating the previous suffix.
                if not overlap and len(tokens) > len(previous_tokens) and all(
                    _same(a, b) for a, b in zip(previous_tokens, tokens)
                ):
                    overlap = len(previous_tokens)
        fresh = tokens[overlap:]
        previous_tokens, previous_start, previous_end = tokens, start, end
        if not fresh:
            continue
        # VTT often gives only cue timing. Evenly distribute the new words
        # within the remaining cue interval; Phase 6B later replaces this.
        cue_start = max(start, segments[-1]["end"] if segments else 0.0)
        if end <= cue_start:
            raise CaptionUnavailable("overlapping cues have no usable new timing")
        width = (end - cue_start) / len(fresh)
        words = [{"word": word, "start": round(cue_start + i * width, 3),
                  "end": round(cue_start + (i + 1) * width, 3)}
                 for i, word in enumerate(fresh)]
        segments.append({"id": len(segments), "start": cue_start, "end": end,
                         "text": " ".join(fresh), "words": words})
    return segments


def _language(info: dict) -> str | None:
    raw = info.get("original_language") or info.get("language")
    if isinstance(raw, str) and raw.strip():
        code = raw.casefold().replace("_", "-").split("-", 1)[0]
        if re.fullmatch(r"[a-z]{2,3}", code):
            return code
    # yt-dlp may omit the video language even when YouTube marks the
    # original automatic-caption language explicitly as ``xx-orig``.
    native = {key[:-5] for key in (info.get("automatic_captions") or {})
              if isinstance(key, str) and re.fullmatch(r"[a-z]{2,3}-orig", key)}
    return next(iter(native)) if len(native) == 1 else None


def candidate_tracks(info: dict) -> list[tuple[str, str, dict]]:
    """Native VTT tracks in preference order, never translated tracks."""
    language = _language(info)
    if not language:
        return []
    raw = info.get("original_language") or info.get("language")
    exact = raw.replace("_", "-") if isinstance(raw, str) else ""
    choices = []
    for kind, group in (("youtube_manual", info.get("subtitles") or {}),
                        ("youtube_auto", info.get("automatic_captions") or {})):
        ordered_ids = ((exact, exact.casefold(), language, f"{language}-orig")
                       if kind == "youtube_manual" else
                       (f"{language}-orig", exact, exact.casefold(), language))
        ids = list(dict.fromkeys(ordered_ids))
        for track_id in ids:
            for track in group.get(track_id) or []:
                url = track.get("url", "")
                label = track.get("name", "").casefold()
                if (track.get("ext") == "vtt" and url.startswith("https://") and
                        "tlang=" not in url.casefold() and
                        "translated" not in label and "translation" not in label):
                    choices.append((kind, track_id, track))
    return choices


def select_track(info: dict) -> tuple[str, str, dict] | None:
    """Return the preferred native track, if one exists."""
    return next(iter(candidate_tracks(info)), None)


def validate_caption_transcript(transcript: dict) -> dict:
    segments = transcript["segments"]
    duration = float(transcript.get("duration") or 0)
    words = sum(len(s["words"]) for s in segments)
    if duration <= 0:
        raise CaptionUnavailable("source duration is unavailable for coverage check")
    # This is deliberately permissive of long pauses or non-speech portions,
    # while rejecting a handful of isolated cues masquerading as a sermon.
    if not segments or words < max(8, int(duration / 4)):
        raise CaptionUnavailable("caption transcript is empty or too sparse")
    # Caption retrieval can return a short excerpt. Phase 6A's generous
    # missing-tail rule protects ASR transcripts, so add a caption-specific
    # coverage guard before accepting a YouTube track as the entire sermon.
    allowed_gap = min(max(10, 0.06 * duration), 0.25 * duration)
    if segments[-1]["end"] > duration + 2:
        raise CaptionUnavailable("captions exceed source duration")
    if duration - segments[-1]["end"] > allowed_gap:
        raise CaptionUnavailable("captions miss a substantial source tail")
    previous_end = 0.0
    for segment in segments:
        if segment["start"] - previous_end > allowed_gap:
            raise CaptionUnavailable("captions miss a substantial source interval")
        previous_end = segment["end"]
    report = analyze_transcript(transcript)
    if report["status"] not in {"clean", "warning"}:
        raise CaptionUnavailable("caption transcript failed quality check")
    return report


def acquire(url: str, source: Path) -> dict:
    """Fetch only yt-dlp metadata and one VTT track; never fetch source video."""
    opts = {"quiet": True, "no_warnings": True, "noplaylist": True,
            "skip_download": True, "socket_timeout": 15, "retries": 1,
            "extractor_retries": 1}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        choices = candidate_tracks(info)
        if not choices:
            raise CaptionUnavailable("no native caption track for a known source language")
        duration = float(info.get("duration") or 0)
        if duration <= 0:
            from app.services.transcribe import _probe_duration
            duration = _probe_duration(source)
        failures = []
        for kind, track_id, track in choices:
            try:
                request = Request(track["url"], headers=track.get("http_headers") or
                                  info.get("http_headers") or {})
                with ydl.urlopen(request) as response:
                    vtt = response.read().decode("utf-8-sig")
                acquired_at = dt.datetime.now(dt.timezone.utc).isoformat()
                transcript = {
                    "source": source.name, "duration": duration, "language": _language(info),
                    "language_probability": None, "model": None, "backend": None,
                    "compute_type": None, "created_at": acquired_at,
                    "provenance": {"source": kind, "language": _language(info),
                                   "track_id": track_id,
                                   "track_type": "manual" if kind == "youtube_manual" else "auto",
                                   "acquired_at": acquired_at},
                    "segments": normalize_cues(parse_vtt(vtt)),
                }
                validate_caption_transcript(transcript)
                return transcript
            except Exception as exc:
                reason = str(exc) if isinstance(exc, CaptionUnavailable) else type(exc).__name__
                failures.append(f"{kind}/{track_id}: {reason}")
    raise CaptionUnavailable("native caption tracks unusable (" + ", ".join(failures) + ")")
