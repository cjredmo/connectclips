import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { currentWordIndex } from '../captionReveal'
import { BACKGROUND_DURATIONS, canEditPhraseSize, captionBackgroundAtTime,
  captionBackgroundIntervals, captionChunkEnd, chunkCaptionWords, liveCaptionStyle,
  PRESENTATION_MODES, showBackgroundLingerInput, withPresentationMode } from '../captionStyles'
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
    time < captionChunkEnd(chunks, index, draft, 4.2))
  const background = captionBackgroundAtTime(captionBackgroundIntervals(chunks, draft, 4.2), time)
  const update = (values: Partial<CaptionStyle>) => setDraft(current => ({ ...current, ...values }))
  const numberField = (label: string, field: keyof CaptionStyle, min: number, max: number) =>
    <label>{label}<input type="number" min={min} max={max} step="1"
      value={draft[field] as number}
      onChange={e => update({ [field]: Number(e.target.value) })} /></label>
  const colorField = (label: string, field: keyof CaptionStyle) =>
    <label>{label}<span className="cs-color-field"><input type="color" value={draft[field] as string}
      onChange={e => update({ [field]: e.target.value.toUpperCase() })} />
      <span>{draft[field] as string}</span></span></label>

  const save = async () => {
    setError(null)
    setBusy(true)
    try { await onSave(name, draft) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { onCancel(); return }
    if (event.key !== 'Tab') return
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
    ))
    if (!focusable.length) return
    if (event.shiftKey && document.activeElement === focusable[0]) {
      event.preventDefault()
      focusable[focusable.length - 1].focus()
    } else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
      event.preventDefault()
      focusable[0].focus()
    }
  }
  return <div className="cs-editor" role="dialog" aria-modal="true" aria-label="Caption style editor"
    onKeyDown={onDialogKeyDown}>
    <div className="cs-editor-form">
      <div className="cs-editor-heading">
        <div><div className="eyebrow">Custom caption style</div>
          <h3>{initial.revision === null ? 'Create a style' : 'Edit style'}</h3></div>
        <button type="button" className="secondary" onClick={onCancel} aria-label="Close style editor">✕</button>
      </div>
      <label className="cs-style-name">Style name<input type="text" autoFocus maxLength={80} value={name}
        onChange={e => setName(e.target.value)} /></label>
      <fieldset><legend>Text</legend><div className="cs-field-grid">
        <label>Font<select value={draft.font_name} onChange={e => update({ font_name: e.target.value })}>
          {fonts.map(font => <option key={font} value={font}>{font}</option>)}
        </select></label>
        {numberField('Size', 'font_size', 1, 300)}
        <label>Weight<select value={draft.font_weight >= 700 ? 'bold' : 'regular'}
          onChange={e => update({ font_weight: e.target.value === 'bold' ? 800 : 400 })}>
          <option value="regular">Regular</option><option value="bold">Bold</option>
        </select></label>
        {colorField('Base color', 'primary_color')}
      </div></fieldset>
      <fieldset><legend>Highlight</legend><div className="cs-field-grid">
        {colorField('Active word', 'highlight_color')}
        {numberField('Active word scale (%)', 'highlight_scale', 50, 300)}
        <label className="cs-field-wide">Caption display<select value={draft.presentation_mode}
          onChange={e => setDraft(current => withPresentationMode(
            current, e.target.value as CaptionPresentation))}>
          {PRESENTATION_MODES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select><small>{PRESENTATION_MODES.find(option => option.value === draft.presentation_mode)?.description}</small></label>
      </div></fieldset>
      <fieldset><legend>Readability</legend><div className="cs-field-grid">
        {colorField('Outline color', 'outline_color')}
        {numberField('Outline thickness', 'outline_width', 0, 30)}
        {numberField('Shadow depth', 'shadow_depth', 0, 30)}
        <label className="cs-check"><input type="checkbox" checked={draft.background_box}
          onChange={e => update({ background_box: e.target.checked })} /> Background box</label>
        {draft.background_box && <>{colorField('Box color', 'background_color')}
          <label>Box opacity ({Math.round(draft.background_opacity * 100)}%)
            <input type="range" min="0" max="100" value={Math.round(draft.background_opacity * 100)}
              onChange={e => update({ background_opacity: Number(e.target.value) / 100 })} />
          </label>
          <label>Background duration<select value={draft.background_persistence}
            onChange={e => update({ background_persistence: e.target.value as CaptionStyle['background_persistence'] })}>
            {BACKGROUND_DURATIONS.map(option => <option key={option.value} value={option.value}>
              {option.label}</option>)}
          </select></label>
          {showBackgroundLingerInput(draft) &&
            <label>Hold for <input type="number" min="0" max="10" step="0.1"
              value={draft.background_linger_seconds}
              onChange={e => update({ background_linger_seconds: Number(e.target.value) })} /> seconds</label>}
        </>}
      </div></fieldset>
      <fieldset><legend>Placement</legend><div className="cs-field-grid">
        <label>Vertical anchor<select value={draft.vertical_anchor}
          onChange={e => update({ vertical_anchor: e.target.value as CaptionStyle['vertical_anchor'] })}>
          <option value="bottom">Bottom</option><option value="middle">Middle</option>
          <option value="top">Top</option>
        </select></label>
        {numberField('Position margin (px)', 'margin_v', 0, 1920)}
      </div></fieldset>
      <fieldset><legend>Phrase</legend><div className="cs-field-grid">
        {canEditPhraseSize(draft) && numberField('Words per phrase', 'max_words_per_chunk', 2, 20)}
        {numberField('Maximum phrase characters', 'max_chars_per_chunk', 1, 200)}
      </div></fieldset>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="cs-editor-actions"><button type="button" className="primary" disabled={busy} onClick={save}>Save style</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button></div>
    </div>
    <div className="cs-editor-preview">
      <div className="eyebrow">Live sample</div>
      <p className="muted small">Preview uses synthetic words and the selected presentation mode.</p>
      <div className="live-preview" style={{ width: 360, height: 640 }}>
        {background && <div className="cap-live cap-live-box" style={liveCaptionStyle(draft, null)}
          aria-hidden="true">
          {background.chunk
            ? <CaptionLine words={background.chunk} currentIndex={-1} style={draft} />
            : <div className="cp-line" style={{ minHeight: '1em' }} />}
        </div>}
        {chunk && <div className="cap-live cap-live-text"
          style={{ ...liveCaptionStyle(draft, null), background: 'transparent' }}>
          <CaptionLine words={chunk} currentIndex={currentWordIndex(chunk, time)} style={draft} />
        </div>}
      </div>
    </div>
  </div>
}
