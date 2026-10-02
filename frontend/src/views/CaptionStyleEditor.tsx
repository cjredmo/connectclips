import { useEffect, useMemo, useState } from 'react'
import { currentWordIndex } from '../captionReveal'
import { canEditPhraseSize, chunkCaptionWords, liveCaptionStyle, withPresentationMode } from '../captionStyles'
import type { CaptionStyle, CaptionPresentation, TranscriptWord } from '../types'
import { CaptionLine } from './CaptionLine'

const SAMPLE_WORDS: TranscriptWord[] = ['This', 'is', 'a', 'sample', 'caption'].map((text, index) => ({
  text, start: index * 0.7, end: index * 0.7 + 0.55,
}))

export function CaptionStyleEditor({ initial, fonts, onSave, onCancel }: {
  initial: CaptionStyle
  fonts: string[]
  onSave: (name: string, style: CaptionStyle) => Promise<void>
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<CaptionStyle>(initial)
  const [name, setName] = useState(initial.label)
  const [time, setTime] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const started = performance.now()
    const timer = setInterval(() => setTime(((performance.now() - started) / 1000) % 4.2), 70)
    return () => clearInterval(timer)
  }, [])
  const chunks = useMemo(() => chunkCaptionWords(SAMPLE_WORDS, draft), [draft])
  const chunk = chunks.find((item, index) => time >= item[0].start &&
    time < (draft.presentation_mode === 'full_chunk_highlight'
      ? (chunks[index + 1]?.[0].start ?? 4.2)
      : Math.min(item[item.length - 1].end, chunks[index + 1]?.[0].start ?? 4.2)))
  const update = (values: Partial<CaptionStyle>) => setDraft(current => ({ ...current, ...values }))
  const numberField = (label: string, field: keyof CaptionStyle, min: number, max: number) =>
    <label>{label}<input type="number" min={min} max={max} step="1"
      value={draft[field] as number}
      onChange={e => update({ [field]: Number(e.target.value) })} /></label>
  const colorField = (label: string, field: keyof CaptionStyle) =>
    <label>{label}<input type="color" value={draft[field] as string}
      onChange={e => update({ [field]: e.target.value.toUpperCase() })} /></label>

  const save = async () => {
    setError(null)
    setBusy(true)
    try { await onSave(name, draft) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  return <div className="cs-editor" role="dialog" aria-label="Caption style editor">
    <div className="cs-editor-form">
      <h3>{initial.revision === null ? 'New caption style' : 'Edit caption style'}</h3>
      <label>Name<input type="text" maxLength={80} value={name}
        onChange={e => setName(e.target.value)} /></label>
      <label>Caption display<select value={draft.presentation_mode}
        onChange={e => setDraft(current => withPresentationMode(
          current, e.target.value as CaptionPresentation))}>
        <option value="single_word">One word at a time</option>
        <option value="progressive_chunk">Reveal phrase as spoken</option>
        <option value="full_chunk_highlight">Show full phrase + highlight spoken word</option>
      </select></label>
      {canEditPhraseSize(draft) && numberField('Words per phrase', 'max_words_per_chunk', 2, 20)}
      {numberField('Maximum phrase characters', 'max_chars_per_chunk', 1, 200)}
      <label>Font<select value={draft.font_name} onChange={e => update({ font_name: e.target.value })}>
        {fonts.map(font => <option key={font} value={font}>{font}</option>)}
      </select></label>
      {numberField('Font size', 'font_size', 1, 300)}
      {colorField('Base text', 'primary_color')}
      {colorField('Spoken word', 'highlight_color')}
      {numberField('Active word scale (%)', 'highlight_scale', 50, 300)}
      {colorField('Outline color', 'outline_color')}
      {numberField('Outline thickness', 'outline_width', 0, 30)}
      {numberField('Shadow depth', 'shadow_depth', 0, 30)}
      <label>Background box<input type="checkbox" checked={draft.background_box}
        onChange={e => update({ background_box: e.target.checked })} /></label>
      {draft.background_box && <>{colorField('Box color', 'background_color')}
        <label>Box opacity ({Math.round(draft.background_opacity * 100)}%)
          <input type="range" min="0" max="100" value={Math.round(draft.background_opacity * 100)}
            onChange={e => update({ background_opacity: Number(e.target.value) / 100 })} />
        </label></>}
      <label>Vertical position<select value={draft.vertical_anchor}
        onChange={e => update({ vertical_anchor: e.target.value as CaptionStyle['vertical_anchor'] })}>
        <option value="bottom">Bottom</option><option value="middle">Middle</option>
        <option value="top">Top</option>
      </select></label>
      {numberField('Position margin (px)', 'margin_v', 0, 1920)}
      {error && <div className="error">{error}</div>}
      <div className="action-row"><button type="button" disabled={busy} onClick={save}>Save style</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button></div>
    </div>
    <div className="cs-editor-preview">
      <div className="muted">Live style preview · sample words</div>
      <div className="live-preview" style={{ width: 360, height: 640 }}>
        {chunk && <div className="cap-live" style={liveCaptionStyle(draft, null)}>
          <CaptionLine words={chunk} currentIndex={currentWordIndex(chunk, time)} style={draft} />
        </div>}
      </div>
    </div>
  </div>
}
