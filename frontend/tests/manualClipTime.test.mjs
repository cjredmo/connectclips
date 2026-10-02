import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildManualClipPayload, manualClipDuration, parseManualClipTime, submitManualClipInputs,
} from '../src/manualClipTime.ts'

test('friendly timestamps normalize to seconds', () => {
  for (const [value, expected] of [
    ['9:18', 558], ['9:18.2', 558.2], ['09:18.240', 558.24],
    ['45:35.760', 2735.76], ['1:09:18', 4158], ['1:09:18.250', 4158.25],
    ['00:45:35.760', 2735.76], [' 9:18 ', 558], ['34.2', 34.2],
  ]) assert.equal(parseManualClipTime(value), expected, value)
})

test('malformed times and invalid ranges are rejected', () => {
  for (const value of ['', '9:60', '1:60:00', '1:02:60', '1:2:03',
    '9:18.1234', '9:18 extra', '-1', 'NaN', 'Infinity']) {
    assert.equal(parseManualClipTime(value), null, value)
  }
  assert.throws(() => buildManualClipPayload('Sample', '9:18', '9:18'), /after start/)
  assert.throws(() => buildManualClipPayload('Sample', '9:18', '9:17'), /after start/)
  assert.throws(() => buildManualClipPayload(' ', '0', '2'), /title/)
  assert.throws(() => buildManualClipPayload('Sample', 'bad', '2'), /Enter time/)
  assert.equal(manualClipDuration(558.2, 592.4), 34.2)
})

test('form payload sends only the normalized title and boundaries', async () => {
  const payload = buildManualClipPayload('  Sample clip title  ', '45:35.760', '46:09.600')
  assert.deepEqual(payload, { title: 'Sample clip title', start: 2735.76, end: 2769.6 })
  const sent = []
  const response = await submitManualClipInputs('  Sample clip title  ',
    '45:35.760', '46:09.600', async clip => { sent.push(clip); return { clip_index: 0 } })
  assert.equal(response.clip_index, 0)
  assert.deepEqual(sent, [payload])
})
