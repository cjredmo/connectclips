import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClipOverrideAutosave } from '../src/clipOverrideAutosave.ts'
import { adjacentClip, afterClipSave, clipEditorKey } from '../src/clipNavigation.ts'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('mount is clean and navigation flushes the latest debounced edit', async () => {
  const pending = deferred()
  const writes = []
  const statuses = []
  const save = new ClipOverrideAutosave({ start: 1, end: 2 }, async edits => {
    writes.push(edits)
    await pending.promise
  }, status => statuses.push(status), 10000)
  await save.flush()
  assert.deepEqual(writes, [])
  save.schedule({ start: 1.5, end: 2 })
  let navigated = false
  const leaving = afterClipSave(() => save.flush(), () => { navigated = true })
  assert.equal(navigated, false)
  assert.deepEqual(writes, [{ start: 1.5, end: 2 }])
  assert.deepEqual(statuses, ['saving'])
  pending.resolve()
  await leaving
  assert.equal(navigated, true)
  assert.deepEqual(statuses, ['saving', 'saved'])
  save.dispose()
})

test('in-flight writes stay ordered and the final edit is neither lost nor duplicated', async () => {
  const first = deferred()
  const writes = []
  const save = new ClipOverrideAutosave({ start: 1 }, async edits => {
    writes.push(edits)
    if (writes.length === 1) await first.promise
  }, () => {}, 10000)
  save.schedule({ start: 2 })
  const flushing = save.flush()
  save.schedule({ start: 3, caption_style: 'block', caption_margin_v: 440,
    include_hook_title: false, identity_id: 2, zoom_level: 'wide', lock_camera: true })
  const leaving = save.flush()
  assert.deepEqual(writes, [{ start: 2 }])
  first.resolve()
  await Promise.all([flushing, leaving])
  assert.deepEqual(writes.map(edit => edit.start), [2, 3])
  assert.equal(writes[1].lock_camera, true)
  await save.flush()
  assert.equal(writes.length, 2)
  save.dispose()
})

test('failed saves block navigation and a later retry reports Saved only after success', async () => {
  const statuses = []
  let fail = true
  let calls = 0
  const save = new ClipOverrideAutosave({ start: 1 }, async () => {
    calls += 1
    if (fail) throw new Error('offline')
  }, status => statuses.push(status), 10000)
  save.schedule({ start: 2 })
  let navigated = false
  await assert.rejects(afterClipSave(() => save.flush(), () => { navigated = true }), /offline/)
  assert.equal(navigated, false)
  assert.deepEqual(statuses, ['saving', 'failed'])
  fail = false
  await save.flush()
  assert.equal(calls, 2)
  assert.deepEqual(statuses, ['saving', 'failed', 'saving', 'saved'])
  save.dispose()
})

test('clean reset and a new clip do not inherit the previous clip draft', async () => {
  const writes = []
  const first = new ClipOverrideAutosave({ start: 1 }, async edits => { writes.push(['first', edits]) },
    () => {}, 10000)
  first.schedule({ start: 2 })
  await first.flush()
  first.markClean({ start: 1 })
  first.dispose()
  const second = new ClipOverrideAutosave({ start: 10 }, async edits => { writes.push(['second', edits]) },
    () => {}, 10000)
  await second.flush()
  assert.deepEqual(writes, [['first', { start: 2 }]])
  second.schedule({ start: 11 })
  await second.flush()
  assert.deepEqual(writes.at(-1), ['second', { start: 11 }])
  assert.notEqual(clipEditorKey('sample.mp4', 0), clipEditorKey('sample.mp4', 1))
  second.dispose()
})

test('previous and next clip boundaries use the current list length', () => {
  assert.equal(adjacentClip(0, 3, -1), null)
  assert.equal(adjacentClip(0, 3, 1), 1)
  assert.equal(adjacentClip(1, 3, -1), 0)
  assert.equal(adjacentClip(2, 3, 1), null)
  assert.equal(adjacentClip(0, 1, 1), null)
})
