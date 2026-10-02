import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { captionWordState, currentWordIndex } from '../src/captionReveal.ts'
import {
  captionBottomMargin, captionPresentation, chunkCaptionWords,
  liveCaptionStyle, parseCaptionStylesResponse, thumbnailStyle,
  editableStyleDraft, canEditStyle, canDeleteStyle, canEditPhraseSize, withPresentationMode,
} from '../src/captionStyles.ts'

// Read the canonical backend descriptors; this test deliberately keeps no
// independent frontend map of built-in preset values.
const backend = fileURLToPath(new URL('../../backend/', import.meta.url))
const python = fileURLToPath(new URL('../../backend/.venv/bin/python', import.meta.url))
const styles = JSON.parse(execFileSync(python, ['-c',
  'import json; from app.services.caption_styles import list_styles; print(json.dumps(list_styles()))',
], { cwd: backend, encoding: 'utf8' }))
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
  assert.equal(original.preview_highlight_color, '#FFD700')
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
  assert.equal(liveCaptionStyle(edited, 700).bottom, `${700 / 3}px`)
})

test('descriptor position is used until the per-clip override wins', () => {
  assert.equal(captionBottomMargin(byKey.classic, null), byKey.classic.margin_v)
  assert.equal(captionBottomMargin(byKey.word_pop, null), 960)
  assert.equal(captionBottomMargin(byKey.word_pop, 700), 700)
  assert.equal(liveCaptionStyle(byKey.classic, 777).bottom, '259px')
})
