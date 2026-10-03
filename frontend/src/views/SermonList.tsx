import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { Sermon } from '../types'
import { AddSermon } from './AddSermon'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import { StatePanel } from '../components/StatePanel'

type Props = {
  admin: boolean
  onOpen: (sermon: Sermon) => void
  onDeleted: () => void
  onUpload: (file: File) => void
  uploadActive: boolean
}

type SortKey = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc'

const SORT_STORAGE_KEY = 'connectclips.sermonSort'
const DEFAULT_SORT: SortKey = 'date-desc'

function isSortKey(v: string | null): v is SortKey {
  return v === 'date-desc' || v === 'date-asc' || v === 'name-asc' || v === 'name-desc'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function sortSermons(items: Sermon[], key: SortKey): Sermon[] {
  const sorted = [...items]
  switch (key) {
    case 'date-desc':
      sorted.sort((a, b) => b.modified_at.localeCompare(a.modified_at))
      break
    case 'date-asc':
      sorted.sort((a, b) => a.modified_at.localeCompare(b.modified_at))
      break
    case 'name-asc':
      sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      break
    case 'name-desc':
      sorted.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' }))
      break
  }
  return sorted
}

export function SermonList({ admin, onOpen, onDeleted, onUpload, uploadActive }: Props) {
  const [sermons, setSermons] = useState<Sermon[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(SORT_STORAGE_KEY) : null
    return isSortKey(stored) ? stored : DEFAULT_SORT
  })

  const onSortChange = (v: SortKey) => {
    setSortKey(v)
    try { window.localStorage.setItem(SORT_STORAGE_KEY, v) } catch { /* ignore */ }
  }

  const sortedSermons = useMemo(
    () => (sermons ? sortSermons(sermons, sortKey) : null),
    [sermons, sortKey],
  )

  const refresh = useCallback(() => {
    api.listSermons().then(data => { setSermons(data); setError(null) }).catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const onDelete = async (name: string) => {
    if (!window.confirm(`Delete "${name}"?\n\nThis removes the source file, transcript, clips.json, and every exported MP4.`)) return
    setDeleting(name)
    setError(null)
    try {
      await api.deleteSermon(name)
      refresh()
      onDeleted()
    } catch (err) {
      setError(String(err))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="sermon-list">
      <PageHeader title="Sermons" description="Manage source recordings and their clips." />

      <AddSermon onAdded={refresh} onUpload={onUpload} uploadActive={uploadActive} />

      {error && <StatePanel kind="error" title="Sermons could not be refreshed" detail={error}
        action={<button type="button" className="secondary" onClick={refresh}>Try again</button>}>
        Check the connection and try again.
      </StatePanel>}
      {!sermons && !error && <StatePanel kind="loading" title="Loading sermons">Getting source recordings.</StatePanel>}
      {sermons && sermons.length === 0 && (
        <StatePanel kind="empty" title="No sermons yet">Add a source recording above to get started.</StatePanel>
      )}
      {sortedSermons && sortedSermons.length > 0 && (
        <>
          <div className="sermon-sort">
            <label htmlFor="sermon-sort-select">Sort</label>
            <select
              id="sermon-sort-select"
              value={sortKey}
              onChange={(e) => onSortChange(e.target.value as SortKey)}
            >
              <option value="date-desc">Date — newest first</option>
              <option value="date-asc">Date — oldest first</option>
              <option value="name-asc">Name — A to Z</option>
              <option value="name-desc">Name — Z to A</option>
            </select>
          </div>
          <ul>
            {sortedSermons.map((s) => (
            <li key={s.name} className="sermon-row">
              <button type="button" className="sermon-row-open" onClick={() => onOpen(s)}>
                <span className="name">{s.name}</span>
                <span className="meta">
                  {formatSize(s.size_bytes)} · {new Date(s.modified_at).toLocaleString()}
                </span>
                <span className="badges">
                  <StatusBadge tone={s.transcribed ? 'success' : 'neutral'}>
                    {s.transcribed ? '✓ transcribed' : 'not transcribed'}
                  </StatusBadge>
                  <StatusBadge tone={s.clips_selected ? 'success' : 'neutral'}>
                    {s.clips_selected ? `✓ ${s.n_clips} clips` : 'no clips yet'}
                  </StatusBadge>
                </span>
              </button>
              {admin && (
                <div className="row-actions">
                  <button
                    className="danger"
                    onClick={() => onDelete(s.name)}
                    disabled={deleting === s.name}
                  >
                    {deleting === s.name ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              )}
            </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
