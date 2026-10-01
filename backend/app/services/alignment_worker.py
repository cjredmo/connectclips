"""WhisperX-only subprocess. Run with an isolated Python interpreter.

Usage: python alignment_worker.py input.json output.json
The main backend never imports WhisperX, torch, or torchaudio.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def main() -> None:
    import whisperx

    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    model_start = time.monotonic()
    model, metadata = whisperx.load_align_model(
        language_code=payload["language"], device=payload["device"],
        model_name=payload["model"], model_dir=payload.get("model_dir") or None,
    )
    model_seconds = time.monotonic() - model_start
    results = []
    for window in payload["windows"]:
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="connectclips-align-") as temp:
            audio_path = Path(temp) / "audio.wav"
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", str(window["audio_start"]), "-i", payload["source"],
                "-t", str(window["audio_end"] - window["audio_start"]),
                "-vn", "-ac", "1", "-ar", "16000", str(audio_path),
            ], check=True, capture_output=True)
            audio = whisperx.load_audio(str(audio_path))
            duration = len(audio) / 16000
            aligned = whisperx.align(
                [{"start": 0.0, "end": duration, "text": window["text"]}],
                model, metadata, audio, payload["device"],
                return_char_alignments=False,
            )
        results.append({"index": window["index"], "seconds": time.monotonic() - started,
                        "word_segments": aligned.get("word_segments", [])})
        Path(sys.argv[2]).write_text(json.dumps({"model_load_seconds": model_seconds,
                                                  "windows": results}), encoding="utf-8")


if __name__ == "__main__":
    main()
