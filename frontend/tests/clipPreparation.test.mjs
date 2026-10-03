import assert from 'node:assert/strict'
import { test } from 'node:test'
import { preparationLabel } from '../src/clipPreparation.ts'

test('clip preparation state remains understandable without changing clip cards', () => {
  assert.equal(preparationLabel(undefined), null)
  assert.equal(preparationLabel({ status: 'waiting' }), null)
  assert.equal(preparationLabel({ status: 'preparing' }), 'Preparing captions…')
  assert.equal(preparationLabel({ status: 'ready' }), 'Captions ready')
  assert.equal(preparationLabel({ status: 'failed' }), 'Caption preparation failed')
  assert.equal(preparationLabel({ status: 'stale' }), 'Captions need preparation')
  assert.equal(preparationLabel({ status: 'needs_review' }), 'Caption text needs review')
})
