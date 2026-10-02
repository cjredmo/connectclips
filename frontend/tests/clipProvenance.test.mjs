import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupClips } from '../src/clipProvenance.ts'

function clip(id, selection_method = null, fields = {}) {
  return { id, selection_method, selection_prompt_id: null, selection_prompt_name: null,
    selection_batch_id: null, selection_created_at: null, ...fields }
}

test('groups prompt snapshots first, followed by known sources and legacy', () => {
  const clips = [
    clip('legacy'),
    clip('manual', 'manual'),
    clip('teaching', 'ai_chat', { selection_prompt_id: 'teaching',
      selection_prompt_name: 'Teaching / Theology' }),
    clip('import', 'json_import'),
    clip('claude', 'claude_api'),
    clip('custom', 'ai_chat', { selection_prompt_id: 'custom:synthetic',
      selection_prompt_name: 'Gospel Moments' }),
    clip('pastoral', 'ai_chat', { selection_prompt_id: 'pastoral',
      selection_prompt_name: 'Pastoral / Application' }),
    clip('unknown-prompt', 'ai_chat'),
  ]
  const groups = groupClips(clips)
  assert.deepEqual(groups.map(group => group.label), [
    'Teaching / Theology', 'Gospel Moments', 'Pastoral / Application',
    'Claude API', 'Imported JSON', 'Manual', 'Legacy / Unclassified',
  ])
  assert.equal(groups[1].promptId, 'custom:synthetic')
  assert.deepEqual(groups.at(-1).batches[0].clips.map(item => item.clip.id),
    ['legacy', 'unknown-prompt'])
})

test('keeps distinct prompt runs and original clip indices for actions', () => {
  const prompt = { selection_prompt_id: 'teaching', selection_prompt_name: 'Teaching / Theology' }
  const clips = [
    clip('other', 'manual'),
    clip('first-a', 'ai_chat', { ...prompt, selection_batch_id: 'run-a',
      selection_created_at: '2026-01-01T10:00:00Z' }),
    clip('second-a', 'ai_chat', { ...prompt, selection_batch_id: 'run-b',
      selection_created_at: '2026-01-02T10:00:00Z' }),
    clip('first-b', 'ai_chat', { ...prompt, selection_batch_id: 'run-a' }),
  ]
  const groups = groupClips(clips)
  assert.deepEqual(groups[0].batches.map(batch => batch.batchId), ['run-a', 'run-b'])
  assert.deepEqual(groups[0].batches.map(batch => batch.clips.map(item => item.index)),
    [[1, 3], [2]])
  assert.equal(groups[0].batches[0].selectedAt, '2026-01-01T10:00:00Z')
  for (const { clip: stored, index } of groups.flatMap(group =>
    group.batches.flatMap(batch => batch.clips))) {
    assert.equal(clips[index], stored)
    assert.equal(clips[index].id, stored.id)
  }
})

test('historical prompt names work without library lookup, including rename', () => {
  const groups = groupClips([
    clip('before-rename', 'ai_chat', { selection_prompt_id: 'prompt-id',
      selection_prompt_name: 'Original label' }),
    clip('after-rename', 'ai_chat', { selection_prompt_id: 'prompt-id',
      selection_prompt_name: 'Updated label' }),
  ])
  assert.deepEqual(groups.map(group => group.label), ['Original label', 'Updated label'])
  assert.deepEqual(groups.map(group => group.promptId), ['prompt-id', 'prompt-id'])
})

test('missing provenance stays unclassified and repeated imports remain separate records', () => {
  assert.deepEqual(groupClips([]), [])
  const manual = groupClips([clip('only', 'manual')])
  assert.deepEqual(manual.map(group => group.label), ['Manual'])
  const clips = [clip('import-a', 'json_import'), clip('import-b', 'json_import'),
    clip('legacy-a'), clip('legacy-b', 'ai_chat', { selection_prompt_id: 'unknown' })]
  const groups = groupClips(clips)
  assert.deepEqual(groups.map(group => group.label), ['Imported JSON', 'Legacy / Unclassified'])
  assert.deepEqual(groups[0].batches[0].clips.map(item => item.index), [0, 1])
  assert.deepEqual(groups[1].batches[0].clips.map(item => item.index), [2, 3])
})
