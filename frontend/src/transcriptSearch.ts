import type { TranscriptSegment } from './types'

export type TranscriptMatch = { segmentIndex: number; start: number; excerpt: string }

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()

export function findTranscriptMatches(segments: TranscriptSegment[], query: string): TranscriptMatch[] {
  const needle = normalize(query)
  if (!needle) return []

  const blocks = segments.map(segment =>
    segment.words.map(word => word.word).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
  const offsets: number[] = []
  let text = ''
  for (const block of blocks) {
    if (text) text += ' '
    offsets.push(text.length)
    text += block
  }
  const haystack = text.toLocaleLowerCase()
  const matches: TranscriptMatch[] = []
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    let segmentIndex = offsets.length - 1
    while (segmentIndex > 0 && offsets[segmentIndex] > index) segmentIndex--
    matches.push({ segmentIndex, start: segments[segmentIndex].start,
      excerpt: blocks[segmentIndex] })
  }
  return matches
}
