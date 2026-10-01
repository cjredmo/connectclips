import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { captionWordState, currentWordIndex } from '../src/captionReveal.ts'
import {
  captionBottomMargin, captionPresentation, chunkCaptionWords,
  liveCaptionStyle, parseCaptionStylesResponse, thumbnailStyle,
} from '../src/captionStyles.ts'

// Read the canonical backend descriptors; this test deliberately keeps no
// independent frontend map of built-in preset values.
const backend = fileURLToPath(new URL('../../backend/', import.meta.url))
const styles = JSON.parse(execFileSync('python3', ['-c',
  'import json; from app.services.captions import list_styles; print(json.dumps(list_styles()))',
], { cwd: backend, encoding: 'utf8' }))
const byKey = Object.fromEntries(styles.map(style => [style.key, style]))
const words = [
  { text: 'From', start: 0, end: 0.3 },
  { text: 'top', start: 0.3, end: 0.6 },
  { text: 'to', start: 0.6, end: 0.9 },
]

test('all five API descriptors drive preview appearance without a preset map', () => {
  assert.deepEqual(parseCaptionStylesResponse({ styles, default: 'classic' }).styles, styles)
  assert.throws(() => parseCaptionStylesResponse({ styles: [{ key: 'classic', label: 'Classic' }],
    default: 'classic' }), /Unsupported caption style descriptor/)
  assert.deepEqual(styles.map(style => style.key),
    ['classic', 'neon_pop', 'block', 'white_block', 'word_pop'])
  for (const style of styles) {
    assert.equal(style.schema_version, 1)
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
      style.max_words_per_chunk === 1 ? 'single_word' : 'progressive_chunk')
    assert.deepEqual(chunks.map(chunk => chunk.length),
      style.max_words_per_chunk === 1 ? [1, 1, 1] : [3])
  }
  const renamed = { ...byKey.word_pop, key: 'synthetic-single-word' }
  assert.equal(captionPresentation(renamed), 'single_word')
  assert.deepEqual(chunkCaptionWords(words, renamed).map(chunk => chunk.length), [1, 1, 1])
  const progressive = { ...byKey.classic, key: 'synthetic-phrase' }
  const chunk = chunkCaptionWords(words, progressive)[0]
  assert.deepEqual(chunk.map((_, index) =>
    captionWordState(index, currentWordIndex(chunk, 0.3))),
  ['spoken', 'current', 'future'])
})

test('descriptor position is used until the per-clip override wins', () => {
  assert.equal(captionBottomMargin(byKey.classic, null), byKey.classic.margin_v)
  assert.equal(captionBottomMargin(byKey.word_pop, null), 960)
  assert.equal(captionBottomMargin(byKey.word_pop, 700), 700)
  assert.equal(liveCaptionStyle(byKey.classic, 777).bottom, '259px')
})
