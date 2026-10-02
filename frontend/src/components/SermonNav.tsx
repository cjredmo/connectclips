import { SERMON_SECTIONS } from '../sermonWorkspace'
import type { SermonSection } from '../sermonWorkspace'

type Props = { active: SermonSection; onChange: (section: SermonSection) => void }

export function SermonNav({ active, onChange }: Props) {
  return (
    <nav className="sermon-nav" aria-label="Sermon workspace">
      {SERMON_SECTIONS.map(section => (
        <button key={section} type="button"
          className={`sermon-nav-link${active === section ? ' is-active' : ''}`}
          aria-current={active === section ? 'page' : undefined}
          onClick={() => onChange(section)}>
          {section[0].toUpperCase() + section.slice(1)}
        </button>
      ))}
    </nav>
  )
}
