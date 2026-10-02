import type { ReactNode } from 'react'

type Tone = 'success' | 'processing' | 'warning' | 'failed' | 'neutral'

type Props = {
  tone: Tone
  children: ReactNode
}

export function StatusBadge({ tone, children }: Props) {
  return <span className={`status-badge status-badge-${tone}`}>{children}</span>
}
