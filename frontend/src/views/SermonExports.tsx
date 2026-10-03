import { activityErrorSummary, activityProgress, activityStatus } from '../activityPresentation'
import { fileUrl } from '../api'
import { formatClipTime } from '../clipLibrary'
import { StatePanel } from '../components/StatePanel'
import { StatusBadge } from '../components/StatusBadge'
import { buildExportItems, latestExportJobs } from '../exportPresentation'
import type { Clip, ClipsFile, Job } from '../types'

function exportDate(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

export function SermonExports({ clips, jobs, loading, error, onRetry, onOpenClips, onTrim }: {
  clips: ClipsFile | null
  jobs: Job[]
  loading: boolean
  error: string | null
  onRetry: () => void
  onOpenClips: () => void
  onTrim: (clip: Clip, index: number) => void
}) {
  const items = buildExportItems(clips?.clips ?? [], jobs)
  const current = items.filter(item => item.state === 'current')
  const previous = items.filter(item => item.state === 'previous')
  const recentJobs = latestExportJobs(jobs)

  return <section className="sermon-exports">
    <div className="sermon-section-heading"><div>
      <p className="sermon-eyebrow">Ready to share</p>
      <h2>Exports</h2>
      <p className="muted">Download finished clips from this sermon.</p>
    </div></div>
    {error && <StatePanel kind="error" title="Exports could not be loaded" detail={error}
      action={<button type="button" className="secondary" onClick={onRetry}>Try again</button>}>
      Check the connection and try again.
    </StatePanel>}
    {loading && !error && <StatePanel kind="loading" title="Loading exports">Checking finished clip files.</StatePanel>}
    {recentJobs.length > 0 && <section className="export-job-section" aria-label="Recent export work">
      <h3>Recent export work</h3>
      {recentJobs.map(job => {
        const status = activityStatus(job.status)
        const progress = activityProgress(job)
        const clip = clips?.clips[job.clip_index ?? -1]
        return <div className={`export-job-row export-job-${job.status}`} key={job.id}>
          <div><strong>{clip?.title || `Clip ${(job.clip_index ?? 0) + 1}`}</strong>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge></div>
          {(job.status === 'queued' || job.status === 'running') && <div className="export-job-progress">
            <progress value={progress ?? undefined} max={1} aria-label="Export progress" />
            {progress !== null && <span>{Math.round(progress * 100)}%</span>}
            {job.progress_message && <p>{job.progress_message}</p>}
          </div>}
          {job.status === 'failed' && <div className="export-job-error">
            {activityErrorSummary(job.error)}
            {job.error && <details><summary>Technical details</summary><pre>{job.error}</pre></details>}
          </div>}
        </div>
      })}
    </section>}
    {!loading && !error && current.length === 0 && <StatePanel kind="empty"
      title={previous.length ? 'No current exports' : 'No exports yet'}
      action={<button type="button" className="secondary" onClick={onOpenClips}>Open Clips</button>}>
      {previous.length ? 'The files below were made from an earlier clip selection. Export a current clip from its editor.'
        : 'Finished clips will appear here after you export them from the clip editor.'}
    </StatePanel>}
    {current.length > 0 && <section className="export-section" aria-label="Current exports">
      <div className="export-section-heading"><h3>Current exports</h3><span>{current.length}</span></div>
      <ul className="sermon-export-list">{current.map(item => <li key={`${item.clip.id}-${item.filename}`} className="sermon-export-row">
        <div className="sermon-export-main">
          <div className="sermon-export-title"><h4>{item.clip.title}</h4>
            <StatusBadge tone="success">Current export</StatusBadge></div>
          <p className="sermon-export-meta">
            <span>{formatClipTime(item.end - item.start)} duration</span>
            {exportDate(item.exportedAt) && <span>Exported {exportDate(item.exportedAt)}</span>}
            {item.captionStyle && <span>Captions: {item.captionStyle}</span>}
            {item.byName && <span>By {item.byName}</span>}
          </p>
          <p className="sermon-export-filename" title={item.filename}>{item.filename}</p>
        </div>
        <div className="sermon-export-actions">
          <a href={fileUrl.clip(item.filename)} download={item.filename} className="sermon-download-link">Download MP4</a>
          <button type="button" className="secondary" onClick={() => onTrim(item.clip, item.index)}>Edit / Trim</button>
        </div>
      </li>)}</ul>
    </section>}
    {previous.length > 0 && <section className="export-section export-section-previous" aria-label="Previous exports">
      <div className="export-section-heading"><h3>Previous exports</h3><span>{previous.length}</span></div>
      <p className="muted small">These files may not match the clip's latest selection or edits.</p>
      <ul className="sermon-export-list">{previous.map(item => <li key={`${item.clip.id}-${item.filename}`} className="sermon-export-row">
        <div className="sermon-export-main">
          <div className="sermon-export-title"><h4>{item.clip.title}</h4>
            <StatusBadge tone="warning">Previous export</StatusBadge></div>
          <p className="sermon-export-meta">
            <span>{formatClipTime(item.end - item.start)} duration</span>
            {exportDate(item.exportedAt) && <span>Exported {exportDate(item.exportedAt)}</span>}
            {item.byName && <span>By {item.byName}</span>}
          </p>
          <p className="sermon-export-filename" title={item.filename}>{item.filename}</p>
        </div>
        <div className="sermon-export-actions">
          <a href={fileUrl.clip(item.filename)} download={item.filename} className="sermon-download-link">Download previous MP4</a>
        </div>
      </li>)}</ul>
    </section>}
    <p className="muted small export-history-note">Shows current clip records and available previous files, not a complete export history. Recent job details are in Activity.</p>
  </section>
}
