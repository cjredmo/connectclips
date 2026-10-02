import type { TranscriptResponse, TranscriptSegment } from './types'

export function formatTranscriptTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid transcript timestamp')
  const milliseconds = Math.round(seconds * 1000)
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const wholeSeconds = Math.floor(milliseconds / 1000) % 60
  const remainder = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(wholeSeconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

export function formatTimestampedTranscript(segments: TranscriptSegment[]): string {
  return segments.map(segment =>
    `[${formatTranscriptTime(segment.start)} - ${formatTranscriptTime(segment.end)}] ${segment.text}`,
  ).join('\n')
}

export async function copyEffectiveTranscript(
  transcript: TranscriptResponse,
  writeText: (text: string) => Promise<void>,
): Promise<void> {
  if (!transcript.supports_effective_transcript) {
    throw new Error('Effective transcript unavailable; restart the backend before copying')
  }
  if (transcript.segments.length === 0) throw new Error('No transcript text is available to copy')
  await writeText(formatTimestampedTranscript(transcript.segments))
}
