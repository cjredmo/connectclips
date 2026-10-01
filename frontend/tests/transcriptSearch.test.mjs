import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findTranscriptMatches } from '../src/transcriptSearch.ts'

const segment = (id, start, text) => ({
  id, start, end: start + 2, text,
  words: text.split(' ').map((word, index) => ({ word, start: start + index / 2, end: start + index / 2 + 0.3 })),
  raw_words: [],
})

test('full transcript search finds a phrase in a later segment', () => {
  const segments = [segment(1, 0, 'A quiet opening'), segment(2, 120, 'The This reveals a point')]
  assert.deepEqual(findTranscriptMatches(segments, 'the this reveals').map(match =>
    [match.segmentIndex, match.start]), [[1, 120]])
})

test('search crosses a segment boundary and returns each occurrence', () => {
  const segments = [segment(1, 0, 'A phrase'), segment(2, 2, 'continues here'),
    segment(3, 4, 'A phrase continues again')]
  assert.deepEqual(findTranscriptMatches(segments, 'phrase continues').map(match => match.segmentIndex), [0, 2])
  assert.deepEqual(findTranscriptMatches(segments, '   '), [])
})
