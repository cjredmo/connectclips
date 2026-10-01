import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captionWordState, currentWordIndex } from '../src/captionReveal.ts'

test('three-word chunk reveals at each word start without changing the chunk', () => {
  const words = [{ start: 0 }, { start: 0.5 }, { start: 1 }]
  const states = (time) => words.map((_, i) => captionWordState(i, currentWordIndex(words, time)))

  assert.deepEqual(states(0), ['current', 'future', 'future'])
  assert.deepEqual(states(0.5), ['spoken', 'current', 'future'])
  assert.deepEqual(states(1), ['spoken', 'spoken', 'current'])
  assert.equal(words.length, 3)
})
