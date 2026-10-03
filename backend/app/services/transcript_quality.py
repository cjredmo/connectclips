"""Conservative, read-only checks for obvious transcript corruption."""

from __future__ import annotations

import re
from collections import Counter
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

    # Segment boundaries are an ASR formatting choice. Detect sustained token
    # loops even when the same fragment is split into different segments.
    tokens: list[str] = []
    token_segments: list[int] = []
    for index, text in enumerate(normalized):
        parts = text.split()
        tokens.extend(parts)
        token_segments.extend([index] * len(parts))
    i = 0
    while i < len(tokens):
        best_end = i
        best_period = 0
        for period in range(1, 17):
            if i + max(48, period * 8) > len(tokens):
                continue
            pattern = tokens[i:i + period]
            j = i + period
            while j < len(tokens) and tokens[j] == pattern[(j - i) % period]:
                j += 1
            if j - i >= max(48, period * 8) and j > best_end:
                best_end, best_period = j, period
        if best_period:
            start = float(segments[token_segments[i]].get("start", 0))
            end = float(segments[token_segments[best_end - 1]].get("end", start))
            if end - start >= 30 and not any(
                f["severity"] == "failed" and start < f["end_time"] and end > f["start_time"]
                for f in findings
            ):
                findings.append({
                    "severity": "failed", "start_time": start, "end_time": end,
                    "reason": "repeated_ngram_loop",
                    "evidence": {"tokens": best_end - i,
                                 "repetitions": (best_end - i) // best_period,
                                 "phrase_tokens": best_period},
                })
            i = best_end
            continue
        i += 1

    # A second signal catches imperfect loops with small word substitutions.
    # Require 90 seconds, 120 tokens, very low vocabulary, and a dominant
    # three-word set; short rhetorical repetitions cannot meet these bounds.
    for first in range(len(segments)):
        last = first
        while last < len(segments) and float(segments[last].get("end", 0)) - \
                float(segments[first].get("start", 0)) < 90:
            last += 1
        if last >= len(segments):
            break
        start = float(segments[first].get("start", 0))
        end = float(segments[last].get("end", start))
        if any(f["severity"] == "failed" and start < f["end_time"] and
               end > f["start_time"] for f in findings):
            continue
        sample = [token for text in normalized[first:last + 1] for token in text.split()]
        counts = Counter(sample)
        if len(sample) >= 120 and len(counts) <= 10 and \
                len(counts) / len(sample) <= 0.1 and \
                sum(count for _, count in counts.most_common(3)) / len(sample) >= 0.6:
            # Keep extending only while subsequent segments use the same
            # collapsed vocabulary; stop when normal speech resumes.
            while last + 1 < len(segments):
                following = normalized[last + 1].split()
                if not following or sum(token in counts for token in following) / len(following) < 0.8:
                    break
                last += 1
            end = float(segments[last].get("end", end))
            findings.append({
                "severity": "failed", "start_time": start, "end_time": end,
                "reason": "vocabulary_collapse",
                "evidence": {"tokens": len(sample), "distinct_tokens": len(counts),
                             "top_three_fraction": round(
                                 sum(count for _, count in counts.most_common(3)) / len(sample), 3)},
            })

    # A duration supplied by the media probe lets us flag a substantially
    # missing tail. A shorter outro may be silence, so only a large gap fails.
    duration = transcript.get("duration")
    last_end = float(segments[-1].get("end", 0))
    if isinstance(duration, (int, float)) and duration > 0 and \
            duration - last_end > max(120, 0.12 * duration):
        findings.append({
            "severity": "failed", "start_time": last_end,
            "end_time": float(duration), "reason": "transcript_coverage_gap",
            "evidence": {"gap_seconds": round(duration - last_end, 2)},
        })

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
