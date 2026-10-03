import { useState } from 'react'
import { fileUrl } from '../api'
import { selectionLabel } from '../clipProvenance'
import { dateLabel, formatClipTime, suitability } from '../clipLibrary'
import { hookScoreStyle } from '../hookScore'
import type { Clip, Sermon } from '../types'

export type ClipAction = (clip: Clip, index: number) => void

export function ClipMediaCard({ sermon, clip, index, onPreview, onEdit, status }: {
  sermon: Sermon; clip: Clip; index: number; onPreview: ClipAction; onEdit: ClipAction; status?: string
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const score = suitability(clip)
  const excerpt = clip.hook || clip.description
  return <article className="media-card">
    <div className="media-card-top">
      <button type="button" className="media-card-image" onClick={() => onPreview(clip, index)}
        aria-label={`Preview ${clip.title}`}>
        {!imageFailed && <img loading="lazy" alt="" aria-hidden="true"
          src={fileUrl.clipThumb(sermon.name, index, clip.id, clip.start, clip.end)}
          onError={() => setImageFailed(true)} />}
        {imageFailed && <span className="media-card-fallback" aria-hidden="true">▶</span>}
        <span className="media-card-duration">{formatClipTime(clip.end - clip.start)}</span>
      </button>
      <div className="media-card-title-block">
        <h4>{clip.title}</h4>
        {clip.scripture_reference && <p className="media-card-scripture">{clip.scripture_reference}</p>}
        <p className="media-card-date">{dateLabel(sermon)}</p>
      </div>
      {score !== null && <span className="media-card-score" title="Suitability score">
        <strong style={hookScoreStyle(score)}>{score}</strong><span>Suitability</span></span>}
    </div>
    <div className="media-card-tags">
      <span className="media-card-tag">{selectionLabel(clip)}</span>
      {clip.exported && <span className="media-card-tag is-exported">Exported</span>}
      {!clip.exported && clip.stale_export && <span className="media-card-tag">Previous export</span>}
      {status && <span className="media-card-tag">{status}</span>}
    </div>
    <div className="media-card-quote">
      <div className="media-card-timing"><span>{formatClipTime(clip.start)} → {formatClipTime(clip.end)}</span>
        <span>{formatClipTime(clip.end - clip.start)}</span></div>
      {excerpt && <p className="media-card-excerpt">{excerpt}</p>}
    </div>
    <div className="media-card-actions">
      <button type="button" className="media-card-edit" onClick={() => onEdit(clip, index)}>Edit / Trim</button>
      <button type="button" className="media-card-open" onClick={() => onPreview(clip, index)}>Preview clip →</button>
    </div>
  </article>
}
