import type { ClipGroup } from '../clipProvenance'
import type { Clip, Sermon } from '../types'
import { ClipMediaCard } from './ClipMediaCard'
import type { ClipAction } from './ClipMediaCard'

export function ClipGroupGrid({ sermon, group, onPreview, onEdit, statusFor }: {
  sermon: Sermon; group: ClipGroup<Clip>; onPreview: ClipAction; onEdit: ClipAction
  statusFor?: (index: number) => string | undefined
}) {
  const first = group.batches[0]?.clips[0]?.clip
  const isPrompt = first?.selection_method === 'ai_chat' && !!first.selection_prompt_name
  return <section className="media-prompt-group">
    <div className="media-group-heading">
      <div><h3>{group.label}</h3><p>{isPrompt ? `Selected with ${group.label}` : group.label}
        {' · '}{group.count} {group.count === 1 ? 'clip' : 'clips'}</p></div>
      <span className="media-source-pill">{isPrompt ? 'Prompt' : 'Source'}</span>
    </div>
    {group.batches.map((batch, batchIndex) => <div key={batch.key} className="media-batch">
      {(group.batches.length > 1 || batch.selectedAt) && <p className="muted small media-batch-label">
        {batch.selectedAt && Number.isFinite(Date.parse(batch.selectedAt))
          ? `Selected ${new Date(batch.selectedAt).toLocaleString()}`
          : batch.batchId ? `Selection run ${batchIndex + 1}` : 'Run not recorded'}
      </p>}
      <div className="media-card-grid">{batch.clips.map(({ clip, index }) =>
        <ClipMediaCard key={`${clip.id}-${index}-${clip.start}-${clip.end}`} sermon={sermon} clip={clip} index={index}
          onPreview={onPreview} onEdit={onEdit} status={statusFor?.(index)} />)}</div>
    </div>)}
  </section>
}
