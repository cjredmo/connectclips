import { useEffect, useRef, useState } from 'react'
import { captionPresentation, thumbnailStyle } from '../captionStyles'
import type { CaptionStyle } from '../types'

type Props = {
  styles: CaptionStyle[]
  value: string
  onChange: (key: string) => void
}

/** Dropdown thumbnails use the same descriptors as LivePreview and ASS. */
export function CaptionStylePicker({ styles, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = styles.find((s) => s.key === value)

  return (
    <div className="cs-picker" ref={wrapRef}>
      <button
        type="button"
        className="cs-trigger"
        onClick={() => setOpen((o) => !o)}
        title={selected?.label}
      >
        {selected && <CaptionPreview style={selected} small />}
        <span className="cs-trigger-label">{selected
          ? `${selected.label}${selected.revision == null ? '' : ` · r${selected.revision}`}`
          : `Missing style: ${value}`}</span>
        <span className="cs-caret">▼</span>
      </button>
      {open && (
        <div className="cs-popover" role="listbox">
          {styles.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`cs-option ${s.key === value ? 'selected' : ''}`}
              onClick={() => { onChange(s.key); setOpen(false) }}
              role="option"
              aria-selected={s.key === value}
            >
              <CaptionPreview style={s} />
              <div className="cs-option-label">{s.label}{s.revision == null ? '' : ` · r${s.revision}`}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A short animated mock of single-word or progressive-chunk presentation. */
function CaptionPreview({ style, small = false }: { style: CaptionStyle; small?: boolean }) {
  const singleWord = captionPresentation(style) === 'single_word'
  return (
    <div className={`cp ${small ? 'cp-small' : ''}`} style={thumbnailStyle(style, small)}>
      <div className={`cp-frame${singleWord ? ' single-word' : ''}`}>
        {style.background_box && <div className="cp-box" />}
        {singleWord ? (
          <div className="cp-word-pop">
            <span className="cp-word w1">HELLO</span>
            <span className="cp-word w2">FRIENDS</span>
            <span className="cp-word w3">PREVIEW</span>
          </div>
        ) : (
          <div className="cp-line">
            <span className="cp-word w1">Hello</span>
            {' '}<span className="cp-word w2">there</span>
            {' '}<span className="cp-word w3">preview</span>
          </div>
        )}
      </div>
    </div>
  )
}
