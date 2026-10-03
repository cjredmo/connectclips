import { groupClips } from './clipProvenance.ts'
import type { ClipGroup } from './clipProvenance'
import type { Clip, Sermon } from './types'

export type SermonClips = { sermon: Sermon; clips: Clip[] }
export type LibrarySermon = { sermon: Sermon; groups: ClipGroup<Clip>[]; count: number }

export function formatClipTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const secs = total % 60
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`
}

export function dateLabel(sermon: Sermon): string {
  if (sermon.sermon_date) {
    return `Sermon date ${new Date(`${sermon.sermon_date}T12:00:00`).toLocaleDateString(undefined,
      { year: 'numeric', month: 'long', day: 'numeric' })}`
  }
  return `Updated ${new Date(sermon.modified_at).toLocaleDateString(undefined,
    { year: 'numeric', month: 'long', day: 'numeric' })}`
}

export function suitability(clip: Clip): number | null {
  const score = clip.score ?? clip.hook_score
  return typeof score === 'number' && Number.isFinite(score) ? score : null
}

export function clipMatches(clip: Clip, sermon: Sermon, groupLabel: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return [clip.title, sermon.name, clip.scripture_reference, groupLabel,
    clip.selection_prompt_name, clip.hook, clip.description]
    .some(value => value?.toLocaleLowerCase().includes(needle))
}

export function buildLibrary(collections: readonly SermonClips[], query = ''): LibrarySermon[] {
  return collections.map(({ sermon, clips }) => {
    // Group before filtering. The group helper indexes the original clips.json
    // array; filtering its results keeps every editor/deep-link index stable.
    const groups = groupClips(clips).map(group => {
      const batches = group.batches.map(batch => ({ ...batch, clips: batch.clips.filter(
        ({ clip }) => clipMatches(clip, sermon, group.label, query)) }))
        .filter(batch => batch.clips.length > 0)
      return { ...group, batches, count: batches.reduce((n, batch) => n + batch.clips.length, 0) }
    }).filter(group => group.count > 0)
    return { sermon, groups, count: groups.reduce((n, group) => n + group.count, 0) }
  }).filter(item => item.count > 0).sort((a, b) =>
    (b.sermon.sermon_date ?? b.sermon.modified_at.slice(0, 10))
      .localeCompare(a.sermon.sermon_date ?? a.sermon.modified_at.slice(0, 10)) ||
    a.sermon.name.localeCompare(b.sermon.name))
}
