import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityErrorSummary, activityLabel, activityMatches, activityProgress,
  activitySections, activityStatus } from '../src/activityPresentation.ts'

const job = (id, kind, status, created_at, extra = {}) => ({
  id, kind, status, created_at, source: 'sample.mp4', clip_index: null,
  user_name: null, user_login: null, progress_percent: null,
  progress_message: null, ...extra,
})

test('job kinds have readable labels without changing backend values', () => {
  const labels = {
    upload: 'Uploading source video', youtube_download: 'Importing source video',
    transcribe: 'Transcribing sermon', repair_transcript: 'Repairing transcript',
    align_transcript: 'Aligning transcript', select_clips: 'Selecting clips',
    export_clip: 'Exporting clip', prescan_faces: 'Preparing framing',
  }
  for (const [kind, label] of Object.entries(labels)) {
    assert.equal(activityLabel(job(kind, kind, 'done', '2026-01-01')), label)
  }
  assert.equal(activityLabel(job('one', 'export_clip', 'running', '2026-01-01', { clip_index: 2 })),
    'Exporting clip 3')
})

test('active work leads, failed work follows, and completion stays newest first', () => {
  const jobs = [job('old', 'upload', 'done', '2026-01-01'),
    job('fail', 'transcribe', 'failed', '2026-01-04'),
    job('new', 'export_clip', 'done', '2026-01-03'),
    job('active', 'align_transcript', 'running', '2026-01-02'),
    job('queued', 'prescan_faces', 'queued', '2026-01-05')]
  const sections = activitySections(jobs)
  assert.deepEqual(sections.active.map(item => item.id), ['queued', 'active'])
  assert.deepEqual(sections.failed.map(item => item.id), ['fail'])
  assert.deepEqual(sections.completed.map(item => item.id), ['new', 'old'])
  assert.deepEqual(activitySections([]), { active: [], failed: [], completed: [] })
  assert.deepEqual(activityStatus('queued'), { label: 'Queued', tone: 'neutral' })
  assert.deepEqual(activityStatus('failed'), { label: 'Failed', tone: 'failed' })
})

test('progress and failure summaries remain useful with missing or noisy data', () => {
  assert.equal(activityProgress(job('a', 'export_clip', 'running', '', { progress_percent: null })), null)
  assert.equal(activityProgress(job('b', 'export_clip', 'running', '', { progress_percent: 1.5 })), 1)
  assert.equal(activityProgress(job('c', 'export_clip', 'running', '', { progress_percent: -0.2 })), 0)
  assert.equal(activityErrorSummary('Traceback (most recent call last):\n  File "sample.py", line 1\nRuntimeError: unavailable'),
    'unavailable')
  assert.equal(activityErrorSummary('sample.module.AlignmentError: timing requires review'), 'timing requires review')
  assert.match(activityErrorSummary('TypeError: Could not resolve authentication method'), /could not authenticate/)
  assert.match(activityErrorSummary(null), /did not finish/)
  assert.equal(activityMatches(job('d', 'repair_transcript', 'failed', '', { user_name: 'Sample User' }), 'repair'), true)
  assert.equal(activityMatches(job('d', 'repair_transcript', 'failed', '', { user_name: 'Sample User' }), 'sample user'), true)
})
