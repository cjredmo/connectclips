import type { Clip, Sermon } from './types'
import type { SermonSection } from './sermonWorkspace'
import { parseSermonSectionPath, sermonSectionPath } from './sermonWorkspace.ts'

export type View =
  | { name: 'list' } | { name: 'clips' }
  | { name: 'detail'; sermon: Sermon; section: SermonSection }
  | { name: 'trim'; sermon: Sermon; clip: Clip; clipIndex: number; clipCount: number }
  | { name: 'history' } | { name: 'usage' } | { name: 'settings' }

export type Route =
  | { name: 'list' } | { name: 'clips' }
  | { name: 'detail'; sermonName: string; section: SermonSection }
  | { name: 'trim'; sermonName: string; clipIndex: number }
  | { name: 'history' } | { name: 'usage' } | { name: 'settings' }

export function buildPath(view: View): string {
  switch (view.name) {
    case 'list': return '/'
    case 'clips': return '/clips'
    case 'history': return '/history'
    case 'usage': return '/usage'
    case 'settings': return '/settings'
    case 'detail': return sermonSectionPath(view.sermon.name, view.section)
    case 'trim': return `/sermons/${encodeURIComponent(view.sermon.name)}/clip/${view.clipIndex}`
  }
}

export function parsePath(pathname: string): Route {
  if (pathname === '' || pathname === '/') return { name: 'list' }
  if (pathname === '/clips' || pathname === '/clips/') return { name: 'clips' }
  if (pathname === '/history') return { name: 'history' }
  if (pathname === '/usage') return { name: 'usage' }
  if (pathname === '/settings') return { name: 'settings' }
  const trim = pathname.match(/^\/sermons\/([^/]+)\/clip\/(\d+)\/?$/)
  if (trim) return { name: 'trim', sermonName: decodeURIComponent(trim[1]), clipIndex: parseInt(trim[2], 10) }
  const detail = parseSermonSectionPath(pathname)
  if (detail) return { name: 'detail', sermonName: detail.name, section: detail.section }
  return { name: 'list' }
}

export function routeMatchesView(route: Route, view: View): boolean {
  if (route.name !== view.name) return false
  if (route.name === 'detail' && view.name === 'detail') {
    return route.sermonName === view.sermon.name && route.section === view.section
  }
  if (route.name === 'trim' && view.name === 'trim') {
    return route.sermonName === view.sermon.name && route.clipIndex === view.clipIndex
  }
  return true
}
