import type { View } from './appRoutes'

export type Destination = 'sermons' | 'clips' | 'activity' | 'usage' | 'settings'

export function shellDestination(view: View): Destination {
  if (view.name === 'clips') return 'clips'
  if (view.name === 'history') return 'activity'
  if (view.name === 'usage' || view.name === 'settings') return view.name
  return 'sermons'
}

export function shellContext(view: View): string {
  switch (view.name) {
    case 'clips': return 'Clips Library'
    case 'history': return 'Activity'
    case 'usage': return 'Usage'
    case 'settings': return 'Settings'
    case 'trim': return 'Clip editor'
    case 'detail': return 'Sermon workspace'
    default: return 'Sermons'
  }
}
