import { presentationLabel, thumbnailStyle } from '../captionStyles'
import type { CaptionStyle } from '../types'

type Props = {
  styles: CaptionStyle[]
  value: string
  onChange: (key: string) => void
}

/** A compact gallery driven by the same style descriptors as preview and export. */
export function CaptionStylePicker({ styles, value, onChange }: Props) {
  const groups = [
    { title: 'Built-in', items: styles.filter(style => style.built_in) },
    { title: 'Custom', items: styles.filter(style => !style.built_in) },
  ]
  return <div className="cs-gallery">
    {groups.map(group => <section className="cs-gallery-group" key={group.title}>
      <div className="cs-gallery-heading">{group.title} <span>{group.items.length}</span></div>
      {group.items.length ? <div className="cs-gallery-grid">
        {group.items.map(style => <button
          key={style.key}
          type="button"
          className={`cs-card ${value === style.key ? 'selected' : ''}`}
          aria-pressed={value === style.key}
          onClick={() => onChange(style.key)}
        >
          <CaptionPreview style={style} />
          <span className="cs-card-meta">
            <strong>{style.label}</strong>
            <small>{presentationLabel(style.presentation_mode)}{style.revision == null ? '' : ` · r${style.revision}`}</small>
          </span>
        </button>)}
      </div> : <p className="muted small">No custom styles saved yet.</p>}
    </section>)}
  </div>
}

function CaptionPreview({ style }: { style: CaptionStyle }) {
  const singleWord = style.presentation_mode === 'single_word'
  return <span className="cp" style={thumbnailStyle(style, false)} aria-hidden="true">
    <span className={`cp-frame${singleWord ? ' single-word' : ''}`}>
      {style.background_box && <span className="cp-box" />}
      {singleWord ? <span className="cp-word-pop">
        <span className="cp-word w1">HELLO</span>
        <span className="cp-word w2">FRIENDS</span>
        <span className="cp-word w3">PREVIEW</span>
      </span> : <span className={`cp-line ${style.presentation_mode === 'progressive_chunk' ? 'progressive' : ''}`}>
        <span className="cp-word w1">This</span>{' '}
        <span className="cp-word w2">is</span>{' '}
        <span className="cp-word w3">possible</span>
      </span>}
    </span>
  </span>
}
