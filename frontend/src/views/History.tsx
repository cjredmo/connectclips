import { useEffect, useState } from 'react'
import { api, fileUrl } from '../api'
import { activityErrorSummary, activityLabel, activityMatches, activityProgress,
  activitySections, activityStatus } from '../activityPresentation'
import { PageHeader } from '../components/PageHeader'
import { StatePanel } from '../components/StatePanel'
import { StatusBadge } from '../components/StatusBadge'
import type { Job } from '../types'

type Props = { onBack: () => void }

function formatTime(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function duration(job: Job): string | null {
  if (!job.started_at || !job.finished_at) return null
  const seconds = Math.max(0, Math.round((Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000))
  if (!Number.isFinite(seconds)) return null
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}

function ActivityItem({ job }: { job: Job }) {
  const status = activityStatus(job.status)
  const progress = activityProgress(job)
  const source = job.ingested_filename || job.source
  const completed = job.status === 'done' || job.status === 'failed'
  const filename = job.output_clip_path?.split(/[\\/]/).at(-1)
  return <li className={`activity-item activity-item-${job.status}`}>
    <div className="activity-item-main">
      <div className="activity-item-heading">
        <h3>{activityLabel(job)}</h3>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </div>
      {source && <p className="activity-item-source" title={source}>{source}</p>}
      <p className="activity-item-meta">
        <span>{job.user_name || job.user_login || 'Volunteer not recorded'}</span>
        <span>Started {formatTime(job.started_at || job.created_at) || 'time unavailable'}</span>
        {completed && job.finished_at && <span>Finished {formatTime(job.finished_at) || 'time unavailable'}</span>}
        {duration(job) && <span>{duration(job)}</span>}
      </p>
      {(job.status === 'queued' || job.status === 'running') && <div className="activity-item-progress">
        <progress value={progress ?? undefined} max={1} aria-label={`${status.label} progress`} />
        {progress !== null && <span>{Math.round(progress * 100)}%</span>}
        {job.progress_message && <p>{job.progress_message}</p>}
      </div>}
      {job.status === 'failed' && <div className="activity-item-failure">
        <strong>{activityErrorSummary(job.error)}</strong>
        {job.error && <details><summary>Technical details</summary><pre>{job.error}</pre></details>}
      </div>}
    </div>
    {job.kind === 'export_clip' && job.status === 'done' && filename && <div className="activity-item-result">
      <a href={fileUrl.clip(filename)} download>Download MP4</a>
      {job.caption_style_name && <span>Caption style: {job.caption_style_name}</span>}
    </div>}
  </li>
}

export function History({ onBack }: Props) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = () => api.listJobs(200)
      .then(data => { if (!cancelled) { setJobs(data); setError(null) } })
      .catch(e => { if (!cancelled) setError(String(e)) })
    void load()
    const id = setInterval(() => { void load() }, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [tick])

  const filtered = (jobs ?? []).filter(job => activityMatches(job, filter))
  const sections = activitySections(filtered)

  return <div className="history">
    <div className="header-row"><button className="back" onClick={onBack}>← Back</button></div>
    <PageHeader title="Activity" description="Recent processing across all sermons. Updates every five seconds."
      actions={<button className="secondary" onClick={() => setTick(value => value + 1)}>Refresh</button>} />
    <label className="activity-filter-label" htmlFor="activity-filter">Filter activity</label>
    <input id="activity-filter" type="search" className="history-filter"
      placeholder="Search sermon, task, person, or status" value={filter}
      onChange={event => setFilter(event.target.value)} />
    {error && <StatePanel kind="error" title="Activity could not be refreshed"
      detail={error} action={<button className="secondary" onClick={() => setTick(value => value + 1)}>Try again</button>}>
      Check the connection and try again. The list below may be out of date.
    </StatePanel>}
    {!jobs && !error && <StatePanel kind="loading" title="Loading activity">Getting recent work.</StatePanel>}
    {jobs && filtered.length === 0 && <StatePanel kind="empty"
      title={filter ? 'No matching activity' : 'No recent activity'}>
      {filter ? 'Try a different search.' : 'Processing jobs will appear here when work begins.'}
    </StatePanel>}
    {([
      ['active', 'In progress', sections.active],
      ['failed', 'Needs attention', sections.failed],
      ['completed', 'Recently completed', sections.completed],
    ] as const).map(([key, label, items]) => items.length > 0 &&
      <section className="activity-section" key={key} aria-labelledby={`activity-${key}`}>
        <div className="activity-section-heading"><h2 id={`activity-${key}`}>{label}</h2>
          <span>{items.length}</span></div>
        <ul className="activity-list">{items.map(job => <ActivityItem key={job.id} job={job} />)}</ul>
      </section>)}
  </div>
}
