import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { SermonList } from './views/SermonList'
import { SermonDetail } from './views/SermonDetail'
import { ClipsLibrary } from './views/ClipsLibrary'
import { Trim } from './views/Trim'
import { AppShell } from './components/AppShell'
import { History } from './views/History'
import { Settings } from './views/Settings'
import { Usage } from './views/Usage'
import type { Me, Sermon } from './types'
import { buildPath, parsePath, routeMatchesView } from './appRoutes'
import type { Route, View } from './appRoutes'
import { afterClipSave, clipEditorKey } from './clipNavigation'
import { shellContext, shellDestination } from './shellNavigation'
import './App.css'

type Upload = {
  id: string  // client-side; lets the banner key by uploads even if the file
              // server-side job-id isn't fetched yet.
  filename: string
  status: 'uploading' | 'success' | 'failed'
  loaded: number
  total: number
  error?: string
  xhr?: XMLHttpRequest
}

const ANON: Me = { login: null, name: null, profile_pic: null, admin: false, anonymous: true }

function App() {
  const [view, setView] = useState<View>({ name: 'list' })
  const [me, setMe] = useState<Me>(ANON)
  const [listVersion, setListVersion] = useState(0)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [clipSearch, setClipSearch] = useState('')
  // Set true while we're resolving a non-default URL into a View — we
  // need to fetch the sermon (and clip, for trim) from the API before we
  // can render. Without this the user sees a flash of the sermon list
  // before the hydrated view replaces it.
  const [hydrating, setHydrating] = useState(() => parsePath(window.location.pathname).name !== 'list')
  const [hydrateError, setHydrateError] = useState<string | null>(null)

  const refreshMe = useCallback(() => {
    api.me().then(setMe).catch(() => setMe(ANON))
  }, [])

  useEffect(() => {
    refreshMe()
  }, [refreshMe])

  // viewRef keeps a stable reference to the current view for use inside the
  // hashchange listener (which is registered once with [] deps).
  const viewRef = useRef(view)
  const trimFlushRef = useRef<(() => Promise<void>) | null>(null)
  const navigationBusyRef = useRef(false)
  const routeRequestIdRef = useRef(0)
  const registerTrimFlush = useCallback((flush: (() => Promise<void>) | null) => {
    trimFlushRef.current = flush
  }, [])
  useEffect(() => { viewRef.current = view }, [view])

  // Resolve a parsed Route → fully hydrated View by fetching the sermon and
  // (for trim) clip from the API. On miss (sermon deleted, clip index out
  // of range, network error) falls back to the closest valid view.
  const hydrateRoute = useCallback(async (route: Route): Promise<View> => {
    if (route.name === 'list')     return { name: 'list' }
    if (route.name === 'clips')    return { name: 'clips' }
    if (route.name === 'history')  return { name: 'history' }
    if (route.name === 'usage')    return { name: 'usage' }
    if (route.name === 'settings') return { name: 'settings' }

    const sermons = await api.listSermons()
    const sermon = sermons.find((s) => s.name === route.sermonName)
    if (!sermon) {
      throw new Error(`Sermon not found: ${route.sermonName}`)
    }
    if (route.name === 'detail') {
      return { name: 'detail', sermon, section: route.section }
    }
    // trim
    const clipsFile = await api.getClips(sermon.name)
    const clip = clipsFile.clips[route.clipIndex]
    if (!clip) {
      // Clip index out of range — clips.json was regenerated since the URL
      // was bookmarked. Drop to the sermon detail so the user can pick again.
      return { name: 'detail', sermon, section: 'clips' }
    }
    return { name: 'trim', sermon, clip, clipIndex: route.clipIndex,
      clipCount: clipsFile.clips.length }
  }, [])

  // Mount: read URL, hydrate. Subscribe to popstate so the browser
  // back/forward buttons actually navigate (otherwise back would change
  // the URL but leave the view in place).
  useEffect(() => {
    let cancelled = false
    const hydrateFromUrl = async () => {
      const currentRequest = ++routeRequestIdRef.current
      const route = parsePath(window.location.pathname)
      if (routeMatchesView(route, viewRef.current)) {
        setHydrating(false)
        return  // programmatic nav, already in sync
      }
      if (viewRef.current.name === 'trim') {
        const currentPath = buildPath(viewRef.current)
        try {
          if (!trimFlushRef.current) throw new Error('clip editor is still loading')
          await trimFlushRef.current()
        } catch {
          if (!cancelled && currentRequest === routeRequestIdRef.current) {
            window.history.replaceState(null, '', currentPath + window.location.search)
          }
          return
        }
        if (cancelled || currentRequest !== routeRequestIdRef.current) return
      }
      // Section-to-section Back/Forward can reuse the mounted sermon controller,
      // preserving in-progress clip forms and avoiding an unnecessary API fetch.
      if (route.name === 'detail' && viewRef.current.name === 'detail' &&
          route.sermonName === viewRef.current.sermon.name) {
        setView({ ...viewRef.current, section: route.section })
        return
      }
      setHydrating(true)
      setHydrateError(null)
      try {
        const next = await hydrateRoute(route)
        if (cancelled || currentRequest !== routeRequestIdRef.current) return
        setView(next)
        // If hydration fell back (sermon missing, clip OOR), update the
        // URL to match the actual view so refreshing again is consistent.
        const expected = buildPath(next)
        if (expected !== window.location.pathname) {
          window.history.replaceState(null, '', expected + window.location.search)
        }
      } catch (e) {
        if (cancelled || currentRequest !== routeRequestIdRef.current) return
        setHydrateError(String(e instanceof Error ? e.message : e))
        setView({ name: 'list' })
        window.history.replaceState(null, '', '/' + window.location.search)
      } finally {
        if (!cancelled && currentRequest === routeRequestIdRef.current) setHydrating(false)
      }
    }
    hydrateFromUrl()
    const onPopState = () => hydrateFromUrl()
    window.addEventListener('popstate', onPopState)
    return () => {
      cancelled = true
      window.removeEventListener('popstate', onPopState)
    }
  }, [hydrateRoute])

  // navigate(): the only way to change views. Updates state synchronously,
  // then pushes a new history entry if the target path differs from the
  // current one (so back/forward retraces the user's navigation).
  const navigate = useCallback(async (next: View): Promise<boolean> => {
    if (navigationBusyRef.current) return false
    navigationBusyRef.current = true
    const target = buildPath(next)
    try {
      const current = viewRef.current
      const proceed = () => {
        routeRequestIdRef.current += 1
        setHydrating(false)
        viewRef.current = next
        setView(next)
        if (target !== window.location.pathname) {
          window.history.pushState(null, '', target + window.location.search)
        }
      }
      if (current.name === 'trim' && buildPath(current) !== target) {
        if (!trimFlushRef.current) return false
        await afterClipSave(trimFlushRef.current, proceed)
      } else {
        proceed()
      }
      return true
    } catch {
      // Trim displays the failed write. Keep its view and URL in place.
      return false
    } finally {
      navigationBusyRef.current = false
    }
  }, [])

  const refreshSermon = async (name: string): Promise<Sermon | null> => {
    const list = await api.listSermons()
    return list.find((s) => s.name === name) ?? null
  }

  const refreshDetailSermon = useCallback(async (name: string) => {
    const list = await api.listSermons()
    const updated = list.find((s) => s.name === name)
    if (updated) setView(current => current.name === 'detail' && current.sermon.name === name
      ? { ...current, sermon: updated } : current)
  }, [])

  // Each call to startUpload creates an independent Upload entry with its own
  // XHR. Multiple uploads run in parallel — browsers cap to ~6 concurrent
  // requests per origin, so a 10-file batch self-throttles. Each entry's
  // banner persists across view navigation since this state lives in App.
  const startUpload = useCallback(async (file: File) => {
    const localId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random())
    const xhr = new XMLHttpRequest()

    setUploads((prev) => [
      ...prev,
      { id: localId, filename: file.name, status: 'uploading', loaded: 0, total: file.size, xhr },
    ])

    // Register the upload server-side so it shows in Activity as 'running'
    let serverJobId: string | null = null
    try {
      const job = await api.uploadStart(file.name)
      serverJobId = job.id
    } catch { /* tracking is non-fatal */ }

    const update = (patch: Partial<Upload>) =>
      setUploads((prev) => prev.map((u) => (u.id === localId ? { ...u, ...patch } : u)))
    const remove = () =>
      setUploads((prev) => prev.filter((u) => u.id !== localId))
    const finishServerJob = (error?: string) => {
      if (serverJobId) api.uploadFinish(serverJobId, error).catch(() => {})
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) update({ loaded: e.loaded, total: e.total })
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finishServerJob()
        update({ status: 'success', xhr: undefined })
        setListVersion((v) => v + 1)
        setTimeout(remove, 4000)  // success banner auto-dismisses
      } else {
        let detail = `${xhr.status} ${xhr.statusText}`
        try {
          const body = JSON.parse(xhr.responseText)
          if (body?.detail) detail = body.detail
        } catch { /* keep the HTTP status as the upload error */ }
        finishServerJob(detail)
        update({ status: 'failed', error: detail, xhr: undefined })
      }
    }
    xhr.onerror = () => {
      finishServerJob('Network error or upload aborted')
      update({ status: 'failed', error: 'Network error or upload aborted', xhr: undefined })
    }
    xhr.onabort = () => {
      finishServerJob('Cancelled by user')
      remove()
    }

    xhr.open('POST', '/api/sermons/upload')
    xhr.withCredentials = true
    const fd = new FormData()
    fd.append('file', file)
    xhr.send(fd)
  }, [])

  const cancelUpload = useCallback((id: string) => {
    setUploads((prev) => {
      const u = prev.find((x) => x.id === id)
      if (u?.xhr) u.xhr.abort()
      return prev
    })
  }, [])

  const dismissUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id))
  }, [])

  return (
    <AppShell
      active={shellDestination(view)}
      context={shellContext(view)}
      clipSearch={clipSearch}
      onClipSearchChange={setClipSearch}
      me={me}
      onNavigate={(destination) => navigate({ name: destination === 'sermons' ? 'list' : destination === 'activity' ? 'history' : destination })}
      onAdminChange={refreshMe}
    >
    <div className={`app${view.name === 'trim' ? ' app-wide' : ''}${view.name === 'clips' ? ' app-library' : ''}`}>

      {/* App-global upload banners — one row per active/recent upload, persists across view navigation */}
      {uploads.map((u) => (
        u.status === 'uploading' ? (
          <div key={u.id} className="upload-banner uploading">
            <div className="upload-banner-text">
              Uploading <strong>{u.filename}</strong> —{' '}
              {Math.round(u.loaded / Math.max(1, u.total) * 100)}%
              <span className="muted">
                {' '}({(u.loaded / 1024 / 1024).toFixed(1)} /{' '}
                {(u.total / 1024 / 1024).toFixed(1)} MB)
              </span>
            </div>
            <progress value={u.loaded} max={u.total} />
            <button className="secondary" onClick={() => cancelUpload(u.id)}>Cancel</button>
          </div>
        ) : u.status === 'success' ? (
          <div key={u.id} className="upload-banner success">
            ✓ Uploaded <strong>{u.filename}</strong>. Transcript processing started in the background.
          </div>
        ) : (
          <div key={u.id} className="upload-banner failed">
            Upload failed for <strong>{u.filename}</strong>: {u.error}
            <button className="secondary" onClick={() => dismissUpload(u.id)}>Dismiss</button>
          </div>
        )
      ))}

      <main>
        {hydrateError && (
          <div className="error" style={{ marginBottom: 12 }}>
            Couldn't open that link: {hydrateError}
          </div>
        )}
        {hydrating ? (
          <div className="muted" style={{ padding: 24 }}>Loading…</div>
        ) : (
          <>
            {view.name === 'list' && (
              <SermonList
                key={listVersion}
                admin={me.admin}
                onOpen={(s) => navigate({ name: 'detail', sermon: s, section: 'overview' })}
                onDeleted={() => setListVersion((v) => v + 1)}
                onUpload={startUpload}
                uploadActive={uploads.some((u) => u.status === 'uploading')}
              />
            )}
            {view.name === 'clips' && <ClipsLibrary query={clipSearch} onQueryChange={setClipSearch}
              onEdit={async (sermon, clip, clipIndex) => {
                const current = await api.getClips(sermon.name)
                const selected = current.clips[clipIndex]
                if (!selected || selected.id !== clip.id) throw new Error('Clip list changed. Refresh the library and try again.')
                const opened = await navigate({ name: 'trim', sermon, clip: selected, clipIndex,
                  clipCount: current.clips.length })
                if (!opened) throw new Error('Could not open the clip editor.')
            }} />}
            {view.name === 'detail' && (
              <SermonDetail
                key={view.sermon.name}
                sermon={view.sermon}
                section={view.section}
                admin={me.admin}
                onBack={() => navigate({ name: 'list' })}
                onSectionChange={(section) => navigate({ name: 'detail', sermon: view.sermon, section })}
                onSermonUpdated={refreshDetailSermon}
                onTrim={(clip, clipIndex) => {
                  void (async () => {
                    let current
                    try {
                      current = await api.getClips(view.sermon.name)
                    } catch {
                      await navigate({ name: 'trim', sermon: view.sermon, clip, clipIndex,
                        clipCount: Math.max(view.sermon.n_clips, clipIndex + 1) })
                      return
                    }
                    const selected = current.clips[clipIndex]
                    if (!selected) { await navigate({ name: 'detail', sermon: view.sermon, section: 'clips' }); return }
                    await navigate({ name: 'trim', sermon: view.sermon, clip: selected,
                      clipIndex, clipCount: current.clips.length })
                  })()
                }}
                onDeleted={() => {
                  setListVersion((v) => v + 1)
                  navigate({ name: 'list' })
                }}
              />
            )}
            {view.name === 'trim' && (
              <Trim
                key={clipEditorKey(view.sermon.name, view.clipIndex)}
                admin={me.admin}
                sermon={view.sermon}
                clip={view.clip}
                clipIndex={view.clipIndex}
                clipCount={view.clipCount}
                registerBeforeLeave={registerTrimFlush}
                onNavigateClip={async (index) => {
                  const clips = await api.getClips(view.sermon.name)
                  const next = clips.clips[index]
                  if (!next) throw new Error('Clip is no longer available')
                  await navigate({ name: 'trim', sermon: view.sermon,
                    clip: next, clipIndex: index, clipCount: clips.clips.length })
                }}
                onBack={async () => {
                  const updated = await refreshSermon(view.sermon.name).catch(() => null)
                  navigate({ name: 'detail', sermon: updated ?? view.sermon, section: 'clips' })
                }}
              />
            )}
            {view.name === 'history' && (
              <History onBack={() => navigate({ name: 'list' })} />
            )}
            {view.name === 'usage' && (
              <Usage onBack={() => navigate({ name: 'list' })} />
            )}
            {view.name === 'settings' && (
              <Settings onBack={() => navigate({ name: 'list' })} />
            )}
          </>
        )}
      </main>
    </div>
    </AppShell>
  )
}

export default App
