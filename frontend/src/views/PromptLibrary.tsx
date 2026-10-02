import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { assemblePrompt, canEditPrompt, confirmPromptDeletion,
  nextCopyName, promptDraft, selectedPrompt } from '../clipPrompts'
import type { PromptDraft, PromptLibraryResponse } from '../clipPrompts'
import { clearPendingSelection, copyAndStartSelection } from '../clipSelectionSession'
import type { PendingAiSelection } from '../clipSelectionSession'

const SELECTION_KEY = 'connectclips.selectedClipPrompt'

function savedSelection(): string | null {
  try { return window.localStorage.getItem(SELECTION_KEY) }
  catch { return null }
}

type Props = { source: string; pending: PendingAiSelection | null;
  onPendingChange: (pending: PendingAiSelection | null) => void; onImportResults: () => void }

export function PromptLibrary({ source, pending, onPendingChange, onImportResults }: Props) {
  const [library, setLibrary] = useState<PromptLibraryResponse | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(savedSelection)
  const [editor, setEditor] = useState<PromptDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }, [])
  useEffect(() => {
    let active = true
    api.clipPrompts().then(value => { if (active) setLibrary(value) })
      .catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [])

  const selected = library ? selectedPrompt(library, selectedId) : null
  const select = (id: string) => {
    setSelectedId(id)
    setEditor(null)
    setError(null)
    try { window.localStorage.setItem(SELECTION_KEY, id) } catch { /* preference is optional */ }
  }
  const reload = async (id?: string) => {
    setLibrary(await api.clipPrompts())
    if (id) select(id)
  }
  const duplicate = async () => {
    if (!selected || !library) return
    setBusy(true)
    setError(null)
    try {
      const created = await api.duplicateClipPrompt(selected.id, nextCopyName(library, selected))
      await reload(created.id)
      setEditor(promptDraft(created))
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const save = async () => {
    if (!editor) return
    setBusy(true)
    setError(null)
    try {
      const saved = editor.id && editor.revision !== null ?
        await api.updateClipPrompt(editor.id, editor.name, editor.description,
          editor.selection_focus, editor.revision) :
        await api.createClipPrompt(editor.name, editor.description, editor.selection_focus)
      await reload(saved.id)
      setEditor(null)
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!selected || !confirmPromptDeletion(selected, message => window.confirm(message))) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteClipPrompt(selected.id)
      await reload(library?.default)
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const copy = async () => {
    if (!selected || !library) return
    setCopying(true)
    setCopied(false)
    setError(null)
    try {
      const transcript = await api.getTranscript(source)
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable. Use a secure browser context and allow clipboard access.')
      }
      const session = await copyAndStartSelection(library, selected, transcript, source,
        text => navigator.clipboard.writeText(text), window.localStorage,
        crypto.randomUUID(), new Date().toISOString())
      onPendingChange(session)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch (e) { setError(`Could not copy prompt and transcript: ${String(e)}`) }
    finally { setCopying(false) }
  }
  const clearPending = () => {
    try {
      clearPendingSelection(window.localStorage, source)
      onPendingChange(null)
    } catch (e) { setError(`Could not clear pending selection: ${String(e)}`) }
  }

  return <section className="clip-prompt-library" aria-label="AI Chat prompt library">
    <h3>AI Chat · Prompt Library</h3>
    <p className="muted small">Choose a selection focus, copy the complete prompt with the timestamped transcript, paste it into your AI chat, then import the results.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!library && !error && <p className="muted">Loading prompts…</p>}
    {library && selected && <>
      {pending && <div className="clip-pending-selection" role="status">
        <strong>Pending AI Chat selection · {pending.selection_prompt_name}</strong>
        <span className="muted small">Copied {new Date(pending.selection_created_at).toLocaleString()}</span>
        <span className="muted small">Copying another prompt replaces this pending session.</span>
        <div className="action-row">
          <button type="button" onClick={onImportResults}>Import results</button>
          <button type="button" className="secondary" onClick={clearPending}>Clear</button>
        </div>
      </div>}
      <label>Choose prompt
        <select value={selected.id} onChange={event => select(event.target.value)}>
          <optgroup label="Built-in prompts">
            {library.prompts.filter(prompt => prompt.built_in).map(prompt =>
              <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}
          </optgroup>
          {library.prompts.some(prompt => !prompt.built_in) && <optgroup label="Custom prompts">
            {library.prompts.filter(prompt => !prompt.built_in).map(prompt =>
              <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}
          </optgroup>}
        </select>
      </label>
      {selected.description && <p className="muted small">{selected.description}</p>}
      <label>Selection instructions
        <textarea value={selected.selection_focus} readOnly rows={5} />
      </label>
      <details>
        <summary>Preview full prompt</summary>
        <textarea aria-label="Full prompt preview" value={assemblePrompt(library, selected.selection_focus)}
          readOnly rows={18} />
      </details>
      <div className="action-row">
        <button type="button" onClick={copy} disabled={copying || busy || !!editor}>
          {copying ? 'Copying…' : 'Copy Prompt + Transcript'}
        </button>
        {copied && <span role="status" className="muted small">Copied</span>}
        <button type="button" className="secondary" onClick={() => setEditor(promptDraft())} disabled={busy}>New custom</button>
        <button type="button" className="secondary" onClick={duplicate} disabled={busy}>Duplicate / Customize</button>
        {canEditPrompt(selected) && <>
          <button type="button" className="secondary" onClick={() => setEditor(promptDraft(selected))} disabled={busy}>Edit</button>
          <button type="button" className="danger" onClick={remove} disabled={busy}>Delete</button>
        </>}
      </div>
      {editor && <div className="clip-prompt-editor">
        <h4>{editor.id ? 'Edit custom prompt' : 'New custom prompt'}</h4>
        <label>Name<input value={editor.name} maxLength={80}
          onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
        <label>Description<input value={editor.description} maxLength={240}
          onChange={event => setEditor({ ...editor, description: event.target.value })} /></label>
        <label>Selection instructions<textarea value={editor.selection_focus} rows={8}
          onChange={event => setEditor({ ...editor, selection_focus: event.target.value })} /></label>
        <div className="action-row">
          <button type="button" onClick={save} disabled={busy || !editor.name.trim() || !editor.selection_focus.trim()}>
            {busy ? 'Saving…' : 'Save prompt'}
          </button>
          <button type="button" className="secondary" onClick={() => setEditor(null)} disabled={busy}>Cancel</button>
        </div>
      </div>}
    </>}
  </section>
}
