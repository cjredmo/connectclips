"""Child-process entry point for native repair inference.

A whisper.cpp native crash must fail one repair attempt, not the API server.
One child process stays alive across the bounded windows of an attempt so the
model is loaded once. Requests and results are JSON lines over standard I/O.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app.services.transcript_repair_runner import _transcribe_audio


def main() -> int:
    backend = sys.argv[1]
    model = sys.argv[2]
    for line in sys.stdin:
        try:
            request = json.loads(line)
            words = _transcribe_audio(Path(request["audio"]), backend, model)
            result = {"words": words}
        except Exception as exc:
            result = {"error": type(exc).__name__}
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
