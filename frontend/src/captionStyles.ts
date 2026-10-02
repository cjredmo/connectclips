import type { CSSProperties } from 'react'
import type { CaptionPresentation, CaptionStyle, TranscriptWord } from './types'

export const PRESENTATION_MODES: { value: CaptionPresentation; label: string; description: string }[] = [
  { value: 'single_word', label: 'Single word', description: 'Show one spoken word at a time.' },
  { value: 'progressive_chunk', label: 'Progressive phrase', description: 'Reveal each word as it is spoken.' },
  { value: 'full_chunk_highlight', label: 'Full phrase highlight', description: 'Show the phrase and emphasize the spoken word.' },
]

export const BACKGROUND_DURATIONS: { value: CaptionStyle['background_persistence']; label: string }[] = [
  { value: 'speech', label: 'Follow captions' },
  { value: 'linger', label: 'Hold for' },
  { value: 'clip', label: 'Entire clip' },
]

export function showBackgroundLingerInput(style: CaptionStyle): boolean {
  return style.background_box && style.background_persistence === 'linger'
}

export function presentationLabel(mode: CaptionPresentation): string {
  return PRESENTATION_MODES.find(option => option.value === mode)?.label ?? mode
}

const FRAME_H = 1920
const MIN_GAP_FOR_BREAK = 0.55
const MAX_CHUNK_DURATION = 3.0

// Text ends at the last word in single/progressive modes. A background box may
// bridge only a short gap to the next chunk; a genuine pause still clears it.
export function captionChunkEnd(
  chunks: TranscriptWord[][], index: number, style: CaptionStyle,
  clipDuration: number, background = false,
): number {
  const lastEnd = chunks[index].at(-1)!.end
  const nextStart = chunks[index + 1]?.[0].start
  if (style.presentation_mode === 'full_chunk_highlight') {
    return nextStart ?? Math.max(lastEnd, clipDuration)
  }
  if (nextStart == null) return lastEnd
  if (background && style.background_box && nextStart - lastEnd <= MIN_GAP_FOR_BREAK) {
    return nextStart
  }
  return Math.min(lastEnd, nextStart)
}

export type CaptionBackgroundInterval = {
  start: number
  end: number
  chunk: TranscriptWord[] | null
}

// The box has its own timeline. Connected chunks share one interval so opacity
// never stacks and the preview does not remount its background between words.
export function captionBackgroundIntervals(
  chunks: TranscriptWord[][], style: CaptionStyle, clipDuration: number,
): CaptionBackgroundInterval[] {
  if (!style.background_box) return []
  if (style.background_persistence === 'clip') {
    const chunk = chunks.reduce<TranscriptWord[] | null>((best, current) =>
      !best || current.map(word => word.text).join(' ').length >
        best.map(word => word.text).join(' ').length ? current : best, null)
    return clipDuration > 0 ? [{ start: 0, end: clipDuration, chunk }] : []
  }
  const intervals: CaptionBackgroundInterval[] = []
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    const start = chunk[0].start
    const textEnd = captionChunkEnd(chunks, index, style, clipDuration)
    let end = captionChunkEnd(chunks, index, style, clipDuration, true)
    if (style.background_persistence === 'linger') {
      end = Math.max(end, textEnd + style.background_linger_seconds)
      if (clipDuration > 0) end = Math.min(end, clipDuration)
    }
    if (end <= start) continue
    const last = intervals.at(-1)
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
      if (!last.chunk || chunk.map(word => word.text).join(' ').length >
          last.chunk.map(word => word.text).join(' ').length) last.chunk = chunk
    } else {
      intervals.push({ start, end, chunk })
    }
  }
  return intervals
}

export function captionBackgroundAtTime(
  intervals: CaptionBackgroundInterval[], time: number,
): CaptionBackgroundInterval | null {
  return intervals.find(interval => time >= interval.start && time < interval.end) ?? null
}

export function parseCaptionStylesResponse(value: unknown): { styles: CaptionStyle[]; default: string; fonts: string[] } {
  if (!value || typeof value !== 'object') throw new Error('Invalid caption style response')
  const response = value as { styles?: unknown; default?: unknown; fonts?: unknown }
  if (!Array.isArray(response.styles) || typeof response.default !== 'string' ||
      !Array.isArray(response.fonts) || !response.fonts.every(font => typeof font === 'string')) {
    throw new Error('Invalid caption style response')
  }
  const styles: CaptionStyle[] = []
  for (const item of response.styles) {
    if (!item || typeof item !== 'object') throw new Error('Invalid caption style descriptor')
    const style = item as Record<string, unknown>
    const persistence = style.background_persistence === undefined
      ? 'speech' : style.background_persistence
    const linger = style.background_linger_seconds === undefined
      ? 1.0 : style.background_linger_seconds
    if (style.schema_version !== 2 ||
        !['single_word', 'progressive_chunk', 'full_chunk_highlight'].includes(
          String(style.presentation_mode)) ||
        !['bottom', 'middle', 'top'].includes(String(style.vertical_anchor)) ||
        !['key', 'label', 'font_name', 'primary_color', 'highlight_color',
          'outline_color', 'background_color'].every(field => typeof style[field] === 'string') ||
        !['font_size', 'font_weight', 'outline_width', 'shadow_depth',
          'highlight_scale', 'margin_v', 'max_words_per_chunk', 'max_chars_per_chunk',
          'background_opacity'].every(field => typeof style[field] === 'number' &&
            Number.isFinite(style[field])) ||
        typeof style.background_box !== 'boolean' ||
        !BACKGROUND_DURATIONS.some(option => option.value === persistence) ||
        typeof linger !== 'number' || !Number.isFinite(linger) || linger < 0 || linger > 10 ||
        typeof style.built_in !== 'boolean' || typeof style.editable !== 'boolean' ||
        !(style.revision === null || (typeof style.revision === 'number' &&
          Number.isInteger(style.revision) && style.revision > 0)) ||
        (style.preview_highlight_color != null && typeof style.preview_highlight_color !== 'string') ||
        (style.preview_background_opacity != null &&
         (typeof style.preview_background_opacity !== 'number' ||
          !Number.isFinite(style.preview_background_opacity)))) {
      throw new Error('Unsupported caption style descriptor; restart the backend')
    }
    styles.push({ ...style, background_persistence: persistence,
      background_linger_seconds: linger } as CaptionStyle)
  }
  return { styles, default: response.default, fonts: response.fonts }
}

export function editableStyleDraft(base: CaptionStyle): CaptionStyle {
  return { ...base, key: '', label: `Copy of ${base.label}`,
    built_in: false, editable: true, revision: null,
    preview_highlight_color: null, preview_background_opacity: null }
}

export function canEditStyle(style: CaptionStyle): boolean { return style.editable && !style.built_in }
export function canDeleteStyle(style: CaptionStyle): boolean { return canEditStyle(style) }
export function canEditPhraseSize(style: CaptionStyle): boolean {
  return style.presentation_mode !== 'single_word'
}
export function withPresentationMode(style: CaptionStyle, mode: CaptionPresentation): CaptionStyle {
  return { ...style, presentation_mode: mode,
    max_words_per_chunk: mode === 'single_word' ? 1 : Math.max(2, style.max_words_per_chunk) }
}

export function captionPresentation(style: CaptionStyle) {
  return style.presentation_mode
}

// Matches backend captions.chunk_words; the style supplies both chunk limits.
export function chunkCaptionWords(words: TranscriptWord[], style: CaptionStyle): TranscriptWord[][] {
  const chunks: TranscriptWord[][] = []
  let cur: TranscriptWord[] = []
  for (const word of words) {
    if (cur.length > 0) {
      const chars = cur.reduce((count, item) => count + item.text.length, 0) + cur.length
      const duration = cur[cur.length - 1].end - cur[0].start
      const gap = word.start - cur[cur.length - 1].end
      const endsSentence = cur[cur.length - 1].text.endsWith('.') ||
        cur[cur.length - 1].text.endsWith('?') || cur[cur.length - 1].text.endsWith('!')
      if (cur.length >= (style.presentation_mode === 'single_word' ? 1 : style.max_words_per_chunk) ||
          chars + 1 + word.text.length > style.max_chars_per_chunk ||
          duration >= MAX_CHUNK_DURATION || gap > MIN_GAP_FOR_BREAK || endsSentence) {
        chunks.push(cur)
        cur = []
      }
    }
    cur.push(word)
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

export function captionBottomMargin(style: CaptionStyle, override: number | null): number {
  if (override !== null) return override
  if (style.vertical_anchor === 'middle') return FRAME_H / 2
  if (style.vertical_anchor === 'top') return FRAME_H - style.margin_v
  return style.margin_v
}

export function rgba(hex: string, opacity: number): string {
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
  return `rgba(${rgb.join(',')},${opacity})`
}

// CSS shadows approximate libass's outline and shadow at preview resolution.
// These distances reproduce the current built-ins without using their IDs.
export function captionTextShadow(style: CaptionStyle, unit: 'cqh' | 'px'): string {
  if (style.outline_width === 0 && style.shadow_depth === 0) return 'none'
  const size = (value: number) => unit === 'cqh' ? `${value / 19.2}cqh` : `${value / 4}px`
  const offset = size(style.outline_width)
  const negative = size(-style.outline_width)
  const parts = style.outline_width > 0 ? [
    `${offset} 0 0 ${style.outline_color}`, `${negative} 0 0 ${style.outline_color}`,
    `0 ${offset} 0 ${style.outline_color}`, `0 ${negative} 0 ${style.outline_color}`,
    `${offset} ${offset} 0 ${style.outline_color}`, `${negative} ${offset} 0 ${style.outline_color}`,
    `${offset} ${negative} 0 ${style.outline_color}`, `${negative} ${negative} 0 ${style.outline_color}`,
  ] : []
  if (style.shadow_depth > 0) {
    const depth = size(style.shadow_depth)
    parts.push(`${depth} ${depth} 0 #000000`)
  }
  return parts.join(', ')
}

export function liveCaptionStyle(style: CaptionStyle, marginOverride: number | null): CSSProperties {
  return {
    bottom: `${captionBottomMargin(style, marginOverride) / 19.2}cqh`,
    fontFamily: `'${style.font_name.replaceAll("'", "\\'")}', Arial, sans-serif`,
    fontSize: `${style.font_size / 19.2}cqh`,
    fontWeight: style.font_weight,
    color: style.primary_color,
    textShadow: captionTextShadow(style, 'cqh'),
    background: style.background_box
      ? rgba(style.background_color, style.preview_background_opacity ?? style.background_opacity)
      : 'transparent',
    padding: style.background_box ? '1.25cqh 0 1.88cqh' : '4px 0',
    '--cap-active-color': style.preview_highlight_color ?? style.highlight_color,
    '--cap-active-scale': String(style.highlight_scale / 100),
  } as CSSProperties
}

export function thumbnailStyle(style: CaptionStyle, small: boolean): CSSProperties {
  const single = captionPresentation(style) === 'single_word'
  const size = single ? style.font_size / 5 : style.font_size / 7
  return {
    fontFamily: `'${style.font_name.replaceAll("'", "\\'")}', Arial, sans-serif`,
    fontWeight: style.font_weight,
    fontSize: `${size * (small ? 0.46 : 1)}px`,
    color: style.primary_color,
    textShadow: captionTextShadow(style, 'px'),
    '--cp-primary': style.primary_color,
    '--cp-hl': style.preview_highlight_color ?? style.highlight_color,
    '--cp-hl-scale': String(style.highlight_scale / 100),
    '--cp-box': style.background_box
      ? rgba(style.background_color, style.preview_background_opacity ?? style.background_opacity)
      : 'transparent',
    '--cp-bottom': single ? '50%' : `${captionBottomMargin(style, null) / FRAME_H * 100}%`,
  } as CSSProperties
}
