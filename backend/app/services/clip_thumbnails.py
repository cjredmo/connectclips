"""Single-frame source thumbnails for clip browsing."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

from app.config import settings


def cache_path(source: Path, clip_index: int, clip_id: str, start: float, end: float) -> Path:
    """A trim, clip replacement, or source change yields a different image."""
    stat = source.stat()
    signature = json.dumps([source.name, stat.st_size, stat.st_mtime_ns,
                            clip_index, clip_id, start, end], separators=(",", ":"))
    digest = hashlib.sha256(signature.encode()).hexdigest()[:20]
    return settings.data_work_dir / source.stem / "clip_thumbnails" / f"{clip_index}-{digest}.jpg"


def thumbnail(source: Path, clip_index: int, clip_id: str, start: float, end: float) -> Path:
    target = cache_path(source, clip_index, clip_id, start, end)
    if target.is_file():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(suffix=".jpg", dir=target.parent)
    os.close(handle)
    tmp = Path(tmp_name)
    try:
        # Accurate seek on a local source; one frame only, no export pipeline.
        position = max(0.0, (start + end) / 2)
        result = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{position:.3f}", "-i", str(source),
            "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", str(tmp),
        ], capture_output=True, timeout=30)
        if result.returncode or not tmp.stat().st_size:
            raise RuntimeError("thumbnail extraction failed")
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    return target
