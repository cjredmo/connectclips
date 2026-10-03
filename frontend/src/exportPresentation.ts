import type { Clip, Job } from './types'

export type ExportItem = {
  clip: Clip
  index: number
  filename: string
  state: 'current' | 'previous'
  start: number
  end: number
  exportedAt: string | null
  byName: string | null
  captionStyle: string | null
}

function basename(path: string | null): string | null {
  return path?.split(/[\\/]/).at(-1) ?? null
}

export function buildExportItems(clips: readonly Clip[], jobs: readonly Job[]): ExportItem[] {
  const items: ExportItem[] = []
  clips.forEach((clip, index) => {
    if (clip.exported && clip.output_filename) {
      const matchingJob = jobs.find(job => job.kind === 'export_clip' && job.status === 'done'
        && job.clip_index === index && basename(job.output_clip_path) === clip.output_filename)
      items.push({ clip, index, filename: clip.output_filename, state: 'current',
        start: matchingJob?.start ?? clip.start, end: matchingJob?.end ?? clip.end,
        exportedAt: clip.last_exported_at ?? matchingJob?.finished_at ?? null,
        byName: clip.last_exported_by_name ?? matchingJob?.user_name ?? null,
        captionStyle: matchingJob?.caption_style_name ?? null })
    }
    if (clip.previous_export) {
      const previous = clip.previous_export
      items.push({ clip, index, filename: previous.filename, state: 'previous',
        start: previous.start, end: previous.end, exportedAt: previous.exported_at,
        byName: previous.by_name, captionStyle: null })
    }
  })
  return items.sort((a, b) => (a.state === b.state ? a.index - b.index : a.state === 'current' ? -1 : 1))
}

export function latestExportJobs(jobs: readonly Job[]): Job[] {
  const latest = new Map<number, Job>()
  for (const job of [...jobs].filter(job => job.kind === 'export_clip' && job.clip_index !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (!latest.has(job.clip_index!)) latest.set(job.clip_index!, job)
  }
  return [...latest.values()].filter(job => job.status === 'queued' || job.status === 'running' || job.status === 'failed')
}
