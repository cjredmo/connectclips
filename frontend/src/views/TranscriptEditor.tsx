import { useEffect, useState } from 'react'
import { api } from '../api'
import type { TranscriptEdit, TranscriptResponse, TranscriptSegment } from '../types'

type Selection = { segment: TranscriptSegment; first: number; last: number; edit?: TranscriptEdit }

export function TranscriptEditor({ source, start, end, onChanged }: {
  source: string; start: number; end: number; onChanged: () => void
}) {
  const [data, setData] = useState<TranscriptResponse | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [replacement, setReplacement] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
    if (!selection) return
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
    if (!selection?.edit) return
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
    <section className="transcript-editor">
      <h3>Transcript corrections</h3>
      <p className="muted small">Select a word, then extend the range if needed. Corrections change text; saved word timings stay the same until alignment. Admin mode is required to save.</p>
      {data?.warnings.map((warning, i) => <p className="error" key={i}>{warning}</p>)}
      {error && <p className="error">{error}</p>}
      {data && <p className="muted small">Raw transcription: {data.raw_quality.status}. Effective transcript: {data.effective_quality.status}.</p>}
      {data?.repair.human_review_required && <p className="error">Transcript requires review before clip selection.</p>}
      <div className="transcript-segments">
        {data?.segments.map((segment) => (
          <p key={segment.id}>
            <span className="muted small">{Math.floor(segment.start / 60)}:{String(Math.floor(segment.start % 60)).padStart(2, '0')} </span>
            {segment.words.map((word, index) => {
              if (!word.word) return null
              const edited = data.edits.some(edit => edit.segment_id === segment.id &&
                index >= edit.word_index && index < edit.word_index + edit.original_words.length)
              return <button type="button" key={index}
                className={`transcript-word${edited ? ' edited' : ''}`}
                title={edited ? 'Corrected text — select to edit or revert' : 'Select to correct'}
                onClick={() => selectWord(segment, index)}>{word.word}</button>
            })}
          </p>
        ))}
        {data && data.segments.length === 0 && <p className="muted">No transcript words in this clip range.</p>}
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
