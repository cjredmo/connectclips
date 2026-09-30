"""Conservative, read-only checks for obvious transcript corruption."""

from __future__ import annotations

import re
from difflib import SequenceMatcher


def _normalized(text: str) -> str:
    return " ".join(re.findall(r"\w+", text.casefold()))


def analyze_transcript(transcript: dict) -> dict:
    segments = transcript.get("segments", [])
    findings: list[dict] = []
    if not segments:
        return {"status": "unchecked", "findings": []}

    normalized = [_normalized(s.get("text", "")) for s in segments]
    # A few repeated sentences are ordinary speech. Require a long run and
    # substantial source time before treating repetition as corruption.
    i = 0
    while i < len(segments):
        best_end = i
        best_period = 0
        for period in range(1, 5):
            if i + period * 8 > len(segments):
                continue
            pattern = normalized[i:i + period]
            if not all(pattern) or max(map(len, pattern)) < 12:
                continue
            j = i + period
            while j < len(segments):
                expected = pattern[(j - i) % period]
                actual = normalized[j]
                if actual != expected:
                    # Similarity on short sentences is misleading: changing
                    # a single meaningful word can still score above 0.9.
                    if min(len(actual), len(expected)) < 40 or \
                            SequenceMatcher(None, actual, expected).ratio() < 0.97:
                        break
                j += 1
            if j - i >= period * 8 and j > best_end:
                best_end, best_period = j, period
        if best_period:
            start = float(segments[i].get("start", 0))
            end = float(segments[best_end - 1].get("end", start))
            if end - start >= 20 or best_end - i >= 40:
                findings.append({
                    "severity": "failed", "start_time": start, "end_time": end,
                    "reason": "repeated_phrase_loop",
                    "evidence": {"segments": best_end - i,
                                 "repetitions": (best_end - i) // best_period,
                                 "phrase_segments": best_period},
                })
                i = best_end
                continue
        i += 1

    stalled = 0
    stall_start = 0
    for index in range(1, len(segments)):
        if float(segments[index].get("start", 0)) <= float(segments[index - 1].get("start", 0)):
            if stalled == 0:
                stall_start = index - 1
            stalled += 1
        else:
            if stalled >= 8:
                findings.append({
                    "severity": "warning",
                    "start_time": float(segments[stall_start].get("start", 0)),
                    "end_time": float(segments[index - 1].get("end", 0)),
                    "reason": "timestamps_not_progressing",
                    "evidence": {"segments": stalled + 1},
                })
            stalled = 0
    if stalled >= 8:
        findings.append({
            "severity": "warning",
            "start_time": float(segments[stall_start].get("start", 0)),
            "end_time": float(segments[-1].get("end", 0)),
            "reason": "timestamps_not_progressing",
            "evidence": {"segments": stalled + 1},
        })
    status = "failed" if any(f["severity"] == "failed" for f in findings) else (
        "warning" if findings else "clean")
    return {"status": status, "findings": findings}
