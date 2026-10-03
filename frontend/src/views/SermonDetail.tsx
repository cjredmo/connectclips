import { useCallback, useEffect, useRef, useState } from 'react'
import { api, fileUrl } from '../api'
import type { Clip, ClipsFile, Job, Sermon, TranscriptStatus } from '../types'
import { SermonNav } from '../components/SermonNav'
import { StatusBadge } from '../components/StatusBadge'
import { nextSermonAction, transcriptPresentation } from '../sermonWorkspace'
import type { SermonSection } from '../sermonWorkspace'
import { TranscriptEditor } from './TranscriptEditor'
import { manualClipDuration, parseManualClipTime, submitManualClipInputs } from '../manualClipTime'
import { importResultMessage, parseClipImportText } from '../clipImport'
import type { ImportPreview } from '../clipImport'
import { PromptLibrary } from './PromptLibrary'
import { loadPendingSelection, submitSelectionImport } from '../clipSelectionSession'
import type { PendingAiSelection } from '../clipSelectionSession'
import { groupClips } from '../clipProvenance'
import { ClipGroupGrid } from '../components/ClipGroupGrid'
import { ClipPreviewModal } from '../components/ClipPreviewModal'

type Props = {
  sermon: Sermon
  section: SermonSection
  admin: boolean
  onBack: () => void
  onSectionChange: (section: SermonSection) => void
  onSermonUpdated: (name: string) => Promise<void>
  onTrim: (clip: Clip, clipIndex: number) => void
  onDeleted: () => void
}

function fmtSecs(s: number): string {
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(1)
  return `${m}:${sec.padStart(4, '0')}`
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

export function SermonDetail({ sermon, section, admin, onBack, onSectionChange, onSermonUpdated, onTrim, onDeleted }: Props) {
  const [clips, setClips] = useState<ClipsFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeJobs, setActiveJobs] = useState<Job[]>([])
  const [transcriptStatus, setTranscriptStatus] = useState<TranscriptStatus | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [minClips, setMinClips] = useState(3)
  const [maxClips, setMaxClips] = useState(8)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualTitle, setManualTitle] = useState('')
  const [manualStart, setManualStart] = useState('')
  const [manualEnd, setManualEnd] = useState('')
  const [manualScriptureReference, setManualScriptureReference] = useState('')
  const [manualBusy, setManualBusy] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [importMode, setImportMode] = useState<'generic' | 'ai_chat'>('generic')
  const [promptOpen, setPromptOpen] = useState(false)
  const [pendingSelection, setPendingSelection] = useState<PendingAiSelection | null>(
    () => { try { return loadPendingSelection(window.localStorage, sermon.name) } catch { return null } })
  // Full-sermon YouTube URL drives the "watch from this moment" deep link in
  // the Publish view. Stored as a sidecar per sermon; admin edits it once
  // per sermon and volunteers consume the resulting deep link.
  const [programUrl, setProgramUrl] = useState<string>('')
  const [programVideoId, setProgramVideoId] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [urlSaving, setUrlSaving] = useState(false)
  const [sermonDate, setSermonDate] = useState(sermon.sermon_date ?? '')
  const [dateSaving, setDateSaving] = useState(false)
  const [dateError, setDateError] = useState<string | null>(null)
  const [previewClip, setPreviewClip] = useState<{ clip: Clip; index: number } | null>(null)
  const seenCompletedJobs = useRef(new Set<string>())

  const refreshClips = useCallback(() => {
    if (!sermon.clips_selected) {
      setClips(null)
      return
    }
    api.getClips(sermon.name).then(setClips).catch((e) => setError(String(e)))
  }, [sermon.name, sermon.clips_selected])

  useEffect(() => {
    if (!sermon.clips_selected) return
    let cancelled = false
    api.getClips(sermon.name).then(data => { if (!cancelled) setClips(data) })
      .catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [sermon.name, sermon.clips_selected])

  // Load the per-sermon metadata for the admin fields and read-only display.
  useEffect(() => {
    let cancelled = false
    api.getSermonMeta(sermon.name).then((m) => {
      if (cancelled) return
      setProgramUrl(m.program_video_url ?? '')
      setProgramVideoId(m.program_video_id ?? null)
      setSermonDate(m.sermon_date ?? '')
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

  const saveSermonDate = async (raw: string) => {
    setDateSaving(true)
    setDateError(null)
    try {
      const m = await api.saveSermonMeta(sermon.name, { sermon_date: raw || null })
      setSermonDate(m.sermon_date ?? '')
      await onSermonUpdated(sermon.name)
    } catch (err) { setDateError(String(err)) }
    finally { setDateSaving(false) }
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
        const newlyCompleted = mine.filter(j => j.status === 'done' &&
          !seenCompletedJobs.current.has(j.id))
        newlyCompleted.forEach(j => seenCompletedJobs.current.add(j.id))
        if (newlyCompleted.some(j => j.kind === 'transcribe' || j.kind === 'select_clips')) {
          await onSermonUpdated(sermon.name)
        }
        // If anything just finished, refresh clips
        if (mine.some((j) => j.status === 'done' && j.kind !== 'transcribe')) {
          refreshClips()
        }
      } catch { /* the next poll will retry */ }
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sermon.name, refreshClips, onSermonUpdated])

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
        payload => api.createManualClip(sermon.name, payload), manualScriptureReference)
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
      const { result, session, remainingPending, clearError } = await submitSelectionImport(
        sermon.name, importPreview.document, importMode, pendingSelection, () => window.localStorage,
        (document, context) => api.importClipJson(sermon.name, document, context))
      setPendingSelection(remainingPending)
      setClips(await api.getClips(sermon.name))
      setImportMessage(importResultMessage(result.imported, result.duplicates_skipped) +
        (session ? ` AI Chat · ${session.selection_prompt_name}.` : '') +
        (session && result.imported === 0 ? ' Pending session retained.' : ''))
      if (clearError) setImportError('Clips imported, but the browser could not clear the pending session.')
      setImportPreview(null)
      setImportOpen(false)
    } catch (e) { setImportError(String(e instanceof Error ? e.message : e)) }
    finally { setImportBusy(false) }
  }
  const onRepair = () => api.startRepairTranscript(sermon.name).catch((e) => setError(String(e)))
  const onAlign = () => api.startAlignTranscript(sermon.name).catch((e) => setError(String(e)))
  const transcriptBlocked = transcriptStatus?.human_review_required ?? false
  const alignmentBlocked = !transcriptStatus?.alignment?.acceptable
  const transcriptState = transcriptPresentation(sermon, transcriptStatus, runningKinds.has('transcribe'))
  const nextAction = nextSermonAction({ ...sermon, n_clips: clips?.clips.length ?? sermon.n_clips },
    transcriptStatus, runningKinds.has('transcribe'))
  const nextActionDetail = nextAction.section === 'clips'
    ? (clips?.clips.length ?? sermon.n_clips) > 0
      ? 'Clip suggestions are available to review and export.'
      : 'The effective transcript is ready for clip creation.'
    : transcriptState.detail
  const exportedClips = clips?.clips.map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => clip.exported && clip.output_filename) ?? []
  const clipGroups = groupClips(clips?.clips ?? [])
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
      <header className="sermon-workspace-header">
        <div className="sermon-workspace-heading">
          <div>
            <p className="sermon-eyebrow">Sermon workspace</p>
            <h1 title={sermon.name}>{sermon.name}</h1>
            <p className="muted small">Updated {new Date(sermon.modified_at).toLocaleString()} · {(sermon.size_bytes / 1024 / 1024).toFixed(0)} MB source</p>
          </div>
          <StatusBadge tone={transcriptState.tone}>{transcriptState.label}</StatusBadge>
        </div>
        <SermonNav active={section} onChange={onSectionChange} />
      </header>

      {error && <div className="error">Error: {error}</div>}

      {section === 'overview' && <>
        <section className="sermon-overview-intro">
          <div>
            <p className="sermon-eyebrow">Recommended next step</p>
            <h2>{nextAction.label}</h2>
            <p className="muted">{nextActionDetail}</p>
          </div>
          <button type="button" className="primary" onClick={() =>
            nextAction.action === 'transcribe' ? onTranscribe() : onSectionChange(nextAction.section)}
            disabled={nextAction.action === 'transcribe' && runningKinds.has('transcribe')}>
            {nextAction.label}
          </button>
        </section>
        <div className="sermon-overview-grid">
          <section className="sermon-summary-card">
            <h2>Transcript</h2>
            <StatusBadge tone={transcriptState.tone}>{transcriptState.label}</StatusBadge>
            <p className="muted small">{transcriptState.detail}</p>
            <button type="button" className="tertiary" onClick={() => onSectionChange('transcript')}>View transcript</button>
          </section>
          <section className="sermon-summary-card">
            <h2>Clips</h2>
            <p className="sermon-summary-value">{clips?.clips.length ?? sermon.n_clips}</p>
            <p className="muted small">{(clips?.clips.length ?? sermon.n_clips) ? 'Clip suggestions available' : 'No clips yet'}</p>
            <button type="button" className="tertiary" onClick={() => onSectionChange('clips')}>View clips</button>
          </section>
          <section className="sermon-summary-card">
            <h2>Exports</h2>
            <p className="sermon-summary-value">{exportedClips.length}</p>
            <p className="muted small">Current exported clips</p>
            <button type="button" className="tertiary" onClick={() => onSectionChange('exports')}>View exports</button>
          </section>
        </div>
        <h2>Source</h2>
        <p className="muted small">Original recording · {(sermon.size_bytes / 1024 / 1024).toFixed(0)} MB · updated {new Date(sermon.modified_at).toLocaleString()}</p>
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
      {(admin || sermonDate) && <section className="program-url-row">
        <label className="muted small" htmlFor="sermon-date-input">Sermon date</label>
        {admin ? <>
          <input id="sermon-date-input" type="date" value={sermonDate} disabled={dateSaving}
            onChange={event => setSermonDate(event.target.value)}
            onBlur={event => void saveSermonDate(event.target.value)} />
          {dateError && <span className="error-inline">{dateError}</span>}
        </> : <span>{sermonDate}</span>}
      </section>}
      </>}

      {section === 'overview' && <>
        {runningKinds.has('transcribe') && <div className="sermon-processing-status">
          <span>Transcription in progress</span><JobProgress job={transcribeJob} />
        </div>}
        {transcribeJob?.status === 'failed' && !sermon.transcribed &&
          <p className="error">{jobLabel(transcribeJob)}</p>}
        <details className="sermon-technical-details">
          <summary>Technical details</summary>
          {transcriptStatus ? <>
            <p>Raw quality: {transcriptStatus.raw_quality.status} · Effective quality: {transcriptStatus.effective_quality.status}</p>
            <p>Repair: {transcriptStatus.repair_status} · Alignment: {transcriptStatus.alignment?.status ?? 'not aligned'}</p>
            {transcriptStatus.repair_failure_reason && <p>Recent repair issue: {transcriptStatus.repair_failure_reason}</p>}
          </> : <p>Transcript status is not available yet.</p>}
          {transcribeJob && <p>Latest transcription job: {jobLabel(transcribeJob)}</p>}
        </details>
      </>}

      {section === 'transcript' && <>
        <div className="sermon-section-heading">
          <div><h2>Transcript</h2><p className="muted">Review the effective text and compare it with the source recording.</p></div>
          <StatusBadge tone={transcriptState.tone}>{transcriptState.label}</StatusBadge>
        </div>
        {!sermon.transcribed && <p className="muted">No transcript is available yet. Start transcription from Overview.</p>}
        {!sermon.transcribed && <JobProgress job={transcribeJob} />}
        <section className="pipeline sermon-transcript-actions">
        {sermon.transcribed && transcriptStatus && (
          <div className="step">
            <div className="step-title">Transcript state</div>
            <StatusBadge tone={transcriptState.tone}>{transcriptState.label}</StatusBadge>
            {transcriptBlocked && <span className="error-inline"> Transcript requires review</span>}
            {admin && transcriptStatus.raw_quality.status === 'failed' && transcriptBlocked && (
              <button onClick={onRepair} disabled={runningKinds.has('repair_transcript')}>
                {runningKinds.has('repair_transcript') ? 'Repairing transcript…' : 'Repair transcript'}
              </button>
            )}
            <JobProgress job={repairJob} />
            {repairJob?.status === 'failed' && transcriptBlocked && <span className="error-inline">Transcript repair requires review</span>}
            <details className="sermon-technical-details">
              <summary>Quality details</summary>
              <p>Raw: {transcriptStatus.raw_quality.status} · Effective: {transcriptStatus.effective_quality.status}</p>
              {transcriptStatus.repair_exists && <p>Accepted repair available</p>}
              {transcriptStatus.repair_failure_reason && <p>Recent repair issue: {transcriptStatus.repair_failure_reason}</p>}
            </details>
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
            {alignmentJob?.status === 'failed' && !transcriptStatus.alignment?.acceptable &&
              <span className="error-inline">Alignment requires review</span>}
            {transcriptStatus.alignment?.stale_ranges.length ?
              <span className="error-inline">Changed words need realignment</span> : null}
          </div>
        )}
        </section>
        {sermon.transcribed && <TranscriptEditor source={sermon.name} fullSermon canEdit={admin} onChanged={() => {
          api.getTranscriptStatus(sermon.name).then(setTranscriptStatus).catch(e => setError(String(e)))
        }} />}
      </>}

      {section === 'clips' && <>
        <div className="sermon-section-heading"><div><h2>Clips</h2><p className="muted">Create and review clip suggestions.</p></div></div>
        <section className="pipeline sermon-clips-pipeline">
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
            onClick={() => { setImportMode('generic'); setImportPreview(null)
              setImportOpen(open => !open); setImportError(null) }}
            disabled={runningKinds.has('select_clips')}>
            Import JSON
          </button>}
          {admin && sermon.transcribed && <button type="button"
            onClick={() => setPromptOpen(open => !open)}>
            {promptOpen ? 'Close AI Chat' : pendingSelection ? 'AI Chat · Pending results' : 'AI Chat · Prompt Library'}
          </button>}
        </div>
        {prescanJob && (prescanJob.status === 'queued' || prescanJob.status === 'running') && (
          <div className="step">
            <div className="step-title muted">Background: face prescan</div>
            <JobProgress job={prescanJob} />
          </div>
        )}
      </section>

      {admin && sermon.transcribed && promptOpen && <PromptLibrary source={sermon.name}
        pending={pendingSelection} onPendingChange={setPendingSelection}
        onImportResults={() => { setImportMode('ai_chat'); setImportPreview(null)
          setImportError(null); setImportMessage(null); setImportOpen(true) }} />}

      {admin && sermon.transcribed && manualOpen && <form className="manual-clip-form"
        onSubmit={onCreateManualClip}>
        <h3>Add clip manually</h3>
        <label>Title<input type="text" value={manualTitle} maxLength={200} required
          onChange={event => setManualTitle(event.target.value)} /></label>
        <label>Start<input type="text" value={manualStart} required placeholder="MM:SS.mmm"
          onChange={event => setManualStart(event.target.value)} /></label>
        <label>End<input type="text" value={manualEnd} required placeholder="MM:SS.mmm"
          onChange={event => setManualEnd(event.target.value)} /></label>
        <label>Scripture reference (optional)<input type="text" value={manualScriptureReference}
          maxLength={120} placeholder="Book chapter:verse"
          onChange={event => setManualScriptureReference(event.target.value)} /></label>
        {manualStartSeconds !== null && manualEndSeconds !== null &&
          manualEndSeconds > manualStartSeconds &&
          <span className="muted small">Duration: {manualClipDuration(manualStartSeconds, manualEndSeconds).toFixed(1)} sec</span>}
        {manualError && <p className="error">{manualError}</p>}
        <button type="submit" disabled={manualBusy || runningKinds.has('select_clips')}>
          {manualBusy ? 'Creating…' : 'Create Clip'}
        </button>
      </form>}

      {admin && sermon.transcribed && importOpen && <section className="clip-import-panel">
        <h3>{importMode === 'ai_chat' ? 'Import AI results' : 'Import JSON clips'}</h3>
        {importMode === 'ai_chat' && pendingSelection &&
          <p>Importing results for: <strong>{pendingSelection.selection_prompt_name}</strong></p>}
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

      {clips && <section className="clips media-clips-workspace">
        <h2>Clip suggestions</h2>
        {clipGroups.length === 0 && <p className="muted">No clips yet.</p>}
        {clipGroups.map(group => <ClipGroupGrid key={group.key} sermon={sermon} group={group}
          onPreview={(clip, index) => setPreviewClip({ clip, index })}
          onEdit={onTrim}
          statusFor={index => {
            const latest = activeJobs.filter(job => job.kind === 'export_clip' && job.clip_index === index)
              .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
            return latest?.status === 'queued' || latest?.status === 'running' ? 'Exporting…'
              : latest?.status === 'failed' ? 'Export failed' : undefined
          }} />)}
      </section>}
      {previewClip && <ClipPreviewModal sermon={sermon} clip={previewClip.clip}
        onClose={() => setPreviewClip(null)} onEdit={() => onTrim(previewClip.clip, previewClip.index)} />}
      </>}

      {section === 'exports' && <section className="sermon-exports">
        <div className="sermon-section-heading"><div><h2>Exports</h2><p className="muted">Current exported clip files for this sermon.</p></div></div>
        <p className="muted small">This view reflects current clip records. It is not a complete lifetime export history; recent jobs remain in Activity.</p>
        {exportedClips.length ? <ul className="sermon-export-list">
          {exportedClips.map(({ clip, index }) => <li key={clip.id} className="sermon-export-row">
            <div><strong>{clip.title}</strong><p className="muted small">{fmtSecs(clip.start)} – {fmtSecs(clip.end)}{clip.last_exported_at ? ` · exported ${new Date(clip.last_exported_at).toLocaleString()}` : ''}</p></div>
            <div className="sermon-export-actions">
              <a href={fileUrl.clip(clip.output_filename!)} download className="sermon-download-link">Download MP4</a>
              <button type="button" className="secondary" onClick={() => onTrim(clip, index)}>Edit / Trim</button>
            </div>
          </li>)}</ul> : <p className="empty">No current exported clips yet. Open Clips to prepare one.</p>}
      </section>}
    </div>
  )
}
