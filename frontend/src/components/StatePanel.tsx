import type { ReactNode } from 'react'

export function StatePanel({ kind, title, children, detail, action }: {
  kind: 'loading' | 'empty' | 'error'
  title: string
  children?: ReactNode
  detail?: string | null
  action?: ReactNode
}) {
  return <div className={`state-panel state-panel-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
    <h3>{title}</h3>
    {children && <p>{children}</p>}
    {action && <div className="state-panel-action">{action}</div>}
    {detail && <details><summary>Technical details</summary><pre>{detail}</pre></details>}
  </div>
}
