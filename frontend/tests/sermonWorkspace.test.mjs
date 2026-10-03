import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  nextSermonAction, parseSermonSectionPath, sermonSectionPath, transcriptPresentation,
} from '../src/sermonWorkspace.ts'

const sermon = {
  name: 'example recording.mp4', size_bytes: 1024, modified_at: '2026-01-01T00:00:00Z',
  transcribed: true, clips_selected: false, n_clips: 0,
}
const status = {
  effective_quality: { status: 'clean' }, raw_quality: { status: 'failed' },
  human_review_required: false, alignment: { status: 'aligned', acceptable: true },
}

test('existing sermon URL remains Overview and all workspace destinations round-trip', () => {
  assert.deepEqual(parseSermonSectionPath('/sermons/example%20recording.mp4'),
    { name: sermon.name, section: 'overview' })
  for (const section of ['overview', 'transcript', 'clips', 'exports']) {
    assert.deepEqual(parseSermonSectionPath(sermonSectionPath(sermon.name, section)),
      { name: sermon.name, section })
  }
  assert.deepEqual(parseSermonSectionPath('/sermons/example%20recording.mp4/overview'),
    { name: sermon.name, section: 'overview' })
  assert.equal(parseSermonSectionPath('/sermons/example%20recording.mp4/clip/0'), null)
})

test('recommended action follows existing transcript and clip readiness', () => {
  assert.deepEqual(nextSermonAction({ ...sermon, transcribed: false }, null, false),
    { label: 'Start transcription', section: 'overview', action: 'transcribe' })
  assert.equal(nextSermonAction(sermon, null, false).section, 'transcript')
  assert.equal(nextSermonAction(sermon, { ...status, human_review_required: true }, false).section, 'transcript')
  assert.deepEqual(nextSermonAction(sermon, status, false),
    { label: 'Create clips', section: 'clips', action: 'navigate' })
  assert.equal(nextSermonAction(sermon, { ...status, alignment: undefined }, false).section, 'clips')
  assert.equal(nextSermonAction({ ...sermon, n_clips: 2 }, status, false).label, 'Review clips')
})

test('accepted effective transcript outweighs old raw-quality failure', () => {
  assert.deepEqual(transcriptPresentation(sermon, status, false),
    { label: 'Ready', tone: 'success', detail: 'The effective transcript is ready for clip creation.' })
  assert.equal(transcriptPresentation(sermon, { ...status, alignment: undefined }, false).label,
    'Ready')
  assert.equal(transcriptPresentation(sermon, { ...status, human_review_required: true }, false).label,
    'Needs review')
  assert.equal(transcriptPresentation(sermon, { ...status, human_review_required: true }, false, true).detail,
    'Repairing the transcript.')
})
