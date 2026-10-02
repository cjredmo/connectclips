import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { captionWordState, currentWordIndex } from '../src/captionReveal.ts'
import {
  captionBottomMargin, captionChunkEnd, captionPresentation, chunkCaptionWords,
  liveCaptionStyle, parseCaptionStylesResponse, thumbnailStyle,
  editableStyleDraft, canEditStyle, canDeleteStyle, canEditPhraseSize, withPresentationMode,
  PRESENTATION_MODES, presentationLabel,
  BACKGROUND_DURATIONS, showBackgroundLingerInput, captionBackgroundIntervals,
  captionBackgroundAtTime,
} from '../src/captionStyles.ts'

// Read the canonical backend descriptors; this test deliberately keeps no
// independent frontend map of built-in preset values.
const backend = fileURLToPath(new URL('../../backend/', import.meta.url))
const python = fileURLToPath(new URL('../../backend/.venv/bin/python', import.meta.url))
const styles = JSON.parse(execFileSync(python, ['-c',
  'import json; from app.services.caption_styles import list_styles; print(json.dumps(list_styles()))',
], { cwd: backend, encoding: 'utf8' })).filter(style => style.built_in)
const byKey = Object.fromEntries(styles.map(style => [style.key, style]))
const words = [
  { text: 'From', start: 0, end: 0.3 },
  { text: 'top', start: 0.3, end: 0.6 },
  { text: 'to', start: 0.6, end: 0.9 },
]

test('all five API descriptors drive preview appearance without a preset map', () => {
  assert.deepEqual(parseCaptionStylesResponse({ styles, default: 'classic', fonts: ['Arial'] }).styles, styles)
  assert.throws(() => parseCaptionStylesResponse({ styles: [{ key: 'classic', label: 'Classic' }],
    default: 'classic', fonts: ['Arial'] }), /Unsupported caption style descriptor/)
  assert.deepEqual(styles.map(style => style.key),
    ['classic', 'neon_pop', 'block', 'white_block', 'word_pop'])
  for (const style of styles) {
    assert.equal(style.schema_version, 2)
    const live = liveCaptionStyle(style, null)
    const thumbnail = thumbnailStyle(style, false)
    assert.equal(live.color, style.primary_color)
    assert.equal(live['--cap-active-color'], style.preview_highlight_color ?? style.highlight_color)
    assert.equal(live['--cap-active-scale'], String(style.highlight_scale / 100))
    assert.equal(thumbnail['--cp-hl'], style.preview_highlight_color ?? style.highlight_color)
    assert.equal(live.fontSize, `${style.font_size / 19.2}cqh`)
    assert.equal(live.background === 'transparent', !style.background_box)
  }
})

test('chunk limits and presentation follow descriptor rather than style ID', () => {
  for (const style of styles) {
    const chunks = chunkCaptionWords(words, style)
    assert.equal(captionPresentation(style),
      style.presentation_mode)
    assert.deepEqual(chunks.map(chunk => chunk.length),
      style.max_words_per_chunk === 1 ? [1, 1, 1] : [3])
  }
  const renamed = { ...byKey.word_pop, key: 'synthetic-single-word' }
  assert.equal(captionPresentation(renamed), 'single_word')
  assert.deepEqual(chunkCaptionWords(words, renamed).map(chunk => chunk.length), [1, 1, 1])
  const full = { ...byKey.classic, key: 'synthetic-full', presentation_mode: 'full_chunk_highlight' }
  assert.deepEqual(chunkCaptionWords(words, full).map(chunk => chunk.length), [3])
  assert.deepEqual(words.map((_, index) => captionWordState(index, 0, full.presentation_mode)),
    ['current', 'spoken', 'spoken'])
  const progressive = { ...byKey.classic, key: 'synthetic-phrase' }
  const chunk = chunkCaptionWords(words, progressive)[0]
  assert.deepEqual(chunk.map((_, index) =>
    captionWordState(index, currentWordIndex(chunk, 0.3))),
  ['spoken', 'current', 'future'])
})

test('custom editing uses the canonical descriptor and immutable built-ins', () => {
  const original = byKey.classic
  const draft = editableStyleDraft(original)
  assert.equal(draft.key, '')
  assert.equal(draft.preview_highlight_color, null)
  assert.equal(draft.preview_background_opacity, null)
  assert.equal(original.preview_highlight_color, null)
  assert.equal(canEditStyle(original), false)
  assert.equal(canDeleteStyle(original), false)
  const edited = { ...draft, key: 'custom:synthetic', revision: 2,
    label: 'Renamed', presentation_mode: 'single_word', max_words_per_chunk: 8,
    highlight_color: '#123456' }
  assert.equal(canEditStyle(edited), true)
  assert.equal(canDeleteStyle(edited), true)
  assert.equal(canEditPhraseSize(edited), false)
  assert.deepEqual(chunkCaptionWords(words, edited).map(chunk => chunk.length), [1, 1, 1])
  const phrase = withPresentationMode(withPresentationMode(edited, 'single_word'),
    'full_chunk_highlight')
  assert.equal(canEditPhraseSize(phrase), true)
  assert.equal(phrase.max_words_per_chunk, 2)
  assert.deepEqual(chunkCaptionWords(words, phrase).map(chunk => chunk.length), [2, 1])
  assert.deepEqual(parseCaptionStylesResponse({ styles: [...styles, edited], default: 'classic',
    fonts: ['Arial'] }).styles.at(-1), edited)
  assert.equal(liveCaptionStyle(edited, null)['--cap-active-color'], '#123456')
  assert.equal(liveCaptionStyle(edited, 700).bottom, `${700 / 19.2}cqh`)
})

test('descriptor position is used until the per-clip override wins', () => {
  assert.equal(captionBottomMargin(byKey.classic, null), byKey.classic.margin_v)
  assert.equal(captionBottomMargin(byKey.word_pop, null), 960)
  assert.equal(captionBottomMargin(byKey.word_pop, 700), 700)
  assert.equal(liveCaptionStyle(byKey.classic, 777).bottom, `${777 / 19.2}cqh`)
})

test('all presentation modes have volunteer-facing labels and preserve draft fields', () => {
  assert.deepEqual(PRESENTATION_MODES.map(option => option.label),
    ['Single word', 'Progressive phrase', 'Full phrase highlight'])
  for (const option of PRESENTATION_MODES) {
    assert.equal(presentationLabel(option.value), option.label)
    assert.ok(option.description.length > 12)
    const draft = withPresentationMode(editableStyleDraft(byKey.block), option.value)
    assert.equal(draft.presentation_mode, option.value)
    assert.equal(draft.background_box, true)
    assert.equal(draft.font_name, byKey.block.font_name)
    assert.equal(draft.key, '')
  }
})

test('built-in style preview uses export colors, shadow, box, and stable keys', () => {
  for (const style of styles) {
    assert.equal(style.preview_highlight_color, null)
    assert.equal(style.preview_background_opacity, null)
    assert.equal(liveCaptionStyle(style, null)['--cap-active-color'], style.highlight_color)
    assert.equal(thumbnailStyle(style, false)['--cp-hl'], style.highlight_color)
    assert.equal(thumbnailStyle(style, false).fontWeight, style.font_weight)
    assert.equal(liveCaptionStyle(style, null).textShadow === 'none',
      style.outline_width === 0 && style.shadow_depth === 0)
    assert.equal(liveCaptionStyle(style, null).background === 'transparent', !style.background_box)
  }
})

test('box continuity bridges short gaps without extending words or genuine pauses', () => {
  const timed = [
    { text: 'One', start: 0, end: 0.2 },
    { text: 'two', start: 0.3, end: 0.5 },
    { text: 'three', start: 0.7, end: 0.9 },
    { text: 'Four', start: 1.6, end: 1.8 },
  ]
  const single = withPresentationMode(byKey.white_block, 'single_word')
  const singles = chunkCaptionWords(timed, single)
  assert.deepEqual(singles.map(chunk => chunk.length), [1, 1, 1, 1])
  assert.equal(captionChunkEnd(singles, 0, single, 2, false), 0.2)
  assert.equal(captionChunkEnd(singles, 0, single, 2, true), 0.3)
  assert.equal(captionChunkEnd(singles, 2, single, 2, true), 0.9)

  const progressive = { ...withPresentationMode(byKey.white_block, 'progressive_chunk'),
    max_words_per_chunk: 2 }
  const phrases = chunkCaptionWords(timed, progressive)
  assert.deepEqual(phrases.map(chunk => chunk.length), [2, 1, 1])
  assert.equal(captionChunkEnd(phrases, 0, progressive, 2, false), 0.5)
  assert.equal(captionChunkEnd(phrases, 0, progressive, 2, true), 0.7)
  assert.equal(captionChunkEnd(phrases, 1, progressive, 2, true), 0.9)
  assert.deepEqual(phrases[0].map((_, i) => captionWordState(i, 0, progressive.presentation_mode)),
    ['current', 'future'])

  const full = withPresentationMode(progressive, 'full_chunk_highlight')
  assert.equal(captionChunkEnd(phrases, 0, full, 2, false), 0.7)
  assert.equal(captionChunkEnd(phrases, 0, full, 2, true), 0.7)
  assert.deepEqual(phrases[0].map((_, i) => captionWordState(i, 0, full.presentation_mode)),
    ['current', 'spoken'])
  assert.equal(captionChunkEnd(phrases, 0, { ...progressive, background_box: false }, 2, true), 0.5)
})

test('old descriptors default to Follow captions without rewriting their source', () => {
  const old = { ...byKey.white_block }
  delete old.background_persistence
  delete old.background_linger_seconds
  const parsed = parseCaptionStylesResponse({ styles: [old], default: 'white_block', fonts: [] })
  assert.equal(parsed.styles[0].background_persistence, 'speech')
  assert.equal(parsed.styles[0].background_linger_seconds, 1)
  assert.equal(old.background_persistence, undefined)
  assert.deepEqual(BACKGROUND_DURATIONS.map(item => item.label),
    ['Follow captions', 'Hold for', 'Entire clip'])
  assert.throws(() => parseCaptionStylesResponse({ styles: [{ ...byKey.white_block,
    background_linger_seconds: Number.POSITIVE_INFINITY }], default: 'classic', fonts: [] }),
  /Unsupported caption style/)
  assert.throws(() => parseCaptionStylesResponse({ styles: [{ ...byKey.white_block,
    background_persistence: null }], default: 'classic', fonts: [] }),
  /Unsupported caption style/)
})

test('background intervals persist independently from unchanged caption text', () => {
  const timed = [
    { text: 'One', start: .2, end: .4 },
    { text: 'Two', start: 1, end: 1.2 },
    { text: 'Three', start: 3, end: 3.2 },
  ]
  const base = withPresentationMode(byKey.white_block, 'single_word')
  const chunks = chunkCaptionWords(timed, base)
  const intervals = style => captionBackgroundIntervals(chunks, style, 3.5)
  assert.deepEqual(intervals(base).map(({ start, end }) => [start, end]),
    [[.2, .4], [1, 1.2], [3, 3.2]])
  assert.equal(captionBackgroundAtTime(intervals(base), .8), null)
  const linger = { ...base, background_persistence: 'linger', background_linger_seconds: 1 }
  assert.deepEqual(intervals(linger).map(({ start, end }) => [start, end]),
    [[.2, 2.2], [3, 3.5]])
  assert.equal(captionBackgroundAtTime(intervals(linger), .8)?.start, .2)
  assert.equal(captionBackgroundAtTime(intervals(linger), 2.5), null)
  assert.equal(captionChunkEnd(chunks, 0, linger, 3.5), .4)
  assert.equal(captionChunkEnd(chunks, 0, base, 3.5), .4)
  assert.equal(showBackgroundLingerInput(base), false)
  assert.equal(showBackgroundLingerInput(linger), true)
  assert.equal(showBackgroundLingerInput({ ...linger, background_box: false }), false)
  const clip = { ...base, background_persistence: 'clip' }
  assert.deepEqual(intervals(clip).map(({ start, end }) => [start, end]), [[0, 3.5]])
  assert.ok(captionBackgroundAtTime(intervals(clip), 0))
  assert.ok(captionBackgroundAtTime(intervals(clip), 2.5))
  assert.equal(captionChunkEnd(chunks, 0, clip, 3.5), .4)
  assert.deepEqual(captionBackgroundIntervals([], clip, 3.5).map(({ start, end, chunk }) =>
    [start, end, chunk]), [[0, 3.5, null]])
  const saved = { ...linger, key: 'custom:synthetic', revision: 2 }
  assert.equal(editableStyleDraft(saved).background_persistence, 'linger')
  assert.equal(editableStyleDraft(saved).background_linger_seconds, 1)
  assert.deepEqual(parseCaptionStylesResponse({ styles: [saved], default: 'classic',
    fonts: [] }).styles[0], saved)
})
