import { copyPromptAndTranscript } from './clipPrompts.ts'
import type { ClipPrompt, PromptLibraryResponse } from './clipPrompts.ts'
import type { TranscriptResponse } from './types'

export type PendingAiSelection = {
  source: string
  selection_method: 'ai_chat'
  selection_batch_id: string
  selection_prompt_id: string
  selection_prompt_name: string
  selection_prompt_revision: number | null
  selection_created_at: string
}

type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const keyFor = (source: string) => `connectclips.pendingAiSelection.v1:${encodeURIComponent(source)}`
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function newPendingSelection(source: string, prompt: ClipPrompt,
  uuid: string, timestamp: string): PendingAiSelection {
  if (!source || !UUID_V4.test(uuid)) throw new Error('A valid selection session ID is required')
  return { source, selection_method: 'ai_chat', selection_batch_id: uuid.replaceAll('-', ''),
    selection_prompt_id: prompt.id, selection_prompt_name: prompt.name,
    selection_prompt_revision: prompt.revision, selection_created_at: timestamp }
}

export function loadPendingSelection(storage: SessionStorage, source: string): PendingAiSelection | null {
  try {
    const raw = storage.getItem(keyFor(source))
    if (!raw) return null
    const value = JSON.parse(raw) as PendingAiSelection
    if (value.source !== source || value.selection_method !== 'ai_chat' ||
        !/^[0-9a-f]{32}$/.test(value.selection_batch_id) ||
        typeof value.selection_prompt_id !== 'string' ||
        typeof value.selection_prompt_name !== 'string' ||
        !value.selection_prompt_name.trim() ||
        !(value.selection_prompt_revision === null ||
          (Number.isInteger(value.selection_prompt_revision) && value.selection_prompt_revision > 0)) ||
        typeof value.selection_created_at !== 'string' ||
        !Number.isFinite(Date.parse(value.selection_created_at))) return null
    return value
  } catch { return null }
}

export function clearPendingSelection(storage: SessionStorage, source: string): void {
  storage.removeItem(keyFor(source))
}

export async function copyAndStartSelection(library: PromptLibraryResponse, prompt: ClipPrompt,
  transcript: TranscriptResponse, source: string, writeText: (text: string) => Promise<void>,
  storage: SessionStorage, uuid: string, timestamp: string): Promise<PendingAiSelection> {
  const pending = newPendingSelection(source, prompt, uuid, timestamp)
  await copyPromptAndTranscript(library, prompt.selection_focus, transcript, writeText)
  storage.setItem(keyFor(source), JSON.stringify(pending))
  return pending
}

export function importRequest(document: unknown, pending: PendingAiSelection | null): unknown {
  return pending ? { payload: document, provenance: pending } : document
}

export function selectionForImport(mode: 'generic' | 'ai_chat',
  pending: PendingAiSelection | null, source: string): PendingAiSelection | null {
  if (mode === 'generic') return null
  if (!pending || pending.source !== source) throw new Error('No pending AI Chat selection for this sermon')
  return pending
}

export async function submitSelectionImport<T extends { imported: number }>(
  source: string, document: unknown, mode: 'generic' | 'ai_chat',
  pending: PendingAiSelection | null, storage: () => SessionStorage,
  post: (document: unknown, session: PendingAiSelection | null) => Promise<T>,
): Promise<{ result: T; session: PendingAiSelection | null;
  remainingPending: PendingAiSelection | null; clearError: boolean }> {
  const session = selectionForImport(mode, pending, source)
  const result = await post(document, session)
  let clearError = false
  if (session && result.imported > 0) {
    try { clearPendingSelection(storage(), source) }
    catch { clearError = true }
  }
  return { result, session, remainingPending: session && result.imported > 0 ? null : pending,
    clearError }
}
