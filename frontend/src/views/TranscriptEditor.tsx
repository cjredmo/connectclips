import { useEffect, useMemo, useRef, useState } from 'react'
import { api, fileUrl } from '../api'
import { findTranscriptMatches } from '../transcriptSearch'
import type { TranscriptEdit, TranscriptResponse, TranscriptSegment } from '../types'

type Selection = { segment: TranscriptSegment; first: number; last: number; edit?: TranscriptEdit }

export function TranscriptEditor({ source, start, end, onChanged, fullSermon = false }: {
  source: string; start?: number; end?: number; onChanged: () => void; fullSermon?: boolean
}) {
  const [data, setData] = useState<TranscriptResponse | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [replacement, setReplacement] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const segmentNodes = useRef(new Map<number, HTMLParagraphElement>())
  const media = useRef<HTMLVideoElement>(null)
  const matches = useMemo(() => findTranscriptMatches(data?.segments ?? [], query), [data, query])

  const jumpTo = (index: number) => {
    if (!matches.length) return
    const next = (index + matches.length) % matches.length
    setActiveMatch(next)
    segmentNodes.current.get(matches[next].segmentIndex)?.scrollIntoView({ block: 'center' })
  }

  const seekTo = (seconds: number) => {
    if (!media.current) return
    media.current.currentTime = seconds
    void media.current.play().catch(() => {})
  }

  const refresh = async () => setData(await api.getTranscript(source, start, end))
  useEffect(() => {
    let active = true
    api.getTranscript(source, start, end)
      .then((result) => { if (active) setData(result) })
      .catch((e) => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [source, start, end])

  const selectWord = (segment: TranscriptSegment, index: number) => {
    const edit = data?.edits.find((item) => item.segment_id === segment.id &&
      index >= item.word_index && index < item.word_index + item.original_words.length)
    const first = edit?.word_index ?? index
    const last = edit ? first + edit.original_words.length - 1 : index
    setSelection({ segment, first, last, edit })
    setReplacement(edit?.corrected_text ?? segment.raw_words.slice(first, last + 1).map(w => w.word).join(' '))
    setError(null)
  }

  const setLast = (last: number) => {
    if (!selection) return
    setSelection({ ...selection, last, edit: undefined })
    setReplacement(selection.segment.raw_words.slice(selection.first, last + 1).map(w => w.word).join(' '))
  }

  const save = async () => {
    if (!selection || !data?.supports_effective_transcript) return
    setBusy(true)
    setError(null)
    try {
      await api.saveTranscriptEdit(source, {
        segment_id: selection.segment.id,
        word_index: selection.first,
        original_words: selection.segment.raw_words.slice(selection.first, selection.last + 1),
        corrected_text: replacement,
      }, selection.edit?.id)
      await refresh()
      setSelection(null)
      onChanged()
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  const revert = async () => {
    if (!selection?.edit || !data?.supports_effective_transcript) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteTranscriptEdit(source, selection.edit.id)
      await refresh()
      setSelection(null)
      onChanged()
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  return (
    <section className={`transcript-editor${fullSermon ? ' full-transcript' : ''}`}>
      <h3>{fullSermon ? 'Review full transcript' : 'Transcript corrections'}</h3>
      <p className="muted small">Select a word, then extend the range if needed. Corrections change text; saved word timings stay the same until alignment. Admin mode is required to save.</p>
      {data?.warnings.map((warning, i) => <p className="error" key={i}>{warning}</p>)}
      {data && !data.supports_effective_transcript &&
        <p className="error">The backend needs a restart before transcript corrections are available.</p>}
      {error && <p className="error">{error}</p>}
      {data && <p className="muted small">Raw transcription: {data.raw_quality.status}. Effective transcript: {data.effective_quality.status}.</p>}
      {data?.repair.human_review_required && <p className="error">Transcript requires review before clip selection.</p>}
      {fullSermon && <>
        <div className="transcript-review-tools">
          <label htmlFor="transcript-search">Search transcript</label>
          <input id="transcript-search" type="search" value={query}
            onChange={event => { setQuery(event.target.value); setActiveMatch(0) }}
            onKeyDown={event => { if (event.key === 'Enter') jumpTo(activeMatch) }}
            placeholder="Find words or a phrase" />
          {query.trim() && <span className="muted small">{matches.length} match{matches.length === 1 ? '' : 'es'}</span>}
          {matches.length > 0 && <>
            <button type="button" onClick={() => jumpTo(activeMatch - 1)}>Previous</button>
            <button type="button" onClick={() => jumpTo(activeMatch + 1)}>Next</button>
            <button type="button" onClick={() => jumpTo(activeMatch)}>Jump to {activeMatch + 1}</button>
          </>}
        </div>
        <video ref={media} className="transcript-source-player" controls preload="metadata" src={fileUrl.source(source)} />
        <p className="muted small">Select a timestamp to play the source from that point. Underlined words have human corrections.</p>
      </>}
      <div className="transcript-segments">
        {data?.segments.map((segment, segmentIndex) => (
          <p key={segment.id} ref={node => { if (node) segmentNodes.current.set(segmentIndex, node); else segmentNodes.current.delete(segmentIndex) }}
            className={fullSermon && matches[activeMatch]?.segmentIndex === segmentIndex ? 'transcript-search-match' : undefined}>
            {fullSermon ? <button type="button" className="transcript-timestamp" onClick={() => seekTo(segment.start)}
              title="Play source from this timestamp">{Math.floor(segment.start / 60)}:{String(Math.floor(segment.start % 60)).padStart(2, '0')}</button> :
              <span className="muted small">{Math.floor(segment.start / 60)}:{String(Math.floor(segment.start % 60)).padStart(2, '0')} </span>}
            {segment.words.map((word, index) => {
              if (!word.word) return null
              const edited = data.edits.some(edit => edit.segment_id === segment.id &&
                index >= edit.word_index && index < edit.word_index + edit.original_words.length)
              return <button type="button" key={index}
                disabled={!data.supports_effective_transcript}
                className={`transcript-word${edited ? ' edited' : ''}`}
                title={edited ? 'Corrected text — select to edit or revert' : 'Select to correct'}
                onClick={() => selectWord(segment, index)}>{word.word}</button>
            })}
          </p>
        ))}
        {data && data.segments.length === 0 && <p className="muted">No transcript words {fullSermon ? 'available.' : 'in this clip range.'}</p>}
      </div>
      {selection && <div className="transcript-correction-form">
        <div className="muted small">Original: {selection.segment.raw_words.slice(selection.first, selection.last + 1).map(w => w.word).join(' ')}</div>
        {!selection.edit && <label>Through word
          <select value={selection.last} onChange={e => setLast(Number(e.target.value))}>
            {selection.segment.raw_words.slice(selection.first, selection.first + 12).map((word, offset) =>
              <option key={offset} value={selection.first + offset}>{word.word}</option>)}
          </select>
        </label>}
        <label>Correction
          <input value={replacement} onChange={e => setReplacement(e.target.value)} maxLength={500} />
        </label>
        <div className="action-row">
          <button type="button" className="primary" onClick={save} disabled={busy || !replacement.trim()}>Save correction</button>
          {selection.edit && <button type="button" onClick={revert} disabled={busy}>Revert correction</button>}
          <button type="button" onClick={() => setSelection(null)} disabled={busy}>Cancel</button>
        </div>
      </div>}
    </section>
  )
}
