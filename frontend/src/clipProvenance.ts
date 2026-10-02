import type { Clip } from './types'

export function selectionLabel(clip: Pick<Clip, 'selection_method' | 'selection_prompt_name'>): string {
  switch (clip.selection_method) {
    case 'ai_chat': return clip.selection_prompt_name
      ? `AI Chat · ${clip.selection_prompt_name}` : 'AI Chat'
    case 'claude_api': return 'Claude API'
    case 'json_import': return 'Imported JSON'
    case 'manual': return 'Manual'
    default: return 'Legacy / Unclassified'
  }
}

type ProvenanceClip = Pick<Clip, 'selection_method' | 'selection_prompt_id' |
  'selection_prompt_name' | 'selection_batch_id' | 'selection_created_at'>

export type IndexedClip<T> = { clip: T; index: number }
export type ClipBatch<T> = {
  key: string
  batchId: string | null
  selectedAt: string | null
  clips: IndexedClip<T>[]
}
export type ClipGroup<T> = {
  key: string
  label: string
  promptId: string | null
  count: number
  batches: ClipBatch<T>[]
}

const sourceOrder = ['claude_api', 'json_import', 'manual', 'legacy'] as const
const sourceLabels = {
  claude_api: 'Claude API', json_import: 'Imported JSON',
  manual: 'Manual', legacy: 'Legacy / Unclassified',
}

// Keep the original clips.json index for every action. Provenance only changes presentation.
export function groupClips<T extends ProvenanceClip>(clips: readonly T[]): ClipGroup<T>[] {
  const promptGroups = new Map<string, ClipGroup<T>>()
  const sourceGroups = new Map<string, ClipGroup<T>>()
  clips.forEach((clip, index) => {
    const promptName = clip.selection_prompt_name?.trim()
    const isKnownPrompt = clip.selection_method === 'ai_chat' && !!promptName
    // A renamed prompt has a new historical label; keep its old snapshot separate.
    const key = isKnownPrompt
      ? JSON.stringify(['prompt', clip.selection_prompt_id, promptName])
      : clip.selection_method === 'claude_api' || clip.selection_method === 'json_import' ||
          clip.selection_method === 'manual' ? clip.selection_method : 'legacy'
    const groups = isKnownPrompt ? promptGroups : sourceGroups
    let group = groups.get(key)
    if (!group) {
      group = { key, label: isKnownPrompt && promptName ? promptName : sourceLabels[key as keyof typeof sourceLabels],
        promptId: isKnownPrompt ? clip.selection_prompt_id : null, count: 0, batches: [] }
      groups.set(key, group)
    }
    const batchKey = clip.selection_batch_id ?? 'unrecorded'
    let batch = group.batches.find(item => item.key === batchKey)
    if (!batch) {
      batch = { key: batchKey, batchId: clip.selection_batch_id,
        selectedAt: clip.selection_created_at, clips: [] }
      group.batches.push(batch)
    }
    if (!batch.selectedAt && clip.selection_created_at) batch.selectedAt = clip.selection_created_at
    batch.clips.push({ clip, index })
    group.count += 1
  })
  return [...promptGroups.values(), ...sourceOrder.flatMap(key => {
    const group = sourceGroups.get(key)
    return group ? [group] : []
  })]
}
