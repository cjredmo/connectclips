"""SQLite-backed job store with serialized async execution.

Job records (everything the UI calls "activity") live in
``<data_work_dir>/connectclips.db`` so they survive restarts. Work products
(transcripts, downloaded videos, exported MP4s) keep being written to disk by
the underlying services — those are the source of truth for *content*; the
DB is the source of truth for *who/when/what triggered*.

Main job kinds:
  - "transcribe": accepts usable native YouTube captions or runs the configured
    local ASR backend on a file in sources/. Serialized with other transcript jobs.
  - "youtube_download": runs yt-dlp to fetch a video into sources/. Network /
    disk bound; runs without a lock.
  - "select_clips": sends an existing transcript to Claude and writes a
    clips.json with candidate short-form moments. Network bound; no lock.
  - "export_clip": reframes one clip from clips.json to vertical 9:16 with
    face tracking + NVENC encode. CPU + GPU; not under the Whisper lock
    because NVENC and CUDA inference don't contend on this card.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import threading
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

from app import db
from app.config import settings
from app.services import alignment_runner, captions, caption_styles, clip_precision, clip_selection, ingest, reframe, transcribe, transcript_alignment, transcript_repairs, transcript_repair_runner, youtube_captions

logger = logging.getLogger(__name__)

JobKind = Literal["transcribe", "repair_transcript", "align_transcript", "prepare_clip", "youtube_download", "select_clips", "export_clip", "upload", "prescan_faces"]
JobStatus = Literal["queued", "running", "done", "failed"]

_JOB_COLUMNS = (
    "id", "kind", "status", "source", "transcript_path", "url",
    "ingested_filename", "clips_path", "clip_index", "clip_id", "start", "end",
    "output_clip_path", "identity_id", "user_login", "user_name",
    "progress_percent", "progress_message", "clips_version",
    "caption_style_id", "caption_style_name", "caption_style_revision",
    "caption_style_hash", "caption_style_descriptor",
    "created_at", "started_at", "finished_at", "error",
)


@dataclass
class Job:
    id: str
    kind: JobKind
    status: JobStatus = "queued"
    # transcribe fields
    source: str | None = None
    transcript_path: str | None = None
    # youtube_download fields
    url: str | None = None
    ingested_filename: str | None = None
    # select_clips fields
    clips_path: str | None = None
    # export_clip fields
    clip_index: int | None = None
    clip_id: str | None = None
    start: float | None = None
    end: float | None = None
    output_clip_path: str | None = None
    # Per-clip identity selection — which face track to follow during reframe.
    # NULL means "auto" (highest-score live face), the right default for the
    # one-pastor-on-screen case. UI sets this only when scan revealed >1
    # identities and the volunteer picked one.
    identity_id: int | None = None
    # The clips.json `clips_version` UUID this export was built against. Lets
    # the UI distinguish "current" exports (clips_version matches current
    # clips.json) from "stale" exports made before clips.json was regenerated.
    # NULL for export jobs predating this column, and for non-export kinds.
    clips_version: str | None = None
    caption_style_id: str | None = None
    caption_style_name: str | None = None
    caption_style_revision: int | None = None
    caption_style_hash: str | None = None
    caption_style_descriptor: str | None = None
    # who triggered this — populated from Tailscale identity headers when present
    user_login: str | None = None
    user_name: str | None = None
    # progress within a running job (export_clip currently; could extend to others)
    progress_percent: float | None = None
    progress_message: str | None = None
    # common
    created_at: str = field(default_factory=lambda: dt.datetime.now(dt.timezone.utc).isoformat())
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None


_gpu_lock = asyncio.Lock()
_prepare_lock = threading.Lock()


# ---------- DB I/O ----------------------------------------------------------

def _row_to_job(row) -> Job:
    return Job(**{c: row[c] for c in _JOB_COLUMNS})


def _save(job: Job) -> None:
    """UPSERT the job row. Called every time a field mutates."""
    cols = ",".join(_JOB_COLUMNS)
    placeholders = ",".join(f":{c}" for c in _JOB_COLUMNS)
    updates = ",".join(f"{c}=excluded.{c}" for c in _JOB_COLUMNS if c != "id")
    sql = f"INSERT INTO jobs ({cols}) VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {updates}"
    payload = asdict(job)
    with db.cursor() as cur:
        cur.execute(sql, payload)


def list_jobs(limit: int = 200) -> list[Job]:
    with db.cursor() as cur:
        rows = cur.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [_row_to_job(r) for r in rows]


def get_job(job_id: str) -> Job | None:
    with db.cursor() as cur:
        row = cur.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return _row_to_job(row) if row else None


def list_recent_for_source(source: str, limit: int = 50) -> list[Job]:
    with db.cursor() as cur:
        rows = cur.execute(
            "SELECT * FROM jobs WHERE source = ? ORDER BY created_at DESC LIMIT ?",
            (source, limit),
        ).fetchall()
    return [_row_to_job(r) for r in rows]


def latest_export_for_clip(source: str, clip_index: int) -> Job | None:
    """Most recent successful export_clip job for this (source, clip_index)."""
    with db.cursor() as cur:
        row = cur.execute(
            """
            SELECT * FROM jobs
            WHERE kind = 'export_clip'
              AND status = 'done'
              AND source = ?
              AND clip_index = ?
            ORDER BY finished_at DESC
            LIMIT 1
            """,
            (source, clip_index),
        ).fetchone()
    return _row_to_job(row) if row else None


def job_dict(job: Job) -> dict:
    return asdict(job)


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


# ---------- Job creation ----------------------------------------------------

def _new_job(**kwargs) -> Job:
    """Create a Job, persist it, return it. user_login/user_name expected via kwargs."""
    job = Job(id=_new_id(), **kwargs)
    _save(job)
    return job


def create_transcribe_job(source_name: str, *, youtube_url: str | None = None,
                          user_login: str | None = None, user_name: str | None = None) -> Job:
    src = settings.data_sources_dir / source_name
    if not src.is_file():
        raise FileNotFoundError(f"source not found: {source_name}")
    if transcribe.transcript_path_for(source_name).exists():
        raise ValueError("raw transcript already exists and is immutable")
    # A downloaded video's original URL is in the durable download job. This
    # also supports an explicit transcribe action after a server restart.
    if youtube_url is None:
        with db.cursor() as cur:
            row = cur.execute(
                "SELECT url FROM jobs WHERE kind = 'youtube_download' AND status = 'done' "
                "AND ingested_filename = ? ORDER BY finished_at DESC LIMIT 1", (source_name,),
            ).fetchone()
        youtube_url = row["url"] if row else None
    job = _new_job(kind="transcribe", source=source_name, url=youtube_url,
                   user_login=user_login, user_name=user_name)
    asyncio.create_task(_run_transcribe(job, src))
    return job


def create_repair_job(source_name: str, *,
                      user_login: str | None = None, user_name: str | None = None) -> Job:
    if source_name in ("", ".", "..") or "/" in source_name or "\\" in source_name:
        raise ValueError("invalid source name")
    src = settings.data_sources_dir / source_name
    path = transcribe.transcript_path_for(source_name)
    if not src.is_file() or not path.is_file():
        raise FileNotFoundError("source and raw transcript are required for repair")
    with db.cursor() as cur:
        active = cur.execute(
            "SELECT 1 FROM jobs WHERE kind = 'repair_transcript' AND source = ? "
            "AND status IN ('queued', 'running') LIMIT 1", (source_name,),
        ).fetchone()
    if active:
        raise ValueError("transcript repair is already running")
    job = _new_job(kind="repair_transcript", source=source_name,
                   user_login=user_login, user_name=user_name)
    asyncio.create_task(_run_repair(job, src, path))
    return job


def create_alignment_job(source_name: str, *,
                         user_login: str | None = None, user_name: str | None = None) -> Job:
    if source_name in ("", ".", "..") or "/" in source_name or "\\" in source_name:
        raise ValueError("invalid source name")
    src = settings.data_sources_dir / source_name
    path = transcribe.transcript_path_for(source_name)
    if not src.is_file() or not path.is_file():
        raise FileNotFoundError("source and effective transcript are required for alignment")
    if not settings.alignment_python or not Path(settings.alignment_python).is_file():
        raise ValueError("configure an isolated WhisperX interpreter before alignment")
    quality = transcript_repairs.transcript_status(path)
    if quality["effective_quality"]["status"] == "failed" or quality["human_review_required"]:
        raise ValueError("effective transcript requires repair or review before alignment")
    with db.cursor() as cur:
        active = cur.execute(
            "SELECT 1 FROM jobs WHERE kind = 'align_transcript' AND source = ? "
            "AND status IN ('queued', 'running') LIMIT 1", (source_name,),
        ).fetchone()
    if active:
        raise ValueError("alignment is already running")
    job = _new_job(kind="align_transcript", source=source_name,
                   user_login=user_login, user_name=user_name)
    asyncio.create_task(_run_alignment(job, src, path))
    return job


def create_upload_job(
    filename: str,
    *,
    user_login: str | None = None,
    user_name: str | None = None,
) -> Job:
    """Track an in-progress browser upload as a Job. The actual file save
    happens via the /sermons/upload route; this just gives the activity log
    a 'running' row from the moment the upload starts."""
    job = _new_job(kind="upload", source=filename, user_login=user_login, user_name=user_name)
    job.status = "running"
    job.started_at = dt.datetime.now(dt.timezone.utc).isoformat()
    _save(job)
    return job


def finish_upload_job(job_id: str, *, error: str | None = None) -> Job | None:
    job = get_job(job_id)
    if job is None or job.kind != "upload":
        return None
    _finish(job, error=error)
    return job


def create_youtube_download_job(url: str, *, user_login: str | None = None, user_name: str | None = None) -> Job:
    job = _new_job(kind="youtube_download", url=url, user_login=user_login, user_name=user_name)
    asyncio.create_task(_run_youtube(job, url))
    return job


def create_prescan_job(
    source_name: str,
    *,
    user_login: str | None = None,
    user_name: str | None = None,
) -> Job:
    src = settings.data_sources_dir / source_name
    if not src.is_file():
        raise FileNotFoundError(f"source not found: {source_name}")
    job = _new_job(kind="prescan_faces", source=source_name, user_login=user_login, user_name=user_name)
    asyncio.create_task(_run_prescan(job, src))
    return job


def create_select_clips_job(
    source_name: str,
    num_clips_min: int = 3,
    num_clips_max: int = 8,
    *,
    user_login: str | None = None,
    user_name: str | None = None,
) -> Job:
    if num_clips_min < 1 or num_clips_max < num_clips_min:
        raise ValueError(
            f"invalid clip-count range: min={num_clips_min}, max={num_clips_max}"
        )
    transcript_path = transcribe.transcript_path_for(source_name)
    if not transcript_path.is_file():
        raise FileNotFoundError(f"transcript not found for {source_name} (run transcribe first)")
    _ensure_transcript_selectable(transcript_path)
    job = _new_job(
        kind="select_clips", source=source_name,
        user_login=user_login, user_name=user_name,
    )
    asyncio.create_task(_run_select_clips(job, transcript_path, num_clips_min, num_clips_max))
    return job


def latest_preparation(source_name: str, clip_id: str) -> Job | None:
    with db.cursor() as cur:
        row = cur.execute(
            "SELECT * FROM jobs WHERE kind = 'prepare_clip' AND source = ? AND clip_id = ? "
            "ORDER BY created_at DESC, rowid DESC LIMIT 1", (source_name, clip_id),
        ).fetchone()
    return _row_to_job(row) if row else None


def preparation_status(source_name: str, clip_id: str, start: float, end: float) -> dict:
    assessed = clip_precision.assess(source_name, clip_id, start, end)
    if assessed["status"] in {"ready", "needs_review"}:
        return {"status": assessed["status"], "reason": assessed.get("reason"),
                "revision": assessed.get("artifact", {}).get("prepared_at")}
    latest = latest_preparation(source_name, clip_id)
    if latest and latest.status in {"queued", "running"}:
        return {"status": "preparing", "reason": None, "job_id": latest.id}
    if latest and latest.status == "failed":
        return {"status": "failed", "reason": "preparation_failed", "job_id": latest.id}
    return {"status": assessed["status"], "reason": assessed.get("reason")}


def create_prepare_clip_job(source_name: str, clip_id: str, *, force: bool = False,
                            user_login: str | None = None,
                            user_name: str | None = None) -> Job | None:
    """Schedule after durable clip write. One active job per stable clip ID."""
    clip_precision.artifact_path(source_name, clip_id)
    src = settings.data_sources_dir / source_name
    path = transcribe.transcript_path_for(source_name)
    if not src.is_file() or not path.is_file():
        raise FileNotFoundError("source and effective transcript are required")
    index, start, end = clip_precision.current_clip(source_name, clip_id)
    with _prepare_lock:
        assessed = clip_precision.assess(source_name, clip_id, start, end, path)
        if assessed["status"] == "ready" and not force:
            return None
        latest = latest_preparation(source_name, clip_id)
        if latest and latest.status in {"queued", "running"}:
            return latest
        # A failure stays actionable rather than spawning work on every trim
        # autosave. Explicit Retry is the only way to repeat failed inference.
        if latest and latest.status == "failed" and not force:
            return None
        job = _new_job(kind="prepare_clip", source=source_name, clip_id=clip_id,
                       clip_index=index, start=start, end=end,
                       user_login=user_login, user_name=user_name)
        asyncio.create_task(_run_prepare_clip(job))
        return job


def schedule_saved_clip(source_name: str, clip_id: str, *,
                        user_login: str | None = None,
                        user_name: str | None = None) -> Job | None:
    """Keep a durable clip when its background work cannot be scheduled."""
    try:
        return create_prepare_clip_job(source_name, clip_id,
                                       user_login=user_login, user_name=user_name)
    except Exception as exc:
        latest = latest_preparation(source_name, clip_id)
        if latest and latest.status in {"queued", "running", "failed"}:
            return latest
        job = _new_job(kind="prepare_clip", source=source_name, clip_id=clip_id,
                       user_login=user_login, user_name=user_name)
        job.progress_message = "Clip preparation could not start"
        _finish(job, f"{type(exc).__name__}: {exc}")
        return job


def resume_queued_preparations() -> None:
    """Restore background clip work after an application restart."""
    with db.cursor() as cur:
        rows = cur.execute(
            "SELECT * FROM jobs WHERE kind = 'prepare_clip' AND status IN ('queued', 'running') "
            "ORDER BY created_at"
        ).fetchall()
    for row in rows:
        job = _row_to_job(row)
        job.status = "queued"
        job.started_at = None
        job.progress_message = "Waiting to prepare clip"
        _save(job)
        asyncio.create_task(_run_prepare_clip(job))


def _ensure_transcript_selectable(transcript_path: Path) -> None:
    status = transcript_repairs.transcript_status(transcript_path)
    if status["effective_quality"]["status"] not in {"clean", "warning"} or status["human_review_required"]:
        raise ValueError("transcript quality requires repair or human review before clip selection")


def create_export_clip_job(
    source_name: str,
    clip_index: int,
    *,
    start_override: float | None = None,
    end_override: float | None = None,
    caption_style: str | None = None,
    caption_margin_v: int | None = None,
    include_hook_title: bool = True,
    identity_id: int | None = None,
    zoom_level: str | None = None,
    lock_camera: bool = False,
    user_login: str | None = None,
    user_name: str | None = None,
) -> Job:
    resolved_style, style_snapshot = caption_styles.snapshot(caption_style)
    src = settings.data_sources_dir / source_name
    if not src.is_file():
        raise FileNotFoundError(f"source not found: {source_name}")
    clips_path = clip_selection.clips_path_for(source_name)
    if not clips_path.is_file():
        raise FileNotFoundError(f"clips.json not found for {source_name} (run select-clips first)")
    clips_data = json.loads(clips_path.read_text())
    if not (0 <= clip_index < len(clips_data["clips"])):
        raise ValueError(f"clip_index {clip_index} out of range (0..{len(clips_data['clips'])-1})")
    clip = clips_data["clips"][clip_index]
    clip_for_identity = dict(clip)
    from app.services import clip_metadata
    clip_metadata.normalize_for_display(clip_for_identity, source_name,
                                        clips_data.get("clips_version"), clip_index)
    start = float(start_override) if start_override is not None else float(clip["start"])
    end = float(end_override) if end_override is not None else float(clip["end"])
    if end <= start:
        raise ValueError(f"end ({end}) must be greater than start ({start})")
    transcript_path = transcribe.transcript_path_for(source_name)
    # Versioned output filename: <stem>-clip-<index>-v<version_short>.mp4. Lets
    # successive exports of the same clip-index across clips.json regenerations
    # coexist on disk (otherwise re-running Pick clips destroys old exports).
    # clips_version may be missing for clips.json files predating this feature;
    # fall back to "legacy" so those still produce a deterministic filename.
    clips_version = clips_data.get("clips_version") or "legacy"
    version_short = clips_version[:8]
    style_suffix = (f"-r{style_snapshot['revision']}-s{style_snapshot['hash'][:8]}"
                    if style_snapshot["revision"] is not None else "")
    output_name = f"{Path(source_name).stem}-clip-{clip_index}-v{version_short}{style_suffix}.mp4"
    hook_title = clip.get("title") if include_hook_title else None
    job = _new_job(
        kind="export_clip", source=source_name,
        clip_index=clip_index, clip_id=clip_for_identity["id"], start=start, end=end,
        clips_version=clips_version,
        caption_style_id=style_snapshot["id"],
        caption_style_name=style_snapshot["name"],
        caption_style_revision=style_snapshot["revision"],
        caption_style_hash=style_snapshot["hash"],
        caption_style_descriptor=json.dumps(style_snapshot["descriptor"], sort_keys=True),
        identity_id=identity_id,
        user_login=user_login, user_name=user_name,
    )
    asyncio.create_task(_run_export_clip(
        job, src, output_name,
        transcript_path if transcript_path.is_file() else None,
        resolved_style,
        hook_title,
        caption_margin_v,
        identity_id,
        zoom_level,
        lock_camera,
        clip_for_identity["id"],
    ))
    return job


# ---------- Lifecycle helpers ----------------------------------------------

async def _start(job: Job) -> None:
    job.status = "running"
    job.started_at = dt.datetime.now(dt.timezone.utc).isoformat()
    _save(job)


def _finish(job: Job, error: str | None = None) -> None:
    job.error = error
    job.status = "failed" if error else "done"
    job.finished_at = dt.datetime.now(dt.timezone.utc).isoformat()
    _save(job)


# ---------- Runners ---------------------------------------------------------

async def _run_transcribe(job: Job, src: Path) -> None:
    async with _gpu_lock:
        await _start(job)
        # Throttled progress: persist at most twice per second; runner updates the
        # in-memory Job and writes the row, History view picks it up on its 5s poll.
        import time
        last = 0.0

        def progress_cb(message: str, percent: float) -> None:
            nonlocal last
            now = time.monotonic()
            if now - last < 0.5 and percent < 1.0:
                return
            last = now
            job.progress_message = message
            job.progress_percent = max(0.0, min(1.0, percent))
            _save(job)

        try:
            transcript = None
            if job.url:
                job.progress_message = "Fetching YouTube transcript"
                job.progress_percent = 0.0
                _save(job)
                try:
                    transcript = await asyncio.to_thread(youtube_captions.acquire, job.url, src)
                except Exception as exc:
                    # Subtitle availability, retrieval, parsing and QC all
                    # lead to the same configured local-ASR fallback.
                    logger.warning("YouTube captions unavailable for %s: %s", src.name, exc)
            if transcript is None:
                job.progress_message = "Transcribing sermon"
                job.progress_percent = 0.0
                _save(job)
                transcript = await asyncio.to_thread(transcribe.transcribe_file, src, progress_cb)
                transcript["provenance"] = {
                    "source": "local_asr", "language": transcript.get("language"),
                    "backend": transcript.get("backend"), "model": transcript.get("model"),
                    "acquired_at": transcript.get("created_at"),
                }
            out = await asyncio.to_thread(transcribe.write_transcript, transcript)
            job.transcript_path = str(out)
            job.progress_message = "Checking transcript"
            _save(job)
            status = await asyncio.to_thread(transcript_repairs.transcript_status, out)
            needs_repair = (status["raw_quality"]["status"] == "failed" and
                            status["effective_quality"]["status"] == "failed")
            job.progress_percent = 1.0
            job.progress_message = ("Repairing transcript" if needs_repair else
                                    "Transcript needs review" if status["human_review_required"] or
                                    status["effective_quality"]["status"] == "unchecked" else
                                    "Transcript ready")
            _save(job)
            _finish(job)
        except Exception as exc:
            _finish(job, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")
            return
    # Only failed QC can chain a bounded repair. Face prescan stays independent.
    if job.source:
        if needs_repair:
            try:
                create_repair_job(job.source, user_login=job.user_login,
                                  user_name=job.user_name)
            except Exception as exc:
                job.progress_message = "Transcript needs review"
                _finish(job, f"Automatic transcript repair could not start: {type(exc).__name__}: {exc}")
        _maybe_chain_prescan(job.source, user_login=job.user_login, user_name=job.user_name)


async def _run_repair(job: Job, src: Path, transcript_path: Path) -> None:
    async with _gpu_lock:
        await _start(job)

        def progress_cb(message: str, percent: float) -> None:
            job.progress_message = message
            job.progress_percent = max(0.0, min(1.0, percent))
            _save(job)

        try:
            status = await asyncio.to_thread(
                transcript_repair_runner.repair_transcript, src, transcript_path, progress_cb,
            )
            if status["human_review_required"]:
                job.progress_message = "Transcript needs review"
                _finish(job, "Transcript repair requires human review")
                return
            job.progress_percent = 1.0
            job.progress_message = "Transcript ready"
            _save(job)
            _finish(job)
        except Exception as exc:
            _finish(job, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")
            return


async def _run_alignment(job: Job, src: Path, transcript_path: Path) -> None:
    async with _gpu_lock:
        await _start(job)

        def progress_cb(message: str, percent: float) -> None:
            job.progress_message = message
            job.progress_percent = max(0.0, min(1.0, percent))
            _save(job)

        try:
            await asyncio.to_thread(alignment_runner.align_transcript, src, transcript_path,
                                    progress_cb=progress_cb)
            if not transcript_alignment.status(transcript_path)["acceptable"]:
                raise transcript_alignment.AlignmentError("alignment requires review")
            _finish(job)
        except Exception as exc:
            _finish(job, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")
            return


async def _run_prepare_clip(job: Job) -> None:
    async with _gpu_lock:
        await _start(job)

        def progress_cb(message: str, percent: float) -> None:
            job.progress_message = message
            job.progress_percent = max(0.0, min(1.0, percent))
            _save(job)

        try:
            index, start, end = clip_precision.current_clip(job.source, job.clip_id)
            job.clip_index, job.start, job.end = index, start, end
            _save(job)
            await asyncio.to_thread(clip_precision.prepare, job.source, job.clip_id,
                                    start, end, progress_cb)
            job.progress_percent = 1.0
            job.progress_message = "Clip ready"
            _finish(job)
        except Exception as exc:
            job.progress_message = "Clip preparation failed"
            _finish(job, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")
            return
    # A queued job reads the newest trim when it starts. If the trim extended
    # again while inference ran, schedule one follow-up after the lock releases.
    try:
        _, latest_start, latest_end = clip_precision.current_clip(job.source, job.clip_id)
        if clip_precision.assess(job.source, job.clip_id, latest_start, latest_end)["status"] == "stale":
            create_prepare_clip_job(job.source, job.clip_id)
    except (OSError, ValueError):
        pass


async def _run_youtube(job: Job, url: str) -> None:
    await _start(job)

    import time
    last = 0.0

    def progress_cb(message: str, percent: float) -> None:
        # Throttle to ~2 updates/s -- yt-dlp fires the hook on every chunk
        # which would thrash the JSON job-state file otherwise.
        nonlocal last
        now = time.monotonic()
        if now - last < 0.5 and percent < 1.0:
            return
        last = now
        job.progress_message = message
        job.progress_percent = max(0.0, min(1.0, percent))
        _save(job)

    try:
        out = await asyncio.to_thread(
            ingest.download_youtube, url, settings.data_sources_dir, progress_cb,
        )
        job.ingested_filename = out.name
        job.progress_percent = 1.0
        job.progress_message = "Done"
        _save(job)
        _finish(job)
        # Auto-chain to transcribe so the volunteer doesn't have to babysit the pipeline.
        _maybe_chain_transcribe(out.name, youtube_url=url,
                                user_login=job.user_login, user_name=job.user_name)
    except Exception as exc:
        _finish(job, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")


async def _run_prescan(job: Job, src: Path) -> None:
    """Whole-source face/cut/identity scan. Doesn't take the GPU lock —
    YuNet uses ~300 MB on the 3060 Ti and coexists fine with int8 Whisper."""
    await _start(job)

    import time
    last = 0.0

    def progress_cb(message: str, percent: float) -> None:
        nonlocal last
        now = time.monotonic()
        if now - last < 0.5 and percent < 1.0:
            return
        last = now
        job.progress_message = message
        job.progress_percent = max(0.0, min(1.0, percent))
        _save(job)

    try:
        await asyncio.to_thread(reframe.scan_source, src, progress_cb)
        job.progress_percent = 1.0
        job.progress_message = "Done"
        _save(job)
        _finish(job)
    except Exception as exc:
        _finish(job, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")


async def _run_select_clips(
    job: Job,
    transcript_path: Path,
    num_clips_min: int,
    num_clips_max: int,
) -> None:
    await _start(job)
    try:
        _ensure_transcript_selectable(transcript_path)
        # No streaming progress for select_clips — it's one Anthropic call.
        # Set a message so the UI can render something more useful than
        # just "running" while we wait the ~30 s for Claude to respond.
        job.progress_message = f"Calling Claude ({settings.claude_model})…"
        _save(job)

        result = await asyncio.to_thread(
            clip_selection.select_clips, transcript_path, num_clips_min, num_clips_max,
        )
        out = await asyncio.to_thread(clip_selection.write_clips, result)
        job.clips_path = str(out)
        job.progress_message = "Done"
        job.progress_percent = 1.0
        _save(job)
        _finish(job)
    except Exception as exc:
        _finish(job, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")
        return
    # The selection result is durable. A preparation problem must not change
    # its successful status or discard any selected clip.
    try:
        for clip in json.loads(out.read_text(encoding="utf-8"))["clips"]:
            if clip.get("id"):
                schedule_saved_clip(job.source, clip["id"],
                                    user_login=job.user_login, user_name=job.user_name)
    except (OSError, ValueError, KeyError, TypeError):
        pass


# ---------- Auto-pipeline chaining --------------------------------------


def _maybe_chain_transcribe(source_name: str, *, youtube_url: str | None = None,
                            user_login: str | None = None, user_name: str | None = None) -> None:
    """Trigger transcribe iff the source exists and isn't already transcribed."""
    src = settings.data_sources_dir / source_name
    if not src.is_file():
        return
    if transcribe.transcript_path_for(source_name).exists():
        return
    try:
        create_transcribe_job(source_name, youtube_url=youtube_url,
                              user_login=user_login, user_name=user_name)
    except Exception:
        # Auto-chain is best-effort — never fail the parent job because the next stage couldn't start.
        pass


def _maybe_chain_prescan(source_name: str, *, user_login: str | None = None, user_name: str | None = None) -> None:
    """Trigger a face prescan iff the source exists and source_scan.json doesn't.

    Also skips if a prescan job for this source is already queued or running —
    avoids duplicate scans when a volunteer triggers a manual transcribe of
    a source that already had a prescan kicked off."""
    src = settings.data_sources_dir / source_name
    if not src.is_file():
        return
    if reframe.has_source_scan(src):
        return
    with db.cursor() as cur:
        row = cur.execute(
            """
            SELECT 1 FROM jobs
            WHERE kind = 'prescan_faces' AND source = ? AND status IN ('queued', 'running')
            LIMIT 1
            """,
            (source_name,),
        ).fetchone()
    if row is not None:
        return
    try:
        create_prescan_job(source_name, user_login=user_login, user_name=user_name)
    except Exception:
        pass


async def _run_export_clip(
    job: Job, src: Path, output_name: str,
    transcript_path: Path | None, caption_style: captions.CaptionStyle | None = None,
    hook_title: str | None = None,
    caption_margin_v: int | None = None,
    identity_id: int | None = None,
    zoom_level: str | None = None,
    lock_camera: bool = False,
    clip_id: str | None = None,
) -> None:
    await _start(job)

    # Throttled progress callback. Persists at most twice per second so we
    # don't hammer SQLite while a thousand-frame loop fires updates.
    import time
    last = 0.0

    def progress_cb(message: str, percent: float) -> None:
        nonlocal last
        now = time.monotonic()
        if now - last < 0.5 and percent < 1.0:
            return
        last = now
        job.progress_message = message
        job.progress_percent = max(0.0, min(1.0, percent))
        _save(job)

    try:
        result = await asyncio.to_thread(
            reframe.export_clip, src, job.start, job.end, output_name, transcript_path,
            progress_cb, caption_style, hook_title, caption_margin_v, identity_id,
            zoom_level, lock_camera, clip_id,
        )
        job.output_clip_path = result["output"]
        job.progress_percent = 1.0
        job.progress_message = "Done"
        _save(job)
        _finish(job)
    except Exception as exc:
        _finish(job, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")
