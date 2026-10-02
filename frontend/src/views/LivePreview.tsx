import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { currentWordIndex } from '../captionReveal'
import { captionBottomMargin, chunkCaptionWords, liveCaptionStyle } from '../captionStyles'
import type { CaptionStyle, Track, TranscriptWord } from '../types'
import { CaptionLine } from './CaptionLine'

type Props = {
  sermon: string
  clipStart: number
  clipEnd: number
  transcriptRevision?: number
  sourceVideoRef: React.RefObject<HTMLVideoElement | null>
  captionStyle: CaptionStyle | null
  captionMarginV: number | null
  onCaptionMarginVChange: (v: number | null) => void
  includeHookTitle: boolean
  hookTitle: string
  identityId: number | null
  zoomLevel?: string | null
  lockCamera?: boolean
}

// Pane rendering size — keep it cheap to draw and easy to lay out next to the
// trim controls. The source frame is decoded once per frame inside the <video>
// element, then we crop+blit a 360×640 region onto canvas via drawImage.
const PANE_W = 360
const PANE_H = 640
// Reference frame height (matches reframe.OUT_H). caption_margin_v is in this
// coordinate space; we scale it by PANE_H / FRAME_H to position the overlay.
const FRAME_H = 1920
const PANE_SCALE = PANE_H / FRAME_H

const HOOK_DURATION = 2.0
const HOOK_FADE = 0.3

// Port of backend captions._fit_font_size — pick a hook font size that lets
// the longest line fit horizontally without libass auto-wrapping further.
const HOOK_LINE_WIDTH_PX = 920
const CHAR_WIDTH_RATIO = 0.55
const HOOK_FONT_MIN = 80
const HOOK_FONT_MAX = 140
function fitHookFontSize(longestChars: number): number {
  if (longestChars <= 0) return HOOK_FONT_MAX
  const raw = HOOK_LINE_WIDTH_PX / (longestChars * CHAR_WIDTH_RATIO)
  return Math.max(HOOK_FONT_MIN, Math.min(HOOK_FONT_MAX, Math.floor(raw)))
}

// Two-line balanced wrap (mirror of backend _hook_title_text_and_size).
function hookLines(title: string): { lines: string[]; fontSize: number } {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { lines: [''], fontSize: HOOK_FONT_MAX }
  if (words.length <= 2) {
    const text = words.join(' ')
    return { lines: [text], fontSize: fitHookFontSize(text.length) }
  }
  const total = words.reduce((a, w) => a + w.length, 0)
  let best = Math.floor(words.length / 2)
  let bestScore = Infinity
  let running = 0
  for (let i = 1; i < words.length; i++) {
    running += words[i - 1].length
    const score = Math.max(running, total - running)
    if (score < bestScore) { bestScore = score; best = i }
  }
  const top = words.slice(0, best).join(' ')
  const bottom = words.slice(best).join(' ')
  return { lines: [top, bottom], fontSize: fitHookFontSize(Math.max(top.length, bottom.length)) }
}

export function LivePreview({
  sermon, clipStart, clipEnd, transcriptRevision, sourceVideoRef,
  captionStyle, captionMarginV, onCaptionMarginVChange,
  includeHookTitle, hookTitle, identityId, zoomLevel, lockCamera,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const trackRef = useRef<Track | null>(null)
  const [track, setTrack] = useState<Track | null>(null)
  const [trackLoading, setTrackLoading] = useState(false)
  const [trackError, setTrackError] = useState<string | null>(null)
  const [words, setWords] = useState<TranscriptWord[]>([])
  const [clipTime, setClipTime] = useState(0)  // seconds since clipStart, drives caption + hook visibility

  const stageMode = zoomLevel === 'stage'

  // Fetch track. With the source-level prescan in place this is a near-instant
  // slice. The first call after a fresh upload (before prescan completes) falls
  // back to a full source scan and can take a few minutes.
  // Stage mode skips the track fetch entirely — the canvas renders the
  // blurred-cover + foreground composite client-side from just the source
  // video element. No per-frame face crop is involved.
  useEffect(() => {
    let cancelled = false
    setTrack(null)
    trackRef.current = null
    setTrackError(null)
    if (stageMode) {
      setTrackLoading(false)
      return () => { cancelled = true }
    }
    setTrackLoading(true)
    api.getClipTrack(sermon, clipStart, clipEnd, identityId, zoomLevel, lockCamera)
      .then((t) => { if (!cancelled) { setTrack(t); trackRef.current = t } })
      .catch((e) => { if (!cancelled) setTrackError(String(e)) })
      .finally(() => { if (!cancelled) setTrackLoading(false) })
    return () => { cancelled = true }
  }, [sermon, clipStart, clipEnd, identityId, zoomLevel, stageMode, lockCamera])

  // Fetch words for caption rendering. Cheap — just a JSON slice.
  useEffect(() => {
    let cancelled = false
    api.getTranscriptWords(sermon, clipStart, clipEnd)
      .then((r) => { if (!cancelled) setWords(r.words) })
      .catch(() => { if (!cancelled) setWords([]) })
    return () => { cancelled = true }
  }, [sermon, clipStart, clipEnd, transcriptRevision])

  // Frame loop driven by the source video. requestVideoFrameCallback fires per
  // decoded video frame (60Hz on this 60fps source) and also on seek, so the
  // canvas crop stays glued to whatever the user is doing in the source player.
  // Falls back to rAF for the rare browsers without rVFC.
  const drawFrame = useCallback(() => {
    const v = sourceVideoRef.current
    const canvas = canvasRef.current
    if (!v || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Stage mode renders entirely from the source video (no backend track).
    // Two passes: a heavily-blurred cover-scaled background, then the source
    // letterboxed into the middle scaled-to-width. Mirrors the ffmpeg
    // filtergraph used at export time so what volunteers see ≈ what ships.
    if (stageMode) {
      const srcW = v.videoWidth || 16
      const srcH = v.videoHeight || 9
      const cw = canvas.width
      const ch = canvas.height
      // 1. Cover-scale the source to fill the canvas (and beyond), blur it.
      const coverScale = Math.max(cw / srcW, ch / srcH)
      const dw = srcW * coverScale
      const dh = srcH * coverScale
      const dx = (cw - dw) / 2
      const dy = (ch - dh) / 2
      try {
        ctx.filter = 'blur(20px)'
        ctx.drawImage(v, 0, 0, srcW, srcH, dx, dy, dw, dh)
        ctx.filter = 'none'
        // 2. Foreground: scale-to-width, centered vertically.
        const fgScale = cw / srcW
        const fgH = srcH * fgScale
        const fgY = (ch - fgH) / 2
        ctx.drawImage(v, 0, 0, srcW, srcH, 0, fgY, cw, fgH)
      } catch {
        // drawImage throws if the video isn't ready; ignore until next frame
      }
      return
    }

    const t = trackRef.current
    if (!t) return

    // Map source time → frame index in the track
    const dt = v.currentTime - clipStart
    const idx = Math.max(0, Math.min(t.n_frames - 1, Math.round(dt * t.fps)))
    const [cx, cy, ch] = t.track[idx]
    const aspect = t.out_w / t.out_h
    const cw = ch * aspect
    const sx = Math.max(0, Math.min(t.src_w - cw, cx - cw / 2))
    const sy = Math.max(0, Math.min(t.src_h - ch, cy - ch / 2))

    try {
      ctx.drawImage(v, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height)
    } catch {
      // drawImage throws if the video isn't ready; ignore until next frame
    }
  }, [sourceVideoRef, clipStart, stageMode])

  useEffect(() => {
    const v = sourceVideoRef.current
    if (!v) return
    let id: number | null = null
    let rafId: number | null = null

    // Keep the captions / hook overlay in step with the source's currentTime.
    // Updating React state every frame is wasteful for caption rendering (changes
    // only every ~300-500ms typically), but keeping it simple here — re-renders
    // of a small element are cheap.
    const tick = () => {
      drawFrame()
      const t = v.currentTime - clipStart
      setClipTime(t)
      if ('requestVideoFrameCallback' in v) {
        id = (v as any).requestVideoFrameCallback(tick)
      } else {
        rafId = requestAnimationFrame(tick)
      }
    }
    if ('requestVideoFrameCallback' in v) {
      id = (v as any).requestVideoFrameCallback(tick)
    } else {
      rafId = requestAnimationFrame(tick)
    }
    // Initial paint in case the video is paused — without this the canvas
    // stays blank until first play.
    drawFrame()

    return () => {
      if (id != null && 'cancelVideoFrameCallback' in v) (v as any).cancelVideoFrameCallback(id)
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [drawFrame, clipStart, sourceVideoRef, track])

  // Compute current chunk + current word for caption rendering.
  const chunks = useMemo(() => {
    return captionStyle ? chunkCaptionWords(words, captionStyle) : []
  }, [words, captionStyle])

  const currentChunk = (() => {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      const start = c[0].start
      const end = i + 1 < chunks.length
        ? (captionStyle?.presentation_mode === 'full_chunk_highlight'
          ? chunks[i + 1][0].start
          : Math.min(c[c.length - 1].end, chunks[i + 1][0].start))
        : (captionStyle?.presentation_mode === 'full_chunk_highlight'
          ? Math.max(c[c.length - 1].end, clipEnd - clipStart)
          : c[c.length - 1].end)
      if (clipTime >= start && clipTime < end) {
        // Find the current word within the chunk
        const wordIdx = currentWordIndex(c, clipTime)
        return { chunk: c, wordIdx }
      }
    }
    return null
  })()

  // Hook overlay visibility + opacity (fade in 0-0.3s, hold, fade out 1.7-2.0s).
  const hook = useMemo(() => {
    if (!includeHookTitle || !hookTitle) return null
    if (clipTime < 0 || clipTime > HOOK_DURATION) return null
    let opacity = 1
    if (clipTime < HOOK_FADE) opacity = clipTime / HOOK_FADE
    else if (clipTime > HOOK_DURATION - HOOK_FADE) opacity = (HOOK_DURATION - clipTime) / HOOK_FADE
    const { lines, fontSize } = hookLines(hookTitle)
    return { lines, fontSize: fontSize * PANE_SCALE, opacity }
  }, [clipTime, includeHookTitle, hookTitle])

  // Effective caption_margin_v — the volunteer's drag value if set, otherwise
  // the style's default. Translated to a CSS bottom offset within the pane.
  const effectiveMarginV = captionStyle ? captionBottomMargin(captionStyle, captionMarginV) : 0
  const captionBottomPx = effectiveMarginV * PANE_SCALE

  // Drag handle: vertical-only. We drag the caption box's center, then derive
  // margin_v from where it ended up. Clamped so the box can't go off-frame.
  const dragRef = useRef<{ startY: number; startMarginV: number } | null>(null)
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, startMarginV: effectiveMarginV }
  }
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const dy = e.clientY - dragRef.current.startY
    // Pane Y increases downward; margin_v measures FROM bottom, so dragging
    // down should DECREASE margin_v (caption moves toward bottom).
    const newMarginV = dragRef.current.startMarginV - dy / PANE_SCALE
    const clamped = Math.max(80, Math.min(FRAME_H - 80, Math.round(newMarginV)))
    onCaptionMarginVChange(clamped)
  }
  const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = null
  }

  return (
    <div className="live-preview" style={{ width: PANE_W, height: PANE_H }}>
      <canvas
        ref={canvasRef}
        width={PANE_W}
        height={PANE_H}
        className="live-preview-canvas"
      />
      {trackLoading && (
        <div className="live-preview-status">Scanning faces…</div>
      )}
      {trackError && (
        <div className="live-preview-status error">Track error: {trackError}</div>
      )}
      {hook && (
        <div
          className="hook-live"
          style={{
            opacity: hook.opacity,
            fontSize: `${hook.fontSize}px`,
            lineHeight: 1.1,
          }}
        >
          {hook.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {currentChunk && captionStyle && (
        <div
          className="cap-live"
          style={liveCaptionStyle(captionStyle, captionMarginV)}
        >
          <CaptionLine words={currentChunk.chunk} currentIndex={currentChunk.wordIdx}
            style={captionStyle} />
        </div>
      )}
      {/* Drag handle for caption position. Captures the pointer so a drag that
          leaves the box still ends gracefully. Only meaningful while there's
          something to drag — hide while no chunks are loaded. */}
      {chunks.length > 0 && (
        <div
          className="caption-drag-handle"
          style={{ bottom: `${captionBottomPx - 12}px`, height: '24px' }}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          title="Drag up/down to position captions"
        />
      )}
    </div>
  )
}
