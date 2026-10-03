import { useEffect, useRef } from 'react'
import { fileUrl } from '../api'
import { selectionLabel } from '../clipProvenance'
import { formatClipTime, suitability } from '../clipLibrary'
import type { Clip, Sermon } from '../types'

export function ClipPreviewModal({ sermon, clip, onClose, onEdit }: {
  sermon: Sermon; clip: Clip; onClose: () => void; onEdit: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const score = suitability(clip)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const video = videoRef.current
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key === 'Tab' && dialogRef.current) {
        const elements = [...dialogRef.current.querySelectorAll<HTMLElement>('button, video[controls]')]
        const first = elements[0], last = elements.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); video?.pause(); previous?.focus() }
  }, [onClose])

  const stopAtEnd = () => {
    const video = videoRef.current
    if (video && video.currentTime >= clip.end) {
      video.pause()
      video.currentTime = clip.end
    }
  }
  return <div className="clip-modal-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <div className="clip-modal" role="dialog" aria-modal="true" aria-labelledby="clip-preview-title" ref={dialogRef}>
      <div className="clip-modal-heading">
        <div><p className="sermon-eyebrow">Clip preview</p><h2 id="clip-preview-title">{clip.title}</h2></div>
        <button type="button" className="secondary" onClick={onClose} ref={closeRef}>Close</button>
      </div>
      <video ref={videoRef} className="clip-modal-video" controls preload="metadata"
        src={fileUrl.source(sermon.name)}
        onLoadedMetadata={event => { event.currentTarget.currentTime = clip.start }}
        onSeeking={event => {
          if (event.currentTarget.currentTime < clip.start) event.currentTarget.currentTime = clip.start
          if (event.currentTarget.currentTime > clip.end) event.currentTarget.currentTime = clip.end
        }}
        onTimeUpdate={stopAtEnd} onPlay={event => {
          if (event.currentTarget.currentTime >= clip.end) event.currentTarget.currentTime = clip.start
        }} />
      <div className="clip-modal-details">
        {clip.scripture_reference && <p><strong>Scripture:</strong> {clip.scripture_reference}</p>}
        {score !== null && <p><strong>Suitability:</strong> <span className="media-card-score-inline">{score}</span></p>}
        <p><strong>Source:</strong> {selectionLabel(clip)}</p>
        <p><strong>Range:</strong> {formatClipTime(clip.start)} → {formatClipTime(clip.end)} · {formatClipTime(clip.end - clip.start)}</p>
        {clip.description && <p><strong>Description:</strong> {clip.description}</p>}
        {clip.hook && <p><strong>Hook:</strong> {clip.hook}</p>}
        {clip.why_selected && <p><strong>Why selected:</strong> {clip.why_selected}</p>}
        {clip.rationale && <p><strong>Rationale:</strong> {clip.rationale}</p>}
        {clip.hook_rationale && <p><strong>Hook rationale:</strong> {clip.hook_rationale}</p>}
      </div>
      <div className="clip-modal-actions"><button type="button" className="primary" onClick={onEdit}>Open editor</button></div>
    </div>
  </div>
}
