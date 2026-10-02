import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assemblePrompt, canEditPrompt, confirmPromptDeletion, copyPromptAndTranscript,
  nextCopyName, normalizePromptLibrary, promptDraft, selectedPrompt } from '../src/clipPrompts.ts'
import { formatTimestampedTranscript } from '../src/transcriptExport.ts'

const balanced = { id: 'balanced', name: 'Balanced Clips', description: 'General selection.',
  selection_focus: 'Balance clear teaching and practical application.', built_in: true,
  editable: false, revision: null }
const custom = { id: 'custom:0123456789abcdef0123456789abcdef', name: 'Custom selection',
  description: 'More teaching.', selection_focus: 'Choose clear explanations.',
  built_in: false, editable: true, revision: 2 }
const library = normalizePromptLibrary({ default: 'balanced',
  core_rules: 'Preserve the speaker meaning and choose standalone clips.',
  output_contract: 'Return ONLY valid JSON with schema_version 1, no Markdown fences.',
  prompts: [balanced, custom] })

test('prompt response, default selection, and built-in/custom behavior', () => {
  assert.equal(selectedPrompt(library, null).id, 'balanced')
  assert.equal(selectedPrompt(library, 'missing').id, 'balanced')
  assert.equal(selectedPrompt(library, custom.id).id, custom.id)
  assert.equal(canEditPrompt(balanced), false)
  assert.equal(canEditPrompt(custom), true)
  assert.deepEqual(promptDraft(custom), { id: custom.id, revision: 2,
    name: custom.name, description: custom.description, selection_focus: custom.selection_focus })
  assert.equal(promptDraft().id, null)
  assert.throws(() => normalizePromptLibrary({ ...library, default: 'missing' }), /Default/)
  assert.throws(() => normalizePromptLibrary({ ...library, prompts: [{}] }), /descriptor/)
  assert.throws(() => normalizePromptLibrary({ default: 'balanced', prompts: [balanced] }), /response/)
})

test('custom duplication names and delete confirmation', () => {
  assert.equal(nextCopyName(library, balanced), 'Copy of Balanced Clips')
  const withCopy = { ...library, prompts: [...library.prompts,
    { ...custom, name: 'Copy of Balanced Clips' }] }
  assert.equal(nextCopyName(withCopy, balanced), 'Copy of Balanced Clips (2)')
  let asked = 0
  assert.equal(confirmPromptDeletion(balanced, () => { asked++; return true }), false)
  assert.equal(asked, 0)
  assert.equal(confirmPromptDeletion(custom, () => { asked++; return false }), false)
  assert.equal(confirmPromptDeletion(custom, () => { asked++; return true }), true)
  assert.equal(asked, 2)
})

test('shared rules, selected focus, contract, then exact effective transcript', async () => {
  const effective = { supports_effective_transcript: true,
    source: 'internal-source', raw_quality: { status: 'internal-quality' },
    repair: { status: 'internal-repair' }, edits: [{ corrected_text: 'internal-edit' }],
    segments: [{ id: 99, start: 558.24, end: 562.61,
      text: 'Corrected sample sentence.', raw_words: [{ word: 'Raw wording' }] }] }
  const writes = []
  await copyPromptAndTranscript(library, balanced.selection_focus, effective,
    async text => { writes.push(text) })
  assert.equal(writes.length, 1)
  assert.equal(writes[0], `${assemblePrompt(library, balanced.selection_focus)}\n\nTRANSCRIPT\n==========\n\n` +
    formatTimestampedTranscript(effective.segments))
  const expectedOrder = ['CLIP SELECTION RULES', library.core_rules, 'SELECTION FOCUS',
    balanced.selection_focus, 'OUTPUT FORMAT', library.output_contract, 'TRANSCRIPT',
    '[00:09:18.240 - 00:09:22.610] Corrected sample sentence.']
  for (let index = 1; index < expectedOrder.length; index++) {
    assert.ok(writes[0].indexOf(expectedOrder[index]) > writes[0].indexOf(expectedOrder[index - 1]))
  }
  assert.ok(writes[0].includes('schema_version 1'))
  for (const internal of ['internal-source', 'internal-quality', 'internal-repair',
    'internal-edit', 'Raw wording', '99']) assert.equal(writes[0].includes(internal), false)
  await assert.rejects(() => copyPromptAndTranscript(library, balanced.selection_focus, effective,
    async () => { throw new Error('Clipboard denied') }), /Clipboard denied/)
  await assert.rejects(() => copyPromptAndTranscript(library, balanced.selection_focus,
    { ...effective, supports_effective_transcript: false }, async () => {}), /Effective transcript unavailable/)
})
