import type { ReactNode } from 'react'
import { AdminControls } from '../views/AdminControls'
import type { Me } from '../types'
import type { Destination } from '../shellNavigation'
import playLogo from '../assets/connectclips-play-logo.svg'

type Props = {
  active: Destination
  me: Me
  onNavigate: (destination: Destination) => void
  onAdminChange: () => void
  context: string
  clipSearch: string
  onClipSearchChange: (query: string) => void
  children: ReactNode
}

export function AppShell({ active, me, onNavigate, onAdminChange, context,
  clipSearch, onClipSearchChange, children }: Props) {
  const navButton = (destination: Destination, label: string, icon: string, mobileLabel = label) => (
    <button
      type="button"
      className={`app-nav-link${active === destination ? ' is-active' : ''}`}
      aria-current={active === destination ? 'page' : undefined}
      onClick={() => onNavigate(destination)}
      title={label}
    >
      <span className="app-nav-icon" aria-hidden="true">{icon}</span>
      <span className="app-nav-label">{label}</span>
      <span className="app-nav-mobile-label">{mobileLabel}</span>
    </button>
  )

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Application navigation">
        <button type="button" className="app-brand" onClick={() => onNavigate('sermons')} title="ConnectClips — Sermons">
          <img className="app-brand-logo" src={playLogo} alt="" />
          <span className="app-brand-name">ConnectClips</span>
        </button>
        <nav className="app-primary-nav" aria-label="Primary navigation">
          {navButton('sermons', 'Sermons', '▤')}
          {navButton('clips', 'Clips Library', '▦', 'Clips')}
          {me.admin && navButton('activity', 'Activity', '◷')}
        </nav>
        <div className="app-sidebar-bottom">
          <nav className="app-utility-nav" aria-label="Admin navigation">
            {me.admin && navButton('usage', 'Usage', '◫')}
            {me.admin && navButton('settings', 'Settings', '⚙')}
          </nav>
          <div className="app-sidebar-admin">
            {!me.anonymous && <span className="identity-badge" title={me.login ?? ''}>
              Hi, <strong>{me.name || me.login}</strong>
            </span>}
            <AdminControls
              admin={me.admin}
              identityAdmin={!me.anonymous && me.admin}
              onChange={onAdminChange}
            />
          </div>
        </div>
      </aside>
      <div className="app-shell-main">
        <header className={`app-topbar${active === 'clips' ? ' has-search' : ''}`}>
          <div className="app-topbar-crumb">ConnectClips <span aria-hidden="true">/</span> <strong>{context}</strong></div>
          {active === 'clips' && <div className="app-topbar-search">
            <label htmlFor="clip-library-search" className="visually-hidden">Search clips, sermons, or scripture</label>
            <span aria-hidden="true">⌕</span>
            <input id="clip-library-search" type="search" value={clipSearch}
              onChange={event => onClipSearchChange(event.target.value)}
              placeholder="Search clips, sermons, or scripture…" />
          </div>}
        </header>
        {children}
      </div>
    </div>
  )
}
