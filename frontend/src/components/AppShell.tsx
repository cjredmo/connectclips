import type { ReactNode } from 'react'
import { AdminControls } from '../views/AdminControls'
import type { Me } from '../types'

type Destination = 'sermons' | 'activity' | 'usage' | 'settings'

type Props = {
  active: Destination
  me: Me
  onNavigate: (destination: Destination) => void
  onAdminChange: () => void
  children: ReactNode
}

export function AppShell({ active, me, onNavigate, onAdminChange, children }: Props) {
  const navButton = (destination: Destination, label: string) => (
    <button
      type="button"
      className={`app-nav-link${active === destination ? ' is-active' : ''}`}
      aria-current={active === destination ? 'page' : undefined}
      onClick={() => onNavigate(destination)}
    >
      {label}
    </button>
  )

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <button type="button" className="app-brand" onClick={() => onNavigate('sermons')}>
            ConnectClips
          </button>
          <nav className="app-primary-nav" aria-label="Primary navigation">
            {navButton('sermons', 'Sermons')}
            {me.admin && navButton('activity', 'Activity')}
          </nav>
          <div className="app-utilities">
            <nav className="app-utility-nav" aria-label="Admin navigation">
              {me.admin && navButton('usage', 'Usage')}
              {me.admin && navButton('settings', 'Settings')}
            </nav>
            {!me.anonymous && (
              <span className="identity-badge" title={me.login ?? ''}>
                Hi, <strong>{me.name || me.login}</strong>
              </span>
            )}
            <AdminControls
              admin={me.admin}
              identityAdmin={!me.anonymous && me.admin}
              onChange={onAdminChange}
            />
          </div>
        </div>
      </header>
      {children}
    </>
  )
}
