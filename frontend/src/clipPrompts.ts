import { copyEffectiveTranscript } from './transcriptExport.ts'
import type { TranscriptResponse } from './types'

export type ClipPrompt = {
  id: string
  name: string
  description: string
  selection_focus: string
  built_in: boolean
  editable: boolean
  revision: number | null
  created_at?: string
  updated_at?: string
}

export type PromptLibraryResponse = { default: string; core_rules: string;
  output_contract: string; prompts: ClipPrompt[] }
export type PromptDraft = { name: string; description: string; selection_focus: string;
  id: string | null; revision: number | null }

export function normalizePromptLibrary(value: unknown): PromptLibraryResponse {
  if (!value || typeof value !== 'object') throw new Error('Invalid prompt library response')
  const result = value as Record<string, unknown>
  if (typeof result.default !== 'string' || typeof result.core_rules !== 'string' ||
      !result.core_rules.trim() || typeof result.output_contract !== 'string' ||
      !result.output_contract.trim() || !Array.isArray(result.prompts)) {
    throw new Error('Invalid prompt library response')
  }
  const prompts = result.prompts as unknown[]
  for (const item of prompts) {
    if (!item || typeof item !== 'object') throw new Error('Invalid prompt descriptor')
    const prompt = item as Record<string, unknown>
    if (!['id', 'name', 'description', 'selection_focus'].every(key => typeof prompt[key] === 'string') ||
        typeof prompt.built_in !== 'boolean' || typeof prompt.editable !== 'boolean' ||
        !(prompt.revision === null || (typeof prompt.revision === 'number' &&
          Number.isInteger(prompt.revision) && prompt.revision > 0))) {
      throw new Error('Invalid prompt descriptor')
    }
  }
  if (!prompts.some(item => (item as ClipPrompt).id === result.default)) {
    throw new Error('Default prompt is unavailable')
  }
  return result as PromptLibraryResponse
}

export function selectedPrompt(library: PromptLibraryResponse, requested: string | null): ClipPrompt {
  return library.prompts.find(prompt => prompt.id === requested) ??
    library.prompts.find(prompt => prompt.id === library.default)!
}

export function canEditPrompt(prompt: ClipPrompt): boolean {
  return prompt.editable && !prompt.built_in
}

export function promptDraft(prompt?: ClipPrompt): PromptDraft {
  return prompt ? { id: prompt.id, revision: prompt.revision, name: prompt.name,
    description: prompt.description, selection_focus: prompt.selection_focus } :
    { id: null, revision: null, name: '', description: '', selection_focus: '' }
}

export function nextCopyName(library: PromptLibraryResponse, prompt: ClipPrompt): string {
  const base = `Copy of ${prompt.name}`.slice(0, 76).trim()
  const names = new Set(library.prompts.filter(item => !item.built_in)
    .map(item => item.name.toLocaleLowerCase()))
  if (!names.has(base.toLocaleLowerCase())) return base
  for (let number = 2; ; number += 1) {
    const suffix = ` (${number})`
    const candidate = `${base.slice(0, 80 - suffix.length).trim()}${suffix}`
    if (!names.has(candidate.toLocaleLowerCase())) return candidate
  }
}

export function confirmPromptDeletion(prompt: ClipPrompt, confirm: (message: string) => boolean): boolean {
  return canEditPrompt(prompt) && confirm(`Delete custom prompt "${prompt.name}"?`)
}

export function assemblePrompt(library: PromptLibraryResponse, selectionFocus: string): string {
  if (!selectionFocus.trim()) throw new Error('Select a prompt before copying')
  return `CLIP SELECTION RULES\n\n${library.core_rules}\n\n` +
    `SELECTION FOCUS\n\n${selectionFocus}\n\n` +
    `OUTPUT FORMAT\n\n${library.output_contract}`
}

export async function copyPromptAndTranscript(library: PromptLibraryResponse,
  selectionFocus: string, transcript: TranscriptResponse,
  writeText: (text: string) => Promise<void>): Promise<void> {
  await copyEffectiveTranscript(transcript, text =>
    writeText(`${assemblePrompt(library, selectionFocus)}\n\nTRANSCRIPT\n==========\n\n${text}`))
}
