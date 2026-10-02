import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, fileUrl } from '../api'
import type { CaptionStyle, Clip, ClipUserEdits, Identity, Job, Sermon, ZoomLevel } from '../types'
import { Publish } from './Publish'
import { CaptionStylePicker } from './CaptionStylePicker'
import { CaptionStyleEditor } from './CaptionStyleEditor'
import { canDeleteStyle, canEditStyle, editableStyleDraft } from '../captionStyles'
import { deleteClipCaptionStyle } from '../captionStyleDeletion'
import { LivePreview } from './LivePreview'
import { TranscriptEditor } from './TranscriptEditor'
import { hookScoreStyle } from '../hookScore'
import { ClipOverrideAutosave, type OverrideSaveStatus } from '../clipOverrideAutosave'
import { adjacentClip } from '../clipNavigation'

type Props = {
  sermon: Sermon
  clip: Clip
  clipIndex: number
  clipCount: number
  onBack: () => void
  onNavigateClip: (index: number) => Promise<void>
  registerBeforeLeave: (flush: (() => Promise<void>) | null) => void
  admin: boolean
}

const NUDGE_STEP = 0.1 // seconds

// Time formatting / parsing for the trim inputs. Seconds-with-decimals
// (235.03) is unambiguous internally but reads as a frame index to a
// volunteer scrubbing through a sermon. M:SS.cc is the format every
// timeline-savvy reader recognizes.
function formatTime(seconds: number): string {
  const total = Math.max(0, seconds)
  const m = Math.floor(total / 60)
  const s = total - m * 60
  // s.toFixed(2) on values 0-9 produces "0.00"-"9.99"; padStart to "00.00"
  // shape so single-digit seconds always read as "M:0S.cc".
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

// Accepts:
//   "M:SS.cc"  e.g. "3:55.03"
//   "M:SS"     e.g. "3:55"
//   "SSS.cc"   e.g. "235.03"  (raw seconds, falls back to numeric parse)
// Returns null if input doesn't match any of those.
function parseTime(input: string): number | null {
  const t = input.trim()
  if (t === '') return null
  if (!t.includes(':')) {
    const n = parseFloat(t)
    return isFinite(n) ? Math.max(0, n) : null
  }
  const m = t.match(/^(\d+):([0-5]?\d)(?:\.(\d{1,3}))?$/)
  if (!m) return null
  const mins = parseInt(m[1], 10)
  const secs = parseInt(m[2], 10)
  const sub = m[3] ? parseFloat('0.' + m[3]) : 0
  return mins * 60 + secs + sub
}

export function Trim({ sermon, clip, clipIndex, clipCount, onBack, onNavigateClip,
  registerBeforeLeave, admin }: Props) {
  // clip.start / clip.end already have any saved start/end override applied
  // by the backend. The other override fields live in clip.user_edits.
  const userEdits = clip.user_edits ?? {}

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [start, setStart] = useState(clip.start)
  const [end, setEnd] = useState(clip.end)
  // Text-state for the M:SS.cc input fields. We keep these separate from
  // the numeric start/end so the user can edit freely (typing intermediate
  // values like "3:" or "3:5") without us snapping back. Parsed on blur /
  // Enter; reverts to last-good if input is invalid.
  const [startText, setStartText] = useState(() => formatTime(clip.start))
  const [endText, setEndText] = useState(() => formatTime(clip.end))
  const [timeDraftPending, setTimeDraftPending] = useState(false)
  const startTextDirty = useRef(false)
  const endTextDirty = useRef(false)
  const [looping, setLooping] = useState(false)
  const [exportJob, setExportJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<OverrideSaveStatus>('idle')
  const [switchingClip, setSwitchingClip] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [transcriptRevision, setTranscriptRevision] = useState(0)
  const [inspectorSection, setInspectorSection] = useState<'trim' | 'framing' | 'captions' | 'export'>('trim')
  const [showPlacementGuide, setShowPlacementGuide] = useState(false)
  const [scriptureDraft, setScriptureDraft] = useState(clip.scripture_reference ?? '')
  const [savedScripture, setSavedScripture] = useState(clip.scripture_reference ?? '')
  const [savingScripture, setSavingScripture] = useState(false)
  const [scriptureError, setScriptureError] = useState<string | null>(null)
  const [styles, setStyles] = useState<CaptionStyle[]>([])
  const [fonts, setFonts] = useState<string[]>([])
  const [editorInitial, setEditorInitial] = useState<CaptionStyle | null>(null)
  const [deletingStyleKey, setDeletingStyleKey] = useState<string | null>(null)
  const [managedStyleKey, setManagedStyleKey] = useState('')
  const styleEditorTrigger = useRef<HTMLButtonElement | null>(null)
  // Backend's default style key. Captured at captionStyles fetch time so the
  // Reset-to-suggestion handler can restore it after wiping overrides.
  const [defaultStyleKey, setDefaultStyleKey] = useState<string>('classic')
  // If the volunteer previously picked a style for this clip, start there;
  // otherwise the captionStyles() effect below sets the backend's default.
  const [styleKey, setStyleKey] = useState<string>(userEdits.caption_style ?? 'classic')
  const [includeHookTitle, setIncludeHookTitle] = useState<boolean>(
    userEdits.include_hook_title ?? true,
  )
  // Volunteer's drag-set caption position (px from bottom in 1080×1920 frame).
  // null = use the picked style's default. Resets to null when style changes
  // because each style has a different ideal default position.
  const [captionMarginV, setCaptionMarginV] = useState<number | null>(
    userEdits.caption_margin_v ?? null,
  )
  const [identities, setIdentities] = useState<Identity[]>([])
  const [identityScanned, setIdentityScanned] = useState(false)
  // null = "auto" (highest-score live face per sample). Set to an id when the
  // volunteer picks a specific face from the strip; the picker only shows up
  // if the scan found more than one identity.
  const [identityId, setIdentityId] = useState<number | null>(
    userEdits.identity_id ?? null,
  )
  // Zoom preset drives how much background sits around the pastor face. The
  // backend stays the source of truth for the multiplier values (3.6 / 5.0 /
  // 7.0). "medium" is the default the backend would otherwise pick on its
  // own, so leaving it at "medium" is equivalent to no override.
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>(
    (userEdits.zoom_level as ZoomLevel | undefined) ?? 'medium',
  )
  // When on, the renderer ignores per-frame face tracking and emits a static
  // crop at the median face position over the whole clip. Helps on a fixed
  // PTZ camera with a stationary pastor where any motion reads as wobble.
  // Doesn't apply to Stage mode (Stage already shows the full frame).
  const [lockCamera, setLockCamera] = useState<boolean>(
    userEdits.lock_camera ?? false,
  )

  useEffect(() => {
    api.captionStyles()
      .then((r) => {
        setStyles(r.styles)
        setFonts(r.fonts)
        setDefaultStyleKey(r.default)
        // Don't clobber a saved style choice with the backend default.
        if (userEdits.caption_style == null) setStyleKey(r.default)
      })
      .catch((e) => setError(`Caption styles unavailable: ${String(e)}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Identities for this sermon. Poll while scan is in progress so the picker
  // appears as soon as the prescan job finishes — no manual refresh needed.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      api.getIdentities(sermon.name)
        .then((r) => {
          if (cancelled) return
          setIdentities(r.identities)
          setIdentityScanned(r.scanned)
          if (!r.scanned) timer = setTimeout(tick, 5000)
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(tick, 8000)
        })
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [sermon.name])

  const deletingStyle = useRef(false)
  const selectedStyle = styles.find(style => style.key === styleKey)
  const managedStyle = styles.find(style => style.key === managedStyleKey && !style.built_in) ??
    styles.find(style => !style.built_in)
  const refreshStyles = async () => {
    const response = await api.captionStyles()
    setStyles(response.styles)
    setFonts(response.fonts)
  }
  const overridePayload = useCallback((selectedKey = styleKey): ClipUserEdits => ({
    start, end, caption_style: selectedKey,
    include_hook_title: includeHookTitle,
    caption_margin_v: selectedKey === styleKey ? captionMarginV : null,
    identity_id: identityId,
    zoom_level: zoomLevel === 'medium' ? null : zoomLevel,
    lock_camera: lockCamera ? true : null,
  }), [start, end, styleKey, includeHookTitle, captionMarginV, identityId, zoomLevel, lockCamera])
  const latestOverride = useRef<ClipUserEdits>(overridePayload())
  useLayoutEffect(() => { latestOverride.current = overridePayload() }, [overridePayload])
  const [autosave] = useState(() => new ClipOverrideAutosave(
    overridePayload(), edits => api.saveClipOverride(sermon.name, clipIndex, edits), setSaveStatus))
  const flushEditorRef = useRef<() => Promise<void>>(() => autosave.flush())
  useEffect(() => {
    registerBeforeLeave(() => flushEditorRef.current())
    return () => { registerBeforeLeave(null); autosave.dispose() }
  }, [autosave, registerBeforeLeave])
  const updateOverride = (patch: ClipUserEdits) => {
    latestOverride.current = { ...latestOverride.current, ...patch }
    autosave.schedule(latestOverride.current)
  }
  // Only volunteer-driven setters schedule writes. Fetching style defaults or
  // mounting an editor never creates an override.
  const setStartU: typeof setStart = value => {
    const next = typeof value === 'function' ? value(latestOverride.current.start ?? start) : value
    setStart(next)
    updateOverride({ start: next })
  }
  const setEndU: typeof setEnd = value => {
    const next = typeof value === 'function' ? value(latestOverride.current.end ?? end) : value
    setEnd(next)
    updateOverride({ end: next })
  }
  const setStyleKeyU: typeof setStyleKey = value => {
    const next = typeof value === 'function'
      ? value(latestOverride.current.caption_style ?? styleKey) : value
    setStyleKey(next)
    setCaptionMarginV(null)
    updateOverride({ caption_style: next, caption_margin_v: null })
  }
  const closeStyleEditor = () => {
    setEditorInitial(null)
    requestAnimationFrame(() => styleEditorTrigger.current?.focus())
  }
  const saveStyle = async (name: string, draft: CaptionStyle) => {
    const saved = editorInitial?.revision == null
      ? await api.createCaptionStyle(name, draft)
      : await api.updateCaptionStyle(editorInitial.key, name, draft, editorInitial.revision)
    await refreshStyles()
    setStyleKeyU(saved.key)
    closeStyleEditor()
  }
  const duplicateStyle = async () => {
    if (!selectedStyle) return
    setError(null)
    try {
      const saved = await api.duplicateCaptionStyle(selectedStyle.key, `Copy of ${selectedStyle.label}`)
      await refreshStyles()
      setStyleKeyU(saved.key)
      setEditorInitial(saved)
    } catch (e) { setError(String(e)) }
  }
  const deleteStyle = async (style: CaptionStyle) => {
    if (!canDeleteStyle(style) ||
        deletingStyle.current || !window.confirm(`Delete caption style “${style.label}”?`)) return
    deletingStyle.current = true
    setDeletingStyleKey(style.key)
    setError(null)
    try {
      await deleteClipCaptionStyle(style.key, styleKey, defaultStyleKey, {
        flushCurrentClip: async () => {
          await flushEditorRef.current()
        },
        persistCurrentClip: key => autosave.saveNow({ ...latestOverride.current,
          caption_style: key, caption_margin_v: null }),
        references: () => api.captionStyleReferences(style.key, sermon.name, clipIndex),
        selectDefault: () => {
          setStyleKey(defaultStyleKey)
          setCaptionMarginV(null)
          latestOverride.current = { ...latestOverride.current,
            caption_style: defaultStyleKey, caption_margin_v: null }
          autosave.markClean(latestOverride.current)
        },
        remove: async () => { await api.deleteCaptionStyle(style.key) },
        refresh: refreshStyles,
      })
    } catch (e) {
      setError(`Could not delete preset: ${String(e)}`)
    } finally {
      deletingStyle.current = false
      setDeletingStyleKey(null)
    }
  }
  const setIncludeHookTitleU: typeof setIncludeHookTitle = value => {
    const next = typeof value === 'function'
      ? value(latestOverride.current.include_hook_title ?? includeHookTitle) : value
    setIncludeHookTitle(next)
    updateOverride({ include_hook_title: next })
  }
  const setCaptionMarginVU: typeof setCaptionMarginV = value => {
    const next = typeof value === 'function'
      ? value(latestOverride.current.caption_margin_v ?? captionMarginV) : value
    setCaptionMarginV(next)
    updateOverride({ caption_margin_v: next })
  }
  const setIdentityIdU: typeof setIdentityId = value => {
    const next = typeof value === 'function'
      ? value(latestOverride.current.identity_id ?? identityId) : value
    setIdentityId(next)
    updateOverride({ identity_id: next })
  }
  const setZoomLevelU: typeof setZoomLevel = value => {
    const previous = latestOverride.current.zoom_level ?? 'medium'
    const next = typeof value === 'function' ? value(previous) : value
    setZoomLevel(next)
    updateOverride({ zoom_level: next === 'medium' ? null : next })
  }
  const setLockCameraU: typeof setLockCamera = value => {
    const next = typeof value === 'function'
      ? value(latestOverride.current.lock_camera ?? false) : value
    setLockCamera(next)
    updateOverride({ lock_camera: next ? true : null })
  }

  // Position the source video at start when clip changes
  useEffect(() => {
    const v = videoRef.current
    if (v) {
      v.currentTime = clip.start
    }
  }, [clip.start])

  // Keep the M:SS.cc text in sync with numeric state for any change that
  // doesn't originate from the input itself (nudge buttons, ⤓ playhead,
  // initial load). When the user is mid-typing we'd already be racing
  // their keystrokes, but commitStart/commitEnd reset to the canonical
  // formatted value on blur, so this is safe.
  // These effects keep editable text synchronized with numeric nudge/playhead updates.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setStartText(formatTime(start)) }, [start])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setEndText(formatTime(end)) }, [end])

  const commitStart = () => {
    startTextDirty.current = false
    setTimeDraftPending(endTextDirty.current)
    const parsed = parseTime(startText)
    if (parsed === null) {
      setStartText(formatTime(start))   // revert
      return
    }
    const next = Math.max(0, Math.min(parsed, end - 0.1))
    setStartU(next)
    setStartText(formatTime(next))
  }
  const commitEnd = () => {
    endTextDirty.current = false
    setTimeDraftPending(startTextDirty.current)
    const parsed = parseTime(endText)
    if (parsed === null) {
      setEndText(formatTime(end))
      return
    }
    const next = Math.max(start + 0.1, parsed)
    setEndU(next)
    setEndText(formatTime(next))
  }
  const flushEditor = async () => {
    // Browser Back may not blur the focused time field. Commit valid typed
    // values before flushing, using one final payload for both fields.
    const currentStart = latestOverride.current.start ?? start
    const currentEnd = latestOverride.current.end ?? end
    const parsedStart = startTextDirty.current ? parseTime(startText) : null
    const nextStart = parsedStart === null ? currentStart
      : Math.max(0, Math.min(parsedStart, currentEnd - 0.1))
    const parsedEnd = endTextDirty.current ? parseTime(endText) : null
    const nextEnd = parsedEnd === null ? currentEnd : Math.max(nextStart + 0.1, parsedEnd)
    const patch: ClipUserEdits = {}
    if (nextStart !== currentStart) { setStart(nextStart); patch.start = nextStart }
    if (nextEnd !== currentEnd) { setEnd(nextEnd); patch.end = nextEnd }
    if (startTextDirty.current) setStartText(formatTime(nextStart))
    if (endTextDirty.current) setEndText(formatTime(nextEnd))
    startTextDirty.current = false
    endTextDirty.current = false
    setTimeDraftPending(false)
    if (Object.keys(patch).length) updateOverride(patch)
    await autosave.flush()
  }
  useLayoutEffect(() => { flushEditorRef.current = flushEditor })

  // Loop within [start, end] when looping is on
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => {
      if (looping && v.currentTime >= end) {
        v.currentTime = start
      }
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [start, end, looping])

  // Poll the export job status. Faster cadence while running so the progress
  // bar feels responsive; backend throttles its DB writes, not us.
  useEffect(() => {
    if (!exportJob || exportJob.status === 'done' || exportJob.status === 'failed') return
    const id = setInterval(async () => {
      try {
        const updated = await api.getJob(exportJob.id)
        setExportJob(updated)
      } catch { /* A later poll will retry the status request. */ }
    }, 750)
    return () => clearInterval(id)
  }, [exportJob])

  const setInToCurrent = () => {
    const v = videoRef.current
    if (v) setStartU(parseFloat(v.currentTime.toFixed(2)))
  }
  const setOutToCurrent = () => {
    const v = videoRef.current
    if (v) setEndU(parseFloat(v.currentTime.toFixed(2)))
  }
  const seekTo = (t: number) => {
    const v = videoRef.current
    if (!v) return
    setLooping(false)
    v.pause()
    v.currentTime = t
  }
  const playRange = () => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = start
    v.play()
    setLooping(true)
  }
  const onExport = async () => {
    setError(null)
    try {
      await flushEditorRef.current()
      const edits = latestOverride.current
      const j = await api.startExportClip(
        sermon.name, clipIndex, edits.start ?? start, edits.end ?? end,
        edits.caption_style ?? styleKey, edits.include_hook_title ?? includeHookTitle,
        edits.caption_margin_v ?? null, edits.identity_id ?? null,
        edits.zoom_level ?? null, edits.lock_camera ?? false,
      )
      setExportJob(j)
    } catch (e) {
      setError(String(e))
    }
  }

  const saveScripture = async (value: string) => {
    setScriptureError(null)
    setSavingScripture(true)
    try {
      const result = await api.updateClipScriptureReference(
        sermon.name, clipIndex, clip.id, value.trim() || null,
      )
      setSavedScripture(result.scripture_reference ?? '')
      setScriptureDraft(result.scripture_reference ?? '')
    } catch (e) {
      setScriptureError(String(e))
    } finally {
      setSavingScripture(false)
    }
  }

  // Wipe saved overrides after earlier writes finish, then establish the
  // reset values as clean without creating a replacement override.
  const onResetToSuggestion = async () => {
    setError(null)
    try {
      await flushEditorRef.current()
      await api.resetClipOverride(sermon.name, clipIndex)
    } catch (e) {
      setError(`Reset failed: ${e}`)
      return
    }
    const originalStart = clip.original?.start ?? clip.start
    const originalEnd = clip.original?.end ?? clip.end
    setStart(originalStart)
    setEnd(originalEnd)
    setStyleKey(defaultStyleKey)
    setIncludeHookTitle(true)
    setCaptionMarginV(null)
    setIdentityId(null)
    setZoomLevel('medium')
    setLockCamera(false)
    startTextDirty.current = false
    endTextDirty.current = false
    setTimeDraftPending(false)
    setStartText(formatTime(originalStart))
    setEndText(formatTime(originalEnd))
    const clean = { start: originalStart, end: originalEnd,
      caption_style: defaultStyleKey, include_hook_title: true,
      caption_margin_v: null, identity_id: null, zoom_level: null,
      lock_camera: null }
    latestOverride.current = clean
    autosave.markClean(clean)
  }

  const moveClip = async (index: number) => {
    if (switchingClip || index < 0 || index >= clipCount) return
    setSwitchingClip(true)
    setError(null)
    try { await onNavigateClip(index) }
    catch (e) { setError(`Could not open clip: ${String(e)}`) }
    finally { setSwitchingClip(false) }
  }

  // Decide whether to show the face picker.
  //
  // Two failure modes the heuristic has to dodge, both stemming from the
  // identity tracker matching by centroid + size only (no face embeddings):
  //
  //   A. Layout fragmentation (e.g. Keep_Your_Eyes): ATEM switches between
  //      full-frame and PiP, so the same pastor shows up at different
  //      positions/sizes and gets multiple identity ids. → many sig tracks.
  //   B. Long-gap fragmentation (e.g. sermon-4c10f246): single camera, but
  //      the pastor steps off-camera for >30 min cumulative across the
  //      sermon and the gap-window splits him into 2-3 sequential tracks.
  //      → few sig tracks but they all look the same.
  //
  // The picker should ONLY appear when the data shows two genuinely
  // distinct on-screen appearances (different cx OR different face_h). For
  // a single-pastor sermon both A and B should hide the picker — auto-pick
  // (highest-score live face per sample) handles them correctly because it
  // picks the most prominent face per moment regardless of which track id
  // happens to own that detection.
  const totalSamples = identities.reduce((a, id) => a + id.n_samples, 0)
  const significantIdentities = identities.filter(
    (id) => totalSamples > 0 && id.n_samples / totalSamples >= 0.1,
  )
  // "Appearance signature" = (cx bucket, h bucket). If all sig identities
  // collapse to one bucket they're the same person fragmented; a real
  // second person on screen lands in a different bucket. Bucket sizes are
  // generous: cx by 20% of typical frame width, h by 40%.
  const FRAME_W_GUESS = 1920
  const significantClusters = new Set(
    significantIdentities.map((id) => {
      const cxBucket = Math.round(id.thumb_box.cx / (FRAME_W_GUESS * 0.2))
      const hBucket = Math.round(Math.log2(Math.max(1, id.thumb_box.h)) * 1.5)
      return `${cxBucket}:${hBucket}`
    })
  )
  // Combined rule:
  //   show iff 2-4 significant tracks AND at least 2 distinct appearance
  //   clusters. The 2-4 cap blocks layout-fragmentation messes (lots of
  //   same-person tracks in different layouts, e.g. ATEM switching). The
  //   cluster check blocks long-gap fragmentation (few same-person tracks
  //   from the pastor stepping off-camera). Both still hide for the rare
  //   case where one pastor genuinely shows up across many layouts; the
  //   only proper fix for that is face-embedding re-id, which isn't in v1.
  const showFacePicker =
    identityScanned &&
    significantIdentities.length >= 2 &&
    significantIdentities.length <= 4 &&
    significantClusters.size >= 2

  const exporting = exportJob && (exportJob.status === 'queued' || exportJob.status === 'running')
  const exportedPath = exportJob?.output_clip_path
  const exportedFilename = exportedPath ? exportedPath.split('/').pop() : null
  const currentExportedFilename = exportJob?.status === 'done' ? exportedFilename : (clip.exported ? clip.output_filename : null)
  const previous = clip.previous_export
  // Stale exports come from clip-runs of clips.json that have been overwritten.
  // The MP4 still exists; we offer a download but don't auto-play it because its
  // content corresponds to a different clip range than the one being trimmed now.
  const showStale = !currentExportedFilename && !exporting && previous

  return (
    <div className="trim editor-workspace">
      <header className="editor-header">
        <div className="editor-navigation-row">
          <button className="back" onClick={onBack}>← Back to clips</button>
          <div className="editor-clip-navigation">
            <button type="button" className="secondary"
              disabled={switchingClip || adjacentClip(clipIndex, clipCount, -1) === null}
              onClick={() => moveClip(clipIndex - 1)}>← Previous clip</button>
            <span className="muted small">{clipIndex + 1} of {clipCount}</span>
            <button type="button" className="secondary"
              disabled={switchingClip || adjacentClip(clipIndex, clipCount, 1) === null}
              onClick={() => moveClip(clipIndex + 1)}>Next clip →</button>
          </div>
          <span className={`editor-save-state ${saveStatus === 'failed' ? 'error-inline' : 'muted'}`}
            role={saveStatus === 'failed' ? 'alert' : 'status'} aria-live="polite">
            {saveStatus === 'failed' ? <>Save failed{' '}
                <button type="button" className="tertiary"
                  onClick={() => { void flushEditorRef.current().catch(() => {}) }}>Retry</button></> :
              timeDraftPending ? 'Unsaved edit' :
              saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : ''}
          </span>
        </div>
        <div className="editor-title-row">
          <div>
            <div className="eyebrow">Clip editor</div>
            <h2 className="trim-title">{clip.title}</h2>
          </div>
          {(clip.score ?? clip.hook_score) !== undefined && (
            <span className="hook-score large"
              style={hookScoreStyle(clip.score ?? clip.hook_score ?? 0)}
              title="Hook score: how likely a viewer keeps watching past 3 seconds">
              {clip.score ?? clip.hook_score}
            </span>
          )}
        </div>
        {(clip.why_selected ?? clip.rationale) &&
          <p className="editor-rationale muted">{clip.why_selected ?? clip.rationale}</p>}
        {admin ? <div className="editor-reference">
          <label htmlFor="clip-scripture-reference">Scripture reference <span className="muted small">optional</span></label>
          <div className="editor-reference-row">
            <input id="clip-scripture-reference" type="text" maxLength={120}
              value={scriptureDraft} onChange={e => setScriptureDraft(e.target.value)}
              placeholder="Add a reference if relevant" />
            <button type="button" className="secondary" disabled={savingScripture || scriptureDraft === savedScripture}
              onClick={() => saveScripture(scriptureDraft)}>Save</button>
            {savedScripture && <button type="button" className="secondary" disabled={savingScripture}
              onClick={() => saveScripture('')}>Clear</button>}
          </div>
          {scriptureError && <span className="error" role="alert">{scriptureError}</span>}
        </div> : savedScripture && <div className="editor-reference-readonly">{savedScripture}</div>}
      </header>

      <div className="editor-layout">
        <section className="editor-preview-workspace" aria-label="Vertical clip preview">
          <div className="editor-preview-heading">
            <div><div className="eyebrow">Live output</div><h3>Vertical preview</h3></div>
            <button type="button" className="editor-guide-toggle secondary" aria-pressed={showPlacementGuide}
              onClick={() => setShowPlacementGuide(value => !value)}>
              {showPlacementGuide ? 'Hide placement guide' : 'Placement guide'}
            </button>
          </div>
          <div className="editor-preview-frame">
            <LivePreview
              sermon={sermon.name} clipStart={start} clipEnd={end}
              transcriptRevision={transcriptRevision} sourceVideoRef={videoRef}
              captionStyle={selectedStyle ?? null} captionMarginV={captionMarginV}
              onCaptionMarginVChange={setCaptionMarginVU} includeHookTitle={includeHookTitle}
              hookTitle={clip.title} identityId={identityId} zoomLevel={zoomLevel}
              lockCamera={lockCamera} showPlacementGuide={showPlacementGuide}
            />
          </div>
          <div className="editor-preview-footer">
            <span className="muted small">Drag captions to adjust their vertical position.</span>
            <button type="button" className="secondary" onClick={playRange}>▶ Play selection</button>
            <button type="button" className="secondary" onClick={() => videoRef.current?.pause()}>Pause</button>
          </div>
          <details className="editor-source-drawer">
            <summary>Source video · scrub and set boundaries</summary>
            <video ref={videoRef} src={fileUrl.source(sermon.name)} controls preload="metadata"
              onLoadedMetadata={() => { if (videoRef.current) videoRef.current.currentTime = start }} />
          </details>
        </section>

        <aside className="editor-inspector" aria-label="Clip editor controls">
          <nav className="editor-inspector-nav" aria-label="Editor sections">
            {([
              ['trim', 'Trim'], ['framing', 'Framing'], ['captions', 'Captions'], ['export', 'Export'],
            ] as const).map(([key, label]) => <button key={key} type="button"
              className={inspectorSection === key ? 'selected' : ''}
              aria-pressed={inspectorSection === key}
              onClick={() => setInspectorSection(key)}>{label}</button>)}
          </nav>
          {error && <div className="error" role="alert">{error}</div>}
          {inspectorSection === 'trim' && <section className="editor-panel" aria-label="Trim controls">
            <div className="eyebrow">01 / Timing</div><h3>Trim the moment</h3>
            <p className="muted small">Enter M:SS.cc, nudge by a tenth of a second, or set a boundary from the source playhead.</p>
            <div className="editor-time-field">
              <label htmlFor="clip-start">Start</label>
              <input id="clip-start" type="text" inputMode="decimal" value={startText}
                onChange={e => { startTextDirty.current = true; setTimeDraftPending(true); setStartText(e.target.value) }} onBlur={commitStart}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                placeholder="M:SS.cc" />
              <div className="editor-time-actions">
                <button type="button" onClick={() => setStartU(s => Math.max(0, s - NUDGE_STEP))}>−0.1s</button>
                <button type="button" onClick={() => setStartU(s => s + NUDGE_STEP)}>+0.1s</button>
                <button type="button" onClick={setInToCurrent}>Set from playhead</button>
                <button type="button" onClick={() => seekTo(start)}>Go to start</button>
              </div>
            </div>
            <div className="editor-time-field">
              <label htmlFor="clip-end">End</label>
              <input id="clip-end" type="text" inputMode="decimal" value={endText}
                onChange={e => { endTextDirty.current = true; setTimeDraftPending(true); setEndText(e.target.value) }} onBlur={commitEnd}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                placeholder="M:SS.cc" />
              <div className="editor-time-actions">
                <button type="button" onClick={() => setEndU(s => Math.max(start + 0.1, s - NUDGE_STEP))}>−0.1s</button>
                <button type="button" onClick={() => setEndU(s => s + NUDGE_STEP)}>+0.1s</button>
                <button type="button" onClick={setOutToCurrent}>Set from playhead</button>
                <button type="button" onClick={() => seekTo(Math.max(0, end - 0.05))}>Go to end</button>
              </div>
            </div>
            <div className="editor-duration"><span>Selection length</span><strong>{formatTime(end - start)}</strong></div>
            <div className="editor-inline-actions">
              <button type="button" className="secondary" onClick={playRange}>▶ Play selection</button>
              <button type="button" className={looping ? 'active' : 'secondary'}
                aria-pressed={looping} onClick={() => setLooping(l => !l)}>Loop {looping ? 'on' : 'off'}</button>
            </div>
            {(
              start !== (clip.original?.start ?? clip.start) || end !== (clip.original?.end ?? clip.end) ||
              styleKey !== defaultStyleKey || !includeHookTitle || captionMarginV !== null ||
              identityId !== null || zoomLevel !== 'medium' || lockCamera
            ) && <button type="button" className="secondary editor-reset" onClick={onResetToSuggestion}
              title="Discard saved clip edits and return to the original suggestion">Reset to suggestion</button>}
            <button type="button" className="secondary editor-transcript-action"
              onClick={() => setShowTranscript(value => !value)}>
              {showTranscript ? 'Hide transcript corrections' : 'Correct transcript text'}
            </button>
          </section>}

          {inspectorSection === 'framing' && <section className="editor-panel" aria-label="Framing controls">
            <div className="eyebrow">02 / Composition</div><h3>Frame the subject</h3>
            <p className="muted small">Choose how much of the original frame appears in the vertical clip.</p>
            <div className="zoom-picker">
              <div className="editor-field-label">Frame size</div>
              <div className="zoom-picker-row">
                {(['tight', 'medium', 'wide', 'stage'] as ZoomLevel[]).map(level => <button
                  key={level} type="button" aria-pressed={zoomLevel === level}
                  className={`zoom-btn ${zoomLevel === level ? 'selected' : ''}`}
                  onClick={() => setZoomLevelU(level)}
                  title={level === 'tight' ? 'Closer crop around the face and shoulders' :
                    level === 'medium' ? 'Balanced default face crop' :
                    level === 'wide' ? 'More body and stage context where the source allows' :
                    'Full source frame on a blurred background; no face tracking'}>
                  {level[0].toUpperCase() + level.slice(1)}
                </button>)}
              </div>
              {zoomLevel === 'stage' && <p className="muted small">Stage shows the full source frame over a blurred fill.</p>}
              {zoomLevel !== 'stage' && <label className="lock-camera-toggle">
                <input type="checkbox" checked={lockCamera} onChange={e => setLockCameraU(e.target.checked)} />
                <span className="switch" aria-hidden="true"><span className="switch-thumb" /></span>
                <span>Lock camera <small className="muted">(hold the crop still)</small></span>
              </label>}
            </div>
            {showFacePicker && <div className="face-picker">
              <div className="editor-field-label">Follow subject</div>
              <div className="face-picker-row">
                <button type="button" className={`face-thumb auto ${identityId === null ? 'selected' : ''}`}
                  aria-pressed={identityId === null} onClick={() => setIdentityIdU(null)}
                  title="Auto: follow the most prominent face per moment">Auto</button>
                {significantIdentities.map(id => <button key={id.id} type="button"
                  className={`face-thumb ${identityId === id.id ? 'selected' : ''}`}
                  aria-pressed={identityId === id.id} onClick={() => setIdentityIdU(id.id)}
                  title={`Identity ${id.id} · ${id.n_samples} samples`}>
                  <img src={fileUrl.identityThumb(sermon.name, id.id)} alt={`Face ${id.id}`} />
                </button>)}
              </div>
            </div>}
            {!showFacePicker && <p className="muted small">Subject tracking uses the most prominent face automatically.</p>}
          </section>}

          {inspectorSection === 'captions' && <section className="editor-panel editor-captions-panel" aria-label="Caption controls">
            <div className="eyebrow">03 / Typography</div><h3>Caption style</h3>
            <p className="muted small">Choose a preset, then customize it for this clip. Built-in styles remain read-only.</p>
            {styles.length > 0 && <CaptionStylePicker styles={styles} value={styleKey} onChange={setStyleKeyU} />}
            {styleKey && styles.length > 0 && !selectedStyle &&
              <div className="error">Selected caption style is missing. Choose an available style before export.</div>}
            {admin && styles.length > 0 && <div className="editor-style-actions">
              <button type="button" className="secondary" onClick={e => {
                styleEditorTrigger.current = e.currentTarget
                setEditorInitial(editableStyleDraft(styles[0]))
              }}>+ New style</button>
              {selectedStyle && <>
                <button type="button" className="secondary" onClick={e => {
                  styleEditorTrigger.current = e.currentTarget
                  setEditorInitial(canEditStyle(selectedStyle) ? selectedStyle : editableStyleDraft(selectedStyle))
                }}>
                  {canEditStyle(selectedStyle) ? 'Edit style' : 'Customize'}
                </button>
                <button type="button" className="secondary" onClick={e => {
                  styleEditorTrigger.current = e.currentTarget
                  void duplicateStyle()
                }}>Duplicate</button>
                {canDeleteStyle(selectedStyle) && <button type="button" className="secondary"
                  disabled={deletingStyleKey !== null}
                  onClick={() => deleteStyle(selectedStyle)}>Delete</button>}
              </>}
              {managedStyle && <div className="editor-manage-style">
                <label htmlFor="manage-caption-style">Manage saved style</label>
                <select id="manage-caption-style" value={managedStyle.key}
                  onChange={e => setManagedStyleKey(e.target.value)}>
                  {styles.filter(style => !style.built_in).map(style =>
                    <option key={style.key} value={style.key}>{style.label}</option>)}
                </select>
                <button type="button" className="secondary" disabled={deletingStyleKey !== null}
                  onClick={() => deleteStyle(managedStyle)}>Delete saved style</button>
              </div>}
            </div>}
            <div className="editor-caption-options">
              <label className="hook-toggle" title="Burn the clip's hook title on screen for the first 2 seconds">
                <input type="checkbox" checked={includeHookTitle}
                  onChange={e => setIncludeHookTitleU(e.target.checked)} /> Hook title overlay
              </label>
              <p className="muted small">The opening title is separate from the caption style.</p>
              <div className="editor-position-row">
                <span className="editor-field-label">Position</span>
                <span className="muted small">{captionMarginV === null ? 'Preset default' : 'Custom placement'}</span>
                {captionMarginV !== null && <button type="button" className="secondary"
                  onClick={() => setCaptionMarginVU(null)}>Reset position</button>}
              </div>
            </div>
          </section>}

          {inspectorSection === 'export' && <section className="editor-panel" aria-label="Export controls">
            <div className="eyebrow">04 / Deliver</div><h3>Export vertical clip</h3>
            <div className="editor-export-summary">
              <div><span>Length</span><strong>{formatTime(end - start)}</strong></div>
              <div><span>Caption style</span><strong>{selectedStyle?.label ?? 'Unavailable'}</strong></div>
              <div><span>Frame</span><strong>{zoomLevel[0].toUpperCase() + zoomLevel.slice(1)}</strong></div>
            </div>
            <button type="button" className="primary editor-export-button" onClick={onExport}
              disabled={!!exporting || !selectedStyle}>{exporting ? 'Exporting…' : 'Export vertical clip'}</button>
            {exportJob?.status === 'failed' && <div className="error" role="alert">
              Export failed: {(exportJob.error ?? '').split('\n')[0]}</div>}
            <div className="export-status">
              {exporting && <div className="export-progress" role="status">
                <div>{exportJob?.progress_message ?? 'Exporting…'}</div>
                <progress value={exportJob?.progress_percent ?? 0} max={1} />
                <div className="progress-pct">{Math.round((exportJob?.progress_percent ?? 0) * 100)}%</div>
              </div>}
              {currentExportedFilename && <div className="editor-export-complete">
                <strong>Export ready</strong><a href={fileUrl.clip(currentExportedFilename)} download>Download MP4</a>
              </div>}
              {exportJob?.status === 'done' && adjacentClip(clipIndex, clipCount, 1) !== null &&
                <button type="button" className="secondary" disabled={switchingClip}
                  onClick={() => moveClip(clipIndex + 1)}>Next clip →</button>}
              {showStale && previous && <div className="stale-export-warning">
                Previous export from a different clip range ({previous.start.toFixed(1)} – {previous.end.toFixed(1)}s,
                {' '}{(previous.end - previous.start).toFixed(1)}s long) ·{' '}
                <a href={fileUrl.clip(previous.filename)} download>Download</a>
                <div className="muted small">Re-export to apply your current trim and settings.</div>
              </div>}
              {!exporting && !currentExportedFilename && !showStale && <p className="muted small">No export yet.</p>}
            </div>
            {currentExportedFilename && <Publish sermon={sermon} clip={clip} exportedFilename={currentExportedFilename} />}
          </section>}
        </aside>
      </div>
      {showTranscript && <TranscriptEditor source={sermon.name} start={start} end={end}
        onChanged={() => setTranscriptRevision(value => value + 1)} />}
      {editorInitial && <div className="editor-style-backdrop">
        <CaptionStyleEditor key={`${editorInitial.key}:${editorInitial.revision ?? 'new'}`}
          initial={editorInitial} fonts={fonts} onSave={saveStyle}
          onCancel={closeStyleEditor} />
      </div>}
    </div>
  )
}
