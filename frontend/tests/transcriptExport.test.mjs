import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  copyEffectiveTranscript, formatTimestampedTranscript, formatTranscriptTime,
} from '../src/transcriptExport.ts'

const effective = {
  supports_effective_transcript: true,
  source: 'internal-media-name',
  repair: { repair_status: 'internal-repair-metadata' },
  edits: [{ corrected_text: 'internal-edit-metadata' }],
  segments: [
    { id: 19, start: 558.24, end: 562.61,
      text: 'Corrected sample sentence.',
      raw_words: [{ word: 'Uncorrected', start: 558.24, end: 559 }],
      words: [{ word: 'Corrected', start: 558.24, end: 559 }] },
    { id: 20, start: 562.61, end: 567.08,
      text: '  Exact spacing and punctuation!  ', words: [], raw_words: [] },
  ],
}

test('time formatting includes hours and milliseconds', () => {
  assert.equal(formatTranscriptTime(558.24), '00:09:18.240')
  assert.equal(formatTranscriptTime(3661.009), '01:01:01.009')
  assert.equal(formatTranscriptTime(59.9996), '00:01:00.000')
  assert.throws(() => formatTranscriptTime(Number.NaN), /Invalid transcript timestamp/)
})

test('export uses effective segment wording and times without metadata', () => {
  const text = formatTimestampedTranscript(effective.segments)
  assert.equal(text,
    '[00:09:18.240 - 00:09:22.610] Corrected sample sentence.\n' +
    '[00:09:22.610 - 00:09:27.080]   Exact spacing and punctuation!  ')
  for (const privateValue of ['Uncorrected', 'internal-media-name', 'internal-repair-metadata',
    'internal-edit-metadata', '19', '20']) {
    assert.equal(text.includes(privateValue), false)
  }
})

test('copy writes only the effective export and surfaces clipboard failures', async () => {
  const writes = []
  await copyEffectiveTranscript(effective, async text => { writes.push(text) })
  assert.deepEqual(writes, [formatTimestampedTranscript(effective.segments)])
  await assert.rejects(() => copyEffectiveTranscript(effective, async () => {
    throw new Error('Clipboard denied')
  }), /Clipboard denied/)
  await assert.rejects(() => copyEffectiveTranscript({ ...effective,
    supports_effective_transcript: false }, async text => { writes.push(text) }),
  /Effective transcript unavailable/)
  assert.equal(writes.length, 1)
})
