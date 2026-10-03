import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { buildLibrary, dateLabel } from '../clipLibrary'
import type { SermonClips } from '../clipLibrary'
import type { Clip, Sermon } from '../types'
import { ClipGroupGrid } from '../components/ClipGroupGrid'
import { ClipPreviewModal } from '../components/ClipPreviewModal'
import { StatePanel } from '../components/StatePanel'

async function loadLibrary(): Promise<{ collections: SermonClips[]; failures: number }> {
  const sermons = await api.listSermons()
  const withClips = sermons.filter(sermon => sermon.clips_selected)
  const results = await Promise.allSettled(withClips.map(sermon => api.getClips(sermon.name)))
  return { failures: results.filter(result => result.status === 'rejected').length,
    collections: results.flatMap((result, index) => result.status === 'fulfilled'
      ? [{ sermon: withClips[index], clips: result.value.clips }] : []) }
}

export function ClipsLibrary({ query, onQueryChange, onEdit }: {
  query: string; onQueryChange: (query: string) => void
  onEdit: (sermon: Sermon, clip: Clip, index: number) => Promise<void>
}) {
  const [collections, setCollections] = useState<SermonClips[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [partialFailures, setPartialFailures] = useState(0)
  const [preview, setPreview] = useState<{ sermon: Sermon; clip: Clip; index: number } | null>(null)
  const library = useMemo(() => buildLibrary(collections ?? [], query), [collections, query])
  const visibleCount = library.reduce((total, item) => total + item.count, 0)

  const refresh = () => loadLibrary().then(result => {
    setPartialFailures(result.failures)
    setCollections(result.collections)
    setError(null)
  }).catch(e => setError(String(e instanceof Error ? e.message : e)))
  const editClip = (sermon: Sermon, clip: Clip, index: number) => {
    void onEdit(sermon, clip, index).catch(e => {
      setPreview(null)
      setError(String(e instanceof Error ? e.message : e))
    })
  }

  useEffect(() => {
    let cancelled = false
    loadLibrary().then(result => {
      if (cancelled) return
      setPartialFailures(result.failures)
      setCollections(result.collections)
    }).catch(e => { if (!cancelled) setError(String(e instanceof Error ? e.message : e)) })
    return () => { cancelled = true }
  }, [])

  return <div className="clips-library">
    <div className="media-library-hero">
      <div>
        <p className="media-library-eyebrow">Clips Library</p>
        <h1>Browse every clip</h1>
        <p className="media-library-sub">Organized first by sermon and date, then by the prompt or source that selected the clip.</p>
      </div>
      <button type="button" className="media-library-refresh" onClick={() => void refresh()}>Refresh library</button>
    </div>
    <div className="media-library-toolbar" aria-live="polite">
      <span className="media-filter-pill">{query ? `${visibleCount} matching ${visibleCount === 1 ? 'clip' : 'clips'}`
        : collections ? `${visibleCount} ${visibleCount === 1 ? 'clip' : 'clips'}` : 'All clips'}</span>
      {query && <button type="button" className="media-filter-reset" onClick={() => onQueryChange('')}>Clear search</button>}
    </div>
    {error && <StatePanel kind="error" title="Clips could not be loaded" detail={error}
      action={<button type="button" className="secondary" onClick={() => void refresh()}>Try again</button>}>
      Check the connection and try again.
    </StatePanel>}
    {partialFailures > 0 && <p role="status" className="error-inline">{partialFailures} sermon clip list{partialFailures === 1 ? '' : 's'} could not be loaded.</p>}
    {!collections && !error && <StatePanel kind="loading" title="Loading clips">Getting saved clip suggestions.</StatePanel>}
    {collections && library.length === 0 && <StatePanel kind="empty"
      title={query ? 'No matching clips' : 'No clips yet'}>
      {query ? 'No clips match your search.' : partialFailures
        ? 'No clips could be displayed. Refresh to try the unavailable sermon lists again.'
        : 'No clips yet. Create clips from a sermon workspace.'}
    </StatePanel>}
    {library.map(({ sermon, groups, count }) => <section className="media-sermon-group" key={sermon.name}>
      <div className="media-sermon-heading"><div><h2>{sermon.name}</h2><p className="muted">{dateLabel(sermon)}</p></div>
        <span className="muted small">{count} {count === 1 ? 'clip' : 'clips'}</span></div>
      {groups.map(group => <ClipGroupGrid key={group.key} sermon={sermon} group={group}
        onPreview={(clip, index) => setPreview({ sermon, clip, index })}
        onEdit={(clip, index) => editClip(sermon, clip, index)} />)}
    </section>)}
    {preview && <ClipPreviewModal sermon={preview.sermon} clip={preview.clip}
      onClose={() => setPreview(null)} onEdit={() => editClip(preview.sermon, preview.clip, preview.index)} />}
  </div>
}
