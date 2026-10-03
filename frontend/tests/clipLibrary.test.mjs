import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPath, parsePath } from '../src/appRoutes.ts'
import { buildLibrary, clipMatches, dateLabel, suitability } from '../src/clipLibrary.ts'

const sermon = (name, sermon_date = null, modified_at = '2026-01-02T12:00:00Z') =>
  ({ name, sermon_date, modified_at })
const clip = (id, title, fields = {}) => ({ id, title, selection_method: 'manual',
  selection_prompt_id: null, selection_prompt_name: null, selection_batch_id: null,
  selection_created_at: null, scripture_reference: null, ...fields })

test('Clips route parses, builds and leaves sermon/editor routes intact', () => {
  assert.deepEqual(parsePath('/clips'), { name: 'clips' })
  assert.deepEqual(parsePath('/clips/'), { name: 'clips' })
  assert.equal(buildPath({ name: 'clips' }), '/clips')
  assert.deepEqual(parsePath('/sermons/sample.mp4/clip/2'),
    { name: 'trim', sermonName: 'sample.mp4', clipIndex: 2 })
})

test('library sorts sermons, nests prompt groups and preserves original clip indices when filtered', () => {
  const older = sermon('Older sample.mp4', null, '2026-01-01T12:00:00Z')
  const newer = sermon('Newer sample.mp4', '2026-03-01')
  const prompt = { selection_method: 'ai_chat', selection_prompt_id: 'sample',
    selection_prompt_name: 'Teaching', selection_batch_id: 'run-a' }
  const collections = [
    { sermon: older, clips: [clip('old', 'Older item')] },
    { sermon: newer, clips: [clip('manual', 'Manual item'),
      clip('p1', 'First teaching', prompt), clip('p2', 'Second teaching', prompt)] },
  ]
  const all = buildLibrary(collections)
  assert.deepEqual(all.map(item => item.sermon.name), [newer.name, older.name])
  assert.deepEqual(all[0].groups.map(group => group.label), ['Teaching', 'Manual'])
  const filtered = buildLibrary(collections, 'Second teaching')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].groups.length, 1)
  assert.equal(filtered[0].groups[0].batches[0].clips[0].index, 2)
  assert.equal(filtered[0].groups[0].batches[0].clips[0].clip.id, 'p2')
  assert.deepEqual(buildLibrary(collections, 'absent'), [])
})

test('search matches sermon, scripture, prompt, hook and description', () => {
  const s = sermon('Sample sermon.mp4')
  const c = clip('one', 'Generic title', { scripture_reference: 'Sample 2:3',
    selection_prompt_name: 'Teaching', hook: 'An opening idea', description: 'A brief summary' })
  for (const value of ['sermon', '2:3', 'teaching', 'opening', 'SUMMARY', 'title']) {
    assert.equal(clipMatches(c, s, 'Teaching', value), true)
  }
  assert.equal(clipMatches(c, s, 'Teaching', 'other'), false)
})

test('optional date and score are not invented', () => {
  assert.match(dateLabel(sermon('sample.mp4')), /^Updated /)
  assert.match(dateLabel(sermon('sample.mp4', '2026-02-03')), /^Sermon date /)
  assert.equal(suitability(clip('a', 'No score')), null)
  assert.equal(suitability(clip('b', 'Scored', { score: 87 })), 87)
})
