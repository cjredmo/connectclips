import type { CSSProperties } from 'react'
import type { CaptionStyle, TranscriptWord } from './types'

const FRAME_H = 1920
const MIN_GAP_FOR_BREAK = 0.55
const MAX_CHUNK_DURATION = 3.0

export function parseCaptionStylesResponse(value: unknown): { styles: CaptionStyle[]; default: string } {
  if (!value || typeof value !== 'object') throw new Error('Invalid caption style response')
  const response = value as { styles?: unknown; default?: unknown }
  if (!Array.isArray(response.styles) || typeof response.default !== 'string') {
    throw new Error('Invalid caption style response')
  }
  for (const item of response.styles) {
    if (!item || typeof item !== 'object') throw new Error('Invalid caption style descriptor')
    const style = item as Record<string, unknown>
    if (style.schema_version !== 1 ||
        !['bottom', 'middle', 'top'].includes(String(style.vertical_anchor)) ||
        !['key', 'label', 'font_name', 'primary_color', 'highlight_color',
          'outline_color', 'background_color'].every(field => typeof style[field] === 'string') ||
        !['font_size', 'font_weight', 'outline_width', 'shadow_depth',
          'highlight_scale', 'margin_v', 'max_words_per_chunk', 'max_chars_per_chunk',
          'background_opacity'].every(field => typeof style[field] === 'number' &&
            Number.isFinite(style[field])) ||
        typeof style.background_box !== 'boolean' ||
        (style.preview_highlight_color != null && typeof style.preview_highlight_color !== 'string') ||
        (style.preview_background_opacity != null &&
         (typeof style.preview_background_opacity !== 'number' ||
          !Number.isFinite(style.preview_background_opacity)))) {
      throw new Error('Unsupported caption style descriptor; restart the backend')
    }
  }
  return response as { styles: CaptionStyle[]; default: string }
}

export function captionPresentation(style: CaptionStyle): 'single_word' | 'progressive_chunk' {
  return style.max_words_per_chunk === 1 ? 'single_word' : 'progressive_chunk'
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
      if (cur.length >= style.max_words_per_chunk ||
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
  const pixels = style.outline_width <= 2
    ? Math.max(style.outline_width * 2.2, style.shadow_depth)
    : style.outline_width <= 6 ? 6 : style.outline_width + 1
  const offset = unit === 'cqh' ? `${pixels / 19.2}cqh` : `${pixels / 4}px`
  const parts = [`${offset} ${offset} 0 ${style.outline_color}`,
    `-${offset} ${offset} 0 ${style.outline_color}`]
  if (style.outline_width > 2) {
    parts.push(`${offset} -${offset} 0 ${style.outline_color}`,
      `-${offset} -${offset} 0 ${style.outline_color}`)
  }
  return parts.join(', ')
}

export function liveCaptionStyle(style: CaptionStyle, marginOverride: number | null): CSSProperties {
  return {
    bottom: `${captionBottomMargin(style, marginOverride) / 3}px`,
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
    fontWeight: single ? 800 : 700,
    fontSize: `${size * (small ? 0.46 : 1)}px`,
    color: style.primary_color,
    textShadow: captionTextShadow(style, 'px'),
    '--cp-primary': style.primary_color,
    '--cp-hl': style.preview_highlight_color ?? style.highlight_color,
    '--cp-hl-scale': String(style.highlight_scale / 100),
    '--cp-box': style.background_box
      ? rgba(style.background_color, style.preview_background_opacity ?? style.background_opacity)
      : 'transparent',
    '--cp-bottom': single ? '50%' : `${style.margin_v / FRAME_H * 100}%`,
  } as CSSProperties
}
