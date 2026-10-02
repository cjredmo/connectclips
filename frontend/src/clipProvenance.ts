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
