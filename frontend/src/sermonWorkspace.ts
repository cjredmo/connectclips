import type { Sermon, TranscriptStatus } from './types'

export type SermonSection = 'overview' | 'transcript' | 'clips' | 'exports'

export const SERMON_SECTIONS: readonly SermonSection[] = ['overview', 'transcript', 'clips', 'exports']

// Keep the original sermon URL as Overview so existing bookmarks continue to work.
export function sermonSectionPath(name: string, section: SermonSection): string {
  const base = `/sermons/${encodeURIComponent(name)}`
  return section === 'overview' ? base : `${base}/${section}`
}

export function parseSermonSectionPath(pathname: string): { name: string; section: SermonSection } | null {
  const match = pathname.match(/^\/sermons\/([^/]+)(?:\/(overview|transcript|clips|exports))?\/?$/)
  if (!match) return null
  return { name: decodeURIComponent(match[1]), section: (match[2] as SermonSection | undefined) ?? 'overview' }
}

export type TranscriptPresentation = {
  label: string
  tone: 'success' | 'processing' | 'warning' | 'failed' | 'neutral'
  detail: string
}

export function transcriptPresentation(sermon: Sermon, status: TranscriptStatus | null,
  transcribing: boolean, repairing = false): TranscriptPresentation {
  if (!sermon.transcribed) return transcribing
    ? { label: 'Processing', tone: 'processing', detail: 'Transcription is running.' }
    : { label: 'Not started', tone: 'neutral', detail: 'Transcribe the source to review its text.' }
  if (!status) return { label: 'Checking', tone: 'processing', detail: 'Checking the effective transcript.' }
  if (repairing) return { label: 'Processing', tone: 'processing', detail: 'Repairing the transcript.' }
  if (status.human_review_required || !['clean', 'warning'].includes(status.effective_quality.status)) {
    return { label: 'Needs review', tone: 'warning', detail: 'Review the effective transcript before clip selection.' }
  }
  return { label: 'Ready', tone: 'success', detail: 'The effective transcript is ready for clip creation.' }
}

export function nextSermonAction(sermon: Sermon, status: TranscriptStatus | null,
  transcribing: boolean): { label: string; section: SermonSection; action: 'transcribe' | 'navigate' } {
  if (!sermon.transcribed) return transcribing
    ? { label: 'View transcript status', section: 'transcript', action: 'navigate' }
    : { label: 'Start transcription', section: 'overview', action: 'transcribe' }
  if (!status || status.human_review_required || !['clean', 'warning'].includes(status.effective_quality.status)) {
    return { label: 'Review transcript', section: 'transcript', action: 'navigate' }
  }
  return { label: sermon.n_clips > 0 ? 'Review clips' : 'Create clips', section: 'clips', action: 'navigate' }
}
