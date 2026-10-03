import type { ClipPreparation } from './types'

export function preparationLabel(preparation: ClipPreparation | undefined): string | null {
  switch (preparation?.status) {
    case 'waiting': return null
    case 'preparing': return 'Preparing captions…'
    case 'ready': return 'Captions ready'
    case 'failed': return 'Caption preparation failed'
    case 'stale': return 'Captions need preparation'
    case 'needs_review': return 'Caption text needs review'
    default: return null
  }
}
