import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clipDetailSections, importResultMessage, parseClipImportText } from '../src/clipImport.ts'

test('version 1 JSON produces a multi-clip review preview', () => {
  const preview = parseClipImportText(JSON.stringify({ schema_version: 1, clips: [
    { title: 'First sample', start: '9:18.2', end: '09:45.000',
      description: 'Neutral summary.', why_selected: 'Complete thought.',
      hook: 'Clear opening.', score: 82, scripture_reference: 'Isaiah 6' },
    { title: 'Second sample', start: '1:09:18.250', end: 4160 },
  ] }))
  assert.equal(preview.clips.length, 2)
  assert.deepEqual([preview.clips[0].start, preview.clips[0].end], [558.2, 585])
  assert.equal(preview.clips[1].start, 4158.25)
  assert.equal(preview.clips[0].description, 'Neutral summary.')
  assert.equal(preview.clips[0].score, 82)
  assert.equal(preview.clips[0].scripture_reference, 'Isaiah 6')
  assert.equal(preview.clips[1].scripture_reference, undefined)
})

test('optional metadata displays only present sections', () => {
  assert.deepEqual(clipDetailSections({ description: 'Summary.', why_selected: 'Reason.', hook: 'Opening.' }),
    [['Description', 'Summary.'], ['Why this clip', 'Reason.'], ['Hook', 'Opening.']])
  assert.deepEqual(clipDetailSections({ hook: 'Opening.' }), [['Hook', 'Opening.']])
  assert.deepEqual(clipDetailSections({}), [])
  assert.deepEqual(clipDetailSections({ description: '  ' }), [])
})

test('duplicate counts and malformed file errors are clear', () => {
  assert.equal(importResultMessage(2, 1), '2 clips imported; 1 duplicate skipped.')
  assert.equal(importResultMessage(0, 2), '0 clips imported; 2 duplicates skipped.')
  assert.throws(() => parseClipImportText('not JSON'), /not valid JSON/)
  assert.throws(() => parseClipImportText('{}'), /schema version/)
  assert.throws(() => parseClipImportText('{"schema_version":1,"clips":[]}'), /nonempty/)
  assert.throws(() => parseClipImportText('{"schema_version":1,"clips":[{"title":"Sample","start":"bad","end":"9:18"}]}'),
    /Clip 1/)
})
