import { parseManualClipTime } from './manualClipTime.ts'
import type { Clip } from './types'

export type ImportClip = {
  title: string
  start: number
  end: number
  description?: string
  why_selected?: string
  hook?: string
  score?: number
}

export type ImportPreview = { document: unknown; clips: ImportClip[] }

function seconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return typeof value === 'string' ? parseManualClipTime(value) : null
}

export function parseClipImportText(text: string): ImportPreview {
  let document: unknown
  try { document = JSON.parse(text) }
  catch { throw new Error('File is not valid JSON.') }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Import must be a JSON object.')
  }
  const data = document as Record<string, unknown>
  if (data.schema_version !== 1) throw new Error('Unsupported schema version; expected 1.')
  if (!Array.isArray(data.clips) || data.clips.length === 0) {
    throw new Error('clips must be a nonempty array.')
  }
  const clips = data.clips.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Clip ${index + 1} must be an object.`)
    }
    const clip = item as Record<string, unknown>
    const start = seconds(clip.start)
    const end = seconds(clip.end)
    if (typeof clip.title !== 'string' || !clip.title.trim() ||
        start === null || end === null || start < 0 || end <= start) {
      throw new Error(`Clip ${index + 1} needs a title and valid start/end times.`)
    }
    return { ...clip, title: clip.title.trim(), start, end } as ImportClip
  })
  return { document, clips }
}

export function clipDetailSections(clip: Pick<Clip, 'description' | 'why_selected' | 'hook'>) {
  return ([['Description', clip.description], ['Why this clip', clip.why_selected],
    ['Hook', clip.hook]] as const).filter(([, value]) => Boolean(value?.trim()))
}

export function importResultMessage(imported: number, duplicates: number): string {
  return `${imported} clip${imported === 1 ? '' : 's'} imported` +
    (duplicates ? `; ${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped` : '') + '.'
}
