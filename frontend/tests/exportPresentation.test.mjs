import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildExportItems, latestExportJobs } from '../src/exportPresentation.ts'

const clip = (id, overrides = {}) => ({
  id, title: `Clip ${id}`, start: 10, end: 30, exported: false,
  output_filename: null, previous_export: null, last_exported_at: null,
  last_exported_by_name: null, ...overrides,
})
const job = (id, status, index, created_at, extra = {}) => ({
  id, kind: 'export_clip', status, clip_index: index, created_at,
  output_clip_path: null, ...extra,
})

test('current export uses recorded export metadata and keeps filename secondary', () => {
  const clips = [clip('one', { exported: true, output_filename: 'clip-one.mp4',
    last_exported_at: '2026-01-04T12:00:00Z', last_exported_by_name: 'Sample User' })]
  const jobs = [job('matching', 'done', 0, '2026-01-04', {
    output_clip_path: '/runtime/clip-one.mp4', start: 12, end: 28,
    caption_style_name: 'Sample style', user_name: 'Sample User',
  })]
  const [item] = buildExportItems(clips, jobs)
  assert.equal(item.state, 'current')
  assert.equal(item.filename, 'clip-one.mp4')
  assert.equal(item.index, 0)
  assert.deepEqual([item.start, item.end], [12, 28])
  assert.equal(item.captionStyle, 'Sample style')
  assert.equal(item.byName, 'Sample User')
})

test('previous files stay downloadable and do not inherit current metadata', () => {
  const clips = [clip('old', { previous_export: { filename: 'older.mp4', start: 8,
    end: 24, exported_at: '2026-01-02T12:00:00Z', by_name: null } })]
  const [item] = buildExportItems(clips, [])
  assert.equal(item.state, 'previous')
  assert.equal(item.filename, 'older.mp4')
  assert.deepEqual([item.start, item.end], [8, 24])
  assert.equal(item.captionStyle, null)
  assert.deepEqual(buildExportItems([], []), [])
})

test('missing metadata is omitted; recent running and failed work is limited to each clip', () => {
  const clips = [clip('one', { exported: true, output_filename: 'ready.mp4' })]
  const [item] = buildExportItems(clips, [])
  assert.equal(item.captionStyle, null)
  assert.equal(item.exportedAt, null)
  assert.equal(item.byName, null)
  const jobs = [job('old', 'failed', 0, '2026-01-01'),
    job('new', 'running', 0, '2026-01-03'),
    job('other', 'failed', 1, '2026-01-02'),
    job('done', 'done', 2, '2026-01-04')]
  assert.deepEqual(latestExportJobs(jobs).map(item => item.id), ['new', 'other'])
})
