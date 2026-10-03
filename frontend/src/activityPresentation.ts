import type { Job, JobStatus } from './types'

const KIND_LABELS: Record<Job['kind'], string> = {
  upload: 'Uploading source video',
  youtube_download: 'Importing source video',
  transcribe: 'Transcribing sermon',
  repair_transcript: 'Repairing transcript',
  align_transcript: 'Aligning transcript',
  select_clips: 'Selecting clips',
  export_clip: 'Exporting clip',
  prescan_faces: 'Preparing framing',
}

export function activityLabel(job: Job): string {
  const label = KIND_LABELS[job.kind]
  return job.kind === 'export_clip' && job.clip_index !== null
    ? `${label} ${job.clip_index + 1}` : label
}

export function activityStatus(status: JobStatus): { label: string; tone: 'processing' | 'failed' | 'success' | 'neutral' } {
  switch (status) {
    case 'queued': return { label: 'Queued', tone: 'neutral' }
    case 'running': return { label: 'Running', tone: 'processing' }
    case 'failed': return { label: 'Failed', tone: 'failed' }
    case 'done': return { label: 'Completed', tone: 'success' }
  }
}

export function activitySections(jobs: readonly Job[]): { active: Job[]; failed: Job[]; completed: Job[] } {
  const sorted = [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at))
  return {
    active: sorted.filter(job => job.status === 'queued' || job.status === 'running'),
    failed: sorted.filter(job => job.status === 'failed'),
    completed: sorted.filter(job => job.status === 'done'),
  }
}

export function activityProgress(job: Job): number | null {
  return typeof job.progress_percent === 'number' && Number.isFinite(job.progress_percent)
    ? Math.max(0, Math.min(1, job.progress_percent)) : null
}

export function activityErrorSummary(error: string | null): string {
  const lines = error?.split('\n').map(line => line.trim()).filter(Boolean) ?? []
  const last = lines.at(-1)
  if (!last || last.startsWith('File ') || last.startsWith('Traceback')) {
    return 'This work did not finish. Open technical details for more information.'
  }
  if (/Could not resolve authentication method/i.test(last)) {
    return 'Clip selection could not authenticate. Check its API credentials.'
  }
  const message = last.match(/^[\w.]*(?:Error|Exception):\s*(.+)$/)?.[1] ?? last
  return message.replace(/^ERROR:\s*/i, '')
}

export function activityMatches(job: Job, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return [activityLabel(job), job.kind, job.status, job.source, job.ingested_filename,
    job.user_name, job.user_login, job.progress_message]
    .some(value => value?.toLocaleLowerCase().includes(needle))
}
