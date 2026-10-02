import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deleteClipCaptionStyle } from '../src/captionStyleDeletion.ts'

test('unused style deletes and disappears from the refreshed list', async () => {
  const styles = new Set(['custom:sample', 'custom:other'])
  const order = []
  await deleteClipCaptionStyle('custom:sample', 'classic', 'classic', {
    flushCurrentClip: async () => { order.push('flush') },
    persistCurrentClip: async key => { order.push(`save:${key}`) },
    references: async () => ({ current_clip: false, other_clips: 0 }),
    selectDefault: () => { order.push('select') },
    remove: async () => { order.push('delete'); styles.delete('custom:sample') },
    refresh: async () => { order.push('refresh') },
  })
  assert.deepEqual(order, ['flush', 'delete', 'refresh'])
  assert.deepEqual([...styles], ['custom:other'])
})

test('current clip switches to default and its save finishes before delete', async () => {
  const order = []
  let replacementStarted
  let finishReplacement
  const started = new Promise(resolve => { replacementStarted = resolve })
  const replacement = new Promise(resolve => { finishReplacement = resolve })
  const deletion = deleteClipCaptionStyle('custom:sample', 'custom:sample', 'classic', {
    flushCurrentClip: async () => { order.push('flush') },
    persistCurrentClip: async key => {
      order.push(`save:${key}`)
      if (key === 'classic') { replacementStarted(); await replacement }
    },
    references: async () => ({ current_clip: true, other_clips: 0 }),
    selectDefault: () => { order.push('select') },
    remove: async () => { order.push('delete') },
    refresh: async () => { order.push('refresh') },
  })
  await started
  assert.deepEqual(order, ['flush', 'save:classic'])
  finishReplacement()
  await deletion
  assert.deepEqual(order, ['flush', 'save:classic', 'select', 'delete', 'refresh'])
})

test('other clip references block delete with actionable text', async () => {
  const order = []
  await assert.rejects(deleteClipCaptionStyle('custom:sample', 'custom:sample', 'classic', {
    flushCurrentClip: async () => { order.push('flush') },
    persistCurrentClip: async key => { order.push(`save:${key}`) },
    references: async () => ({ current_clip: true, other_clips: 3 }),
    selectDefault: () => { order.push('select') },
    remove: async () => { order.push('delete') },
    refresh: async () => { order.push('refresh') },
  }), /still used by 3 other clips.*Change those clips/)
  assert.deepEqual(order, ['flush'])
})

test('backend deletion errors reach the caller and do not imply success', async () => {
  const order = []
  await assert.rejects(deleteClipCaptionStyle('custom:sample', 'classic', 'classic', {
    flushCurrentClip: async () => {},
    persistCurrentClip: async () => {},
    references: async () => ({ current_clip: false, other_clips: 0 }),
    selectDefault: () => { order.push('select') },
    remove: async () => { throw new Error('caption style is still selected by 1 clip') },
    refresh: async () => { order.push('refresh') },
  }), /still selected by 1 clip/)
  assert.deepEqual(order, [])
})

test('a late delete conflict leaves the current clip on its saved default', async () => {
  const order = []
  await assert.rejects(deleteClipCaptionStyle('custom:sample', 'custom:sample', 'classic', {
    flushCurrentClip: async () => { order.push('flush') },
    persistCurrentClip: async key => { order.push(`save:${key}`) },
    references: async () => ({ current_clip: true, other_clips: 0 }),
    selectDefault: () => { order.push('select') },
    remove: async () => { throw new Error('caption style is still selected by 1 clip') },
    refresh: async () => { order.push('refresh') },
  }), /still selected by 1 clip/)
  assert.deepEqual(order, ['flush', 'save:classic', 'select'])
})
