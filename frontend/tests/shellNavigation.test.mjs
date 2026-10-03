import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shellContext, shellDestination } from '../src/shellNavigation.ts'

const sermon = { name: 'sample.mp4' }

test('sidebar selection follows the real route and preserves sermon editor context', () => {
  const cases = [
    [{ name: 'list' }, 'sermons', 'Sermons'],
    [{ name: 'clips' }, 'clips', 'Clips Library'],
    [{ name: 'history' }, 'activity', 'Activity'],
    [{ name: 'usage' }, 'usage', 'Usage'],
    [{ name: 'settings' }, 'settings', 'Settings'],
    [{ name: 'detail', sermon, section: 'clips' }, 'sermons', 'Sermon workspace'],
    [{ name: 'trim', sermon, clipIndex: 2 }, 'sermons', 'Clip editor'],
  ]
  for (const [view, selected, context] of cases) {
    assert.equal(shellDestination(view), selected)
    assert.equal(shellContext(view), context)
  }
})
