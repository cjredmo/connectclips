import { captionWordState } from '../captionReveal'
import type { CaptionStyle } from '../types'

/** Shared word visibility and highlight markup for the source and style previews. */
export function CaptionLine({ words, currentIndex, style }: {
  words: { text: string }[]; currentIndex: number; style: CaptionStyle
}) {
  return <div className="cp-line">
    {words.map((word, index) => <span key={index}
      className={`cp-word ${captionWordState(index, currentIndex, style.presentation_mode)}`}>
      {word.text}{index < words.length - 1 ? ' ' : ''}
    </span>)}
  </div>
}
