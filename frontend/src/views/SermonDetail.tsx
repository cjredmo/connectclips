import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Clip, ClipsFile, Job, Sermon, TranscriptStatus } from '../types'
import { TranscriptEditor } from './TranscriptEditor'
import { manualClipDuration, parseManualClipTime, submitManualClipInputs } from '../manualClipTime'
import { clipDetailSections, importResultMessage, parseClipImportText } from '../clipImport'
import type { ImportPreview } from '../clipImport'

type Props = {
  sermon: Sermon
  admin: boolean
  onBack: () => void
  onTrim: (clip: Clip, clipIndex: number) => void
  onDeleted: () => void
}

function fmtSecs(s: number): string {
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(1)
  return `${m}:${sec.padStart(4, '0')}`
}

function fmtRelTime(iso: string | null): string {
  if (!iso) return ''
  const dt = new Date(iso).getTime()
  const ms = Date.now() - dt
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function jobLabel(j: Job): string {
  const kind = j.kind.replace('_', ' ')
  if (j.status === 'failed') return `${kind} failed: ${(j.error ?? '').split('\n')[0]}`
  if (j.status === 'running') return `${kind} running…`
  if (j.status === 'queued') return `${kind} queued`
  return `${kind} done`
}

function JobProgress({ job }: { job: Job | undefined }) {
  if (!job) return null
  if (job.status !== 'running' && job.status !== 'queued') return null
  const hasPercent = typeof job.progress_percent === 'number'
  return (
    <div className="status-progress">
      {/* HTML5 `<progress>` renders an animated indeterminate bar when no
          value attribute is set — used here for jobs (like select_clips)
          that don't expose a percentage during their single API call. */}
      {hasPercent ? (
        <progress value={job.progress_percent ?? 0} max={1} />
      ) : (
        <progress />
      )}
      {hasPercent && (
        <span className="status-progress-pct">
          {Math.round((job.progress_percent ?? 0) * 100)}%
        </span>
      )}
      {job.progress_message && (
        <div className="status-progress-msg muted small">{job.progress_message}</div>
      )}
    </div>
  )
}

function hookScoreClass(score: number): string {
  if (score >= 85) return 'high'
  if (score >= 70) return 'good'
  if (score >= 55) return 'med'
  return 'low'
}

export function SermonDetail({ sermon, admin, onBack, onTrim, onDeleted }: Props) {
  const [clips, setClips] = useState<ClipsFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeJobs, setActiveJobs] = useState<Job[]>([])
  const [transcriptStatus, setTranscriptStatus] = useState<TranscriptStatus | null>(null)
  const [reviewTranscript, setReviewTranscript] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [minClips, setMinClips] = useState(3)
  const [maxClips, setMaxClips] = useState(8)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualTitle, setManualTitle] = useState('')
  const [manualStart, setManualStart] = useState('')
  const [manualEnd, setManualEnd] = useState('')
  const [manualBusy, setManualBusy] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  // Full-sermon YouTube URL drives the "watch from this moment" deep link in
  // the Publish view. Stored as a sidecar per sermon; admin edits it once
  // per sermon and volunteers consume the resulting deep link.
  const [programUrl, setProgramUrl] = useState<string>('')
  const [programVideoId, setProgramVideoId] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [urlSaving, setUrlSaving] = useState(false)

  const refreshClips = useCallback(() => {
    if (!sermon.clips_selected) {
      setClips(null)
      return
    }
    api.getClips(sermon.name).then(setClips).catch((e) => setError(String(e)))
  }, [sermon.name, sermon.clips_selected])

  useEffect(() => {
    refreshClips()
  }, [refreshClips])

  // Load the per-sermon meta once. The URL is read here for both admin
  // (to populate the edit field) and non-admin (so we can display the
  // current setting read-only or hide it if unset).
  useEffect(() => {
    let cancelled = false
    api.getSermonMeta(sermon.name).then((m) => {
      if (cancelled) return
      setProgramUrl(m.program_video_url ?? '')
      setProgramVideoId(m.program_video_id ?? null)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [sermon.name])

  useEffect(() => {
    if (!sermon.transcribed) return
    let cancelled = false
    const refresh = () => api.getTranscriptStatus(sermon.name)
      .then(status => { if (!cancelled) setTranscriptStatus(status) })
      .catch(() => {})
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [sermon.name, sermon.transcribed])

  const saveProgramUrl = async (raw: string) => {
    const trimmed = raw.trim()
    setUrlError(null)
    setUrlSaving(true)
    try {
      const m = await api.saveSermonMeta(sermon.name, { program_video_url: trimmed || null })
      setProgramUrl(m.program_video_url ?? '')
      setProgramVideoId(m.program_video_id ?? null)
    } catch (err) {
      setUrlError(String(err))
    } finally {
      setUrlSaving(false)
    }
  }

  // Poll relevant jobs every 2s while any are active for this sermon
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const jobs = await api.listJobs()
        if (cancelled) return
        const mine = jobs.filter((j) => j.source === sermon.name)
        setActiveJobs(mine)
        // If anything just finished, refresh clips
        if (mine.some((j) => j.status === 'done' && j.kind !== 'transcribe')) {
          refreshClips()
        }
      } catch {}
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sermon.name, refreshClips])

  const runningKinds = new Set(
    activeJobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.kind),
  )
  const recentJobsFor = (kind: string) =>
    activeJobs.filter((j) => j.kind === kind).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]

  const transcribeJob = recentJobsFor('transcribe')
  const selectJob = recentJobsFor('select_clips')
  const prescanJob = recentJobsFor('prescan_faces')
  const repairJob = recentJobsFor('repair_transcript')
  const alignmentJob = recentJobsFor('align_transcript')

  const onTranscribe = () => api.startTranscribe(sermon.name).catch((e) => setError(String(e)))
  const onSelectClips = () =>
    api.startSelectClips(sermon.name, minClips, maxClips).catch((e) => setError(String(e)))
  const onCreateManualClip = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setManualError(null)
    setManualBusy(true)
    try {
      const created = await submitManualClipInputs(manualTitle, manualStart, manualEnd,
        payload => api.createManualClip(sermon.name, payload))
      onTrim(created.clip, created.clip_index)
    } catch (e) { setManualError(String(e instanceof Error ? e.message : e)) }
    finally { setManualBusy(false) }
  }
  const manualStartSeconds = parseManualClipTime(manualStart)
  const manualEndSeconds = parseManualClipTime(manualEnd)
  const onImportFile = async (file: File | undefined) => {
    setImportPreview(null)
    setImportError(null)
    setImportMessage(null)
    if (!file) return
    try { setImportPreview(parseClipImportText(await file.text())) }
    catch (e) { setImportError(String(e instanceof Error ? e.message : e)) }
  }
  const onImportClips = async () => {
    if (!importPreview) return
    setImportBusy(true)
    setImportError(null)
    try {
      const result = await api.importClipJson(sermon.name, importPreview.document)
      setClips(await api.getClips(sermon.name))
      setImportMessage(importResultMessage(result.imported, result.duplicates_skipped))
      setImportPreview(null)
      setImportOpen(false)
    } catch (e) { setImportError(String(e instanceof Error ? e.message : e)) }
    finally { setImportBusy(false) }
  }
  const onRepair = () => api.startRepairTranscript(sermon.name).catch((e) => setError(String(e)))
  const onAlign = () => api.startAlignTranscript(sermon.name).catch((e) => setError(String(e)))
  const transcriptBlocked = transcriptStatus?.human_review_required ?? false
  const alignmentBlocked = !transcriptStatus?.alignment?.acceptable
  const onDelete = async () => {
    if (!window.confirm(`Delete "${sermon.name}"?\n\nThis removes the source file, transcript, clips.json, and every exported MP4.`)) return
    setDeleting(true)
    setError(null)
    try {
      await api.deleteSermon(sermon.name)
      onDeleted()
    } catch (err) {
      setError(String(err))
      setDeleting(false)
    }
  }

  return (
    <div className="sermon-detail">
      <div className="header-row">
        <button className="back" onClick={onBack}>← Back</button>
        {admin && (
          <button className="danger" onClick={onDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete sermon'}
          </button>
        )}
      </div>
      <h1 title={sermon.name}>{sermon.name}</h1>

      {error && <div className="error">Error: {error}</div>}

      {(admin || programVideoId) && (
        <section className="program-url-row">
          <label className="muted small" htmlFor="program-url-input">Full sermon YouTube URL</label>
          {admin ? (
            <>
              <input
                id="program-url-input"
                type="url"
                className="program-url-input"
                placeholder="https://youtu.be/… (used for clip deep-links)"
                value={programUrl}
                disabled={urlSaving}
                onChange={(e) => setProgramUrl(e.target.value)}
                onBlur={(e) => saveProgramUrl(e.target.value)}
              />
              {programVideoId && (
                <span className="badge ok" title="Parsed YouTube video ID — deep links will work">
                  ✓ {programVideoId}
                </span>
              )}
              {urlError && <span className="error-inline">{urlError}</span>}
            </>
          ) : (
            programVideoId && (
              <a
                href={`https://youtu.be/${programVideoId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="muted small"
              >
                youtu.be/{programVideoId}
              </a>
            )
          )}
        </section>
      )}

      <section className="pipeline">
        <div className="step">
          <div className="step-title">1. Transcribe</div>
          {sermon.transcribed ? (
            <span className="badge ok">✓ done</span>
          ) : (
            <>
              <button onClick={onTranscribe} disabled={runningKinds.has('transcribe')}>
                {runningKinds.has('transcribe') ? 'Running…' : 'Run transcribe'}
              </button>
              <JobProgress job={transcribeJob} />
              {transcribeJob && transcribeJob.status === 'failed' && (
                <span className="error-inline">{jobLabel(transcribeJob)}</span>
              )}
            </>
          )}
        </div>
        {sermon.transcribed && transcriptStatus && (
          <div className="step">
            <div className="step-title">Transcript quality</div>
            <span className="muted small">Raw: {transcriptStatus.raw_quality.status} · Effective: {transcriptStatus.effective_quality.status}</span>
            {transcriptStatus.repair_exists && <span className="badge ok"> repaired</span>}
            {transcriptBlocked && <span className="error-inline"> Transcript requires review</span>}
            {transcriptStatus.repair_failure_reason && (
              <span className="error-inline"> {transcriptStatus.repair_failure_reason}</span>
            )}
            {admin && transcriptStatus.raw_quality.status === 'failed' && transcriptBlocked && (
              <button onClick={onRepair} disabled={runningKinds.has('repair_transcript')}>
                {runningKinds.has('repair_transcript') ? 'Repairing transcript…' : 'Repair transcript'}
              </button>
            )}
            <JobProgress job={repairJob} />
            {repairJob?.status === 'failed' && <span className="error-inline">Transcript repair requires review</span>}
          </div>
        )}
        {admin && sermon.transcribed && (
          <div className="step">
            <div className="step-title">Transcript review</div>
            <button type="button" onClick={() => setReviewTranscript(open => !open)}>
              {reviewTranscript ? 'Close full transcript' : 'Review full transcript'}
            </button>
          </div>
        )}
        {sermon.transcribed && transcriptStatus && (
          <div className="step">
            <div className="step-title">Word alignment</div>
            <span className="muted small">
              {runningKinds.has('align_transcript') ? 'aligning' : transcriptStatus.alignment?.status ?? 'not aligned'}
              {transcriptStatus.alignment && ` · ${transcriptStatus.alignment.aligned_words}/${transcriptStatus.alignment.total_words} words`}
            </span>
            {admin && !transcriptBlocked && (
              <button onClick={onAlign} disabled={runningKinds.has('align_transcript')}>
                {runningKinds.has('align_transcript') ? 'Aligning…' : 'Align transcript'}
              </button>
            )}
            <JobProgress job={alignmentJob} />
            {alignmentJob?.status === 'failed' && <span className="error-inline">Alignment requires review</span>}
            {transcriptStatus.alignment?.stale_ranges.length ?
              <span className="error-inline">Changed words need realignment</span> : null}
          </div>
        )}
        <div className="step">
          <div className="step-title">2. Pick clips</div>
          <div className="clip-count-controls">
            <label className="muted">Range</label>
            <input
              type="number"
              min={1}
              max={20}
              value={minClips}
              onChange={(e) => setMinClips(Math.max(1, parseInt(e.target.value || '1', 10)))}
              title="minimum clips Claude must return"
            />
            <span className="muted">to</span>
            <input
              type="number"
              min={minClips}
              max={20}
              value={maxClips}
              onChange={(e) => setMaxClips(Math.max(minClips, parseInt(e.target.value || '1', 10)))}
              title="maximum clips Claude may return"
            />
          </div>
          {sermon.clips_selected || clips ? (
            <>
              <span className="badge ok">✓ {clips?.clips.length ?? sermon.n_clips} clips</span>
              <button
                className="secondary"
                onClick={onSelectClips}
                disabled={runningKinds.has('select_clips') || transcriptBlocked || alignmentBlocked}
                title="Re-run Claude clip selection with the range above"
              >
                {runningKinds.has('select_clips') ? 'Re-running…' : 'Re-run'}
              </button>
              <JobProgress job={selectJob} />
            </>
          ) : (
            <>
              <button
                onClick={onSelectClips}
                disabled={!sermon.transcribed || runningKinds.has('select_clips') || transcriptBlocked || alignmentBlocked}
              >
                {runningKinds.has('select_clips') ? 'Running…' : 'Run clip selection'}
              </button>
              {!sermon.transcribed && <span className="muted">(transcribe first)</span>}
              <JobProgress job={selectJob} />
              {selectJob && selectJob.status === 'failed' && (
                <span className="error-inline">{jobLabel(selectJob)}</span>
              )}
            </>
          )}
          {admin && sermon.transcribed && <button type="button" className="secondary"
            onClick={() => { setManualOpen(open => !open); setManualError(null) }}
            disabled={runningKinds.has('select_clips')}>
            {manualOpen ? 'Close manual clip' : 'Add clip manually'}
          </button>}
          {admin && sermon.transcribed && <button type="button" className="secondary"
            onClick={() => { setImportOpen(open => !open); setImportError(null) }}
            disabled={runningKinds.has('select_clips')}>
            Import JSON
          </button>}
        </div>
        {prescanJob && (prescanJob.status === 'queued' || prescanJob.status === 'running') && (
          <div className="step">
            <div className="step-title muted">Background: face prescan</div>
            <JobProgress job={prescanJob} />
          </div>
        )}
      </section>

      {admin && sermon.transcribed && manualOpen && <form className="manual-clip-form"
        onSubmit={onCreateManualClip}>
        <h3>Add clip manually</h3>
        <label>Title<input type="text" value={manualTitle} maxLength={200} required
          onChange={event => setManualTitle(event.target.value)} /></label>
        <label>Start<input type="text" value={manualStart} required placeholder="MM:SS.mmm"
          onChange={event => setManualStart(event.target.value)} /></label>
        <label>End<input type="text" value={manualEnd} required placeholder="MM:SS.mmm"
          onChange={event => setManualEnd(event.target.value)} /></label>
        {manualStartSeconds !== null && manualEndSeconds !== null &&
          manualEndSeconds > manualStartSeconds &&
          <span className="muted small">Duration: {manualClipDuration(manualStartSeconds, manualEndSeconds).toFixed(1)} sec</span>}
        {manualError && <p className="error">{manualError}</p>}
        <button type="submit" disabled={manualBusy || runningKinds.has('select_clips')}>
          {manualBusy ? 'Creating…' : 'Create Clip'}
        </button>
      </form>}

      {admin && sermon.transcribed && importOpen && <section className="clip-import-panel">
        <h3>Import JSON clips</h3>
        <input type="file" accept=".json,application/json"
          onChange={event => { void onImportFile(event.target.files?.[0]) }} />
        {importPreview && <>
          <p>{importPreview.clips.length} clip{importPreview.clips.length === 1 ? '' : 's'} found</p>
          <ul>{importPreview.clips.map((clip, index) =>
            <li key={index}><strong>{clip.title}</strong> · {fmtSecs(clip.start)} – {fmtSecs(clip.end)}</li>)}</ul>
          <div className="action-row">
            <button type="button" className="secondary" onClick={() => { setImportPreview(null); setImportOpen(false) }}>Cancel</button>
            <button type="button" onClick={onImportClips} disabled={importBusy || runningKinds.has('select_clips')}>
              {importBusy ? 'Importing…' : `Import ${importPreview.clips.length} clip${importPreview.clips.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </>}
        {importError && <p className="error">{importError}</p>}
      </section>}
      {importMessage && <p role="status" className="badge ok">{importMessage}</p>}

      {admin && sermon.transcribed && reviewTranscript &&
        <TranscriptEditor source={sermon.name} fullSermon onChanged={() => {
          api.getTranscriptStatus(sermon.name).then(setTranscriptStatus).catch(e => setError(String(e)))
        }} />}

      {clips && (
        <section className="clips">
          <h2>Clips</h2>
          <ul>
            {clips.clips
              .map((clip, i) => ({ clip, i }))
              .sort((a, b) => (b.clip.hook_score ?? -1) - (a.clip.hook_score ?? -1))
              .map(({ clip, i }) => {
              const exportJobs = activeJobs.filter(
                (j) => j.kind === 'export_clip' && j.clip_index === i,
              )
              const latest = exportJobs.sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
              const exporting = latest && (latest.status === 'queued' || latest.status === 'running')
              const score = clip.score ?? clip.hook_score
              return (
                <li key={i} className="clip-card">
                  <div className="clip-title">
                    {score !== undefined && (
                      <span
                        className={`hook-score ${hookScoreClass(score)}`}
                        title="Hook score: how likely a cold scroller keeps watching past 3s"
                      >
                        {score}
                      </span>
                    )}
                    {clip.title}
                  </div>
                  <div className="clip-meta">
                    {fmtSecs(clip.start)} – {fmtSecs(clip.end)} · {(clip.end - clip.start).toFixed(1)}s
                    {clip.origin !== 'ai' && <span className="badge"> {clip.origin === 'manual' ? 'Manual' : 'JSON import'}</span>}
                    {clip.exported && <span className="badge ok"> ✓ exported</span>}
                    {exporting && <span className="badge"> exporting…</span>}
                    {latest?.status === 'failed' && (
                      <span className="error-inline"> {(latest.error ?? '').split('\n')[0]}</span>
                    )}
                    {clip.exported && clip.last_exported_by_name && (
                      <span className="muted clip-attribution">
                        {' '}by <strong>{clip.last_exported_by_name}</strong>
                        {clip.last_exported_at && <> · {fmtRelTime(clip.last_exported_at)}</>}
                      </span>
                    )}
                  </div>
                  {exporting && <JobProgress job={latest} />}
                  {clipDetailSections(clip).map(([label, value]) =>
                    <div key={label} className="clip-rationale"><strong>{label}:</strong> {value}</div>)}
                  <div className="clip-actions">
                    <button onClick={() => onTrim(clip, i)}>
                      {clip.exported ? 'Re-trim & export' : 'Preview / trim / export'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
