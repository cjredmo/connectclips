import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearPendingSelection, copyAndStartSelection, importRequest,
  loadPendingSelection, selectionForImport, submitSelectionImport } from '../src/clipSelectionSession.ts'
import { selectionLabel } from '../src/clipProvenance.ts'
import { contrastRatio, hookScoreStyle } from '../src/hookScore.ts'

function memoryStorage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) }, values }
}

const source = 'sample.mp4'
const prompt = { id: 'teaching-theology', name: 'Teaching / Theology',
  selection_focus: 'Choose clear explanations.', revision: null }
const library = { core_rules: 'Preserve meaning.', output_contract: 'Return schema_version 1 JSON.' }
const transcript = { supports_effective_transcript: true,
  segments: [{ start: 10, end: 12, text: 'Synthetic transcript words.' }] }

test('successful copy snapshots prompt, batch and sermon; reload restores metadata only', async () => {
  const storage = memoryStorage()
  const copied = []
  const pending = await copyAndStartSelection(library, prompt, transcript, source,
    async text => { copied.push(text) }, storage,
    '0b347587-2b6e-4f89-9d45-b15ead50b630', '2026-10-02T05:18:00.000Z')
  assert.equal(copied.length, 1)
  assert.match(copied[0], /Synthetic transcript words/)
  assert.equal(pending.source, source)
  assert.equal(pending.selection_prompt_id, prompt.id)
  assert.equal(pending.selection_prompt_name, prompt.name)
  assert.equal(pending.selection_prompt_revision, null)
  assert.equal(pending.selection_batch_id, '0b3475872b6e4f899d45b15ead50b630')
  assert.deepEqual(loadPendingSelection(storage, source), pending)
  assert.equal(loadPendingSelection(storage, 'other.mp4'), null)
  const stored = [...storage.values.values()][0]
  assert.ok(!stored.includes('Synthetic transcript words'))
  assert.ok(!stored.includes('Choose clear explanations'))
  assert.deepEqual(importRequest({ schema_version: 1, clips: [] }, pending),
    { payload: { schema_version: 1, clips: [] }, provenance: pending })
})

test('changing selection leaves snapshot alone; copying again creates a new session', async () => {
  const storage = memoryStorage()
  const first = await copyAndStartSelection(library, prompt, transcript, source,
    async () => {}, storage, '0b347587-2b6e-4f89-9d45-b15ead50b630',
    '2026-10-02T05:18:00.000Z')
  const selected = { ...prompt, id: 'custom:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Pastoral / Application', revision: 3 }
  assert.equal(loadPendingSelection(storage, source).selection_prompt_id, prompt.id)
  selected.name = 'Renamed later'
  assert.equal(first.selection_prompt_name, 'Teaching / Theology')
  const second = await copyAndStartSelection(library, selected, transcript, source,
    async () => {}, storage, 'affedab6-1dd1-4246-a263-d9ff3c991d4b',
    '2026-10-09T05:18:00.000Z')
  assert.equal(second.selection_prompt_name, 'Renamed later')
  selected.revision = 4
  assert.equal(second.selection_prompt_revision, 3)
  assert.notEqual(first.selection_batch_id, second.selection_batch_id)
  assert.deepEqual(loadPendingSelection(storage, source), second)
})

test('failed copy retains prior session; generic import ignores it; successful import clears it', async () => {
  const storage = memoryStorage()
  const pending = await copyAndStartSelection(library, prompt, transcript, source,
    async () => {}, storage, '0b347587-2b6e-4f89-9d45-b15ead50b630',
    '2026-10-02T05:18:00.000Z')
  await assert.rejects(() => copyAndStartSelection(library, { ...prompt, name: 'Other' },
    transcript, source, async () => { throw new Error('Clipboard denied') }, storage,
    'affedab6-1dd1-4246-a263-d9ff3c991d4b', '2026-10-09T05:18:00.000Z'))
  assert.deepEqual(loadPendingSelection(storage, source), pending)
  const document = { schema_version: 1, clips: [] }
  assert.equal(selectionForImport('generic', pending, source), null)
  assert.deepEqual(importRequest(document, selectionForImport('generic', pending, source)), document)
  assert.deepEqual(selectionForImport('ai_chat', pending, source), pending)
  assert.throws(() => selectionForImport('ai_chat', pending, 'other.mp4'), /No pending/)
  const generic = await submitSelectionImport(source, document, 'generic', pending, () => storage,
    async (_document, context) => { assert.equal(context, null); return { imported: 1 } })
  assert.deepEqual(generic.remainingPending, pending)
  await assert.rejects(() => submitSelectionImport(source, document, 'ai_chat', pending,
    () => storage, async () => { throw new Error('Import rejected') }), /Import rejected/)
  assert.deepEqual(loadPendingSelection(storage, source), pending)
  const duplicates = await submitSelectionImport(source, document, 'ai_chat', pending, () => storage,
    async (_document, context) => { assert.deepEqual(context, pending); return { imported: 0 } })
  assert.deepEqual(duplicates.remainingPending, pending)
  assert.deepEqual(loadPendingSelection(storage, source), pending)
  const success = await submitSelectionImport(source, document, 'ai_chat', pending, () => storage,
    async (_document, context) => { assert.deepEqual(context, pending); return { imported: 2 } })
  assert.equal(success.remainingPending, null)
  assert.equal(loadPendingSelection(storage, source), null)
  clearPendingSelection(storage, source)
})

test('provenance labels cover current and legacy clips', () => {
  assert.equal(selectionLabel({ selection_method: 'ai_chat', selection_prompt_name: 'Teaching / Theology' }),
    'AI Chat · Teaching / Theology')
  assert.equal(selectionLabel({ selection_method: 'claude_api', selection_prompt_name: null }), 'Claude API')
  assert.equal(selectionLabel({ selection_method: 'json_import', selection_prompt_name: null }), 'Imported JSON')
  assert.equal(selectionLabel({ selection_method: 'manual', selection_prompt_name: null }), 'Manual')
  assert.equal(selectionLabel({ selection_method: null, selection_prompt_name: null }), 'Legacy / Unclassified')
})

test('representative score badges keep at least 4.5:1 text contrast', () => {
  for (const score of [60, 75, 85, 95, 100]) {
    const { backgroundColor, color } = hookScoreStyle(score)
    assert.ok(contrastRatio(backgroundColor, color) >= 4.5, String(score))
  }
  assert.equal(hookScoreStyle(75).color, '#0e1116')
  assert.equal(hookScoreStyle(95).color, '#ffffff')
  assert.equal(hookScoreStyle(100).backgroundColor, hookScoreStyle(95).backgroundColor)
})
