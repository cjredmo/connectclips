import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeTranscriptResponse, normalizeTranscriptStatus } from '../src/transcriptResponse.ts'

const clean = { status: 'clean', findings: [] }
const repair = {
  repair_exists: true,
  repair_status: 'accepted',
  repair_failure_reason: null,
  recent_repair_attempts: [],
  repaired_ranges: [],
  human_review_required: false,
  warnings: [],
}

test('effective transcript remains editable without an alignment sidecar', () => {
  const transcript = normalizeTranscriptResponse({
    source: 'sample.mp4', segments: [], edits: [], warnings: [],
    quality: clean, raw_quality: clean, effective_quality: clean, repair,
  })
  const status = normalizeTranscriptStatus({
    ...repair, raw_quality: clean, effective_quality: clean,
  })
  assert.equal(transcript.supports_effective_transcript, true)
  assert.equal(transcript.effective_quality.status, 'clean')
  assert.equal(status.alignment.status, 'not_aligned')
  assert.equal(status.alignment.acceptable, false)
})

test('older transcript response cannot crash the editor or enable corrections', () => {
  const transcript = normalizeTranscriptResponse({
    source: 'sample.mp4', segments: [], edits: [], warnings: [], quality: clean,
  })
  assert.equal(transcript.raw_quality.status, 'clean')
  assert.equal(transcript.effective_quality.status, 'unchecked')
  assert.equal(transcript.repair.human_review_required, false)
  assert.equal(transcript.supports_effective_transcript, false)
})

test('all alignment states survive status normalization', () => {
  for (const state of ['not_aligned', 'aligning', 'aligned', 'partially_aligned', 'stale', 'failed']) {
    const status = normalizeTranscriptStatus({
      ...repair, raw_quality: clean, effective_quality: clean,
      alignment: { status: state, acceptable: state === 'aligned' },
    })
    assert.equal(status.alignment.status, state)
    assert.deepEqual(status.alignment.stale_ranges, [])
    assert.deepEqual(status.alignment.diagnostics, [])
  }
  assert.equal(normalizeTranscriptStatus({}).alignment.status, 'not_aligned')
})
