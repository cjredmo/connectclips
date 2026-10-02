type TimedWord = { start: number }

export function currentWordIndex(words: TimedWord[], time: number): number {
  let index = 0
  for (let i = 0; i < words.length; i++) {
    if (time >= words[i].start) index = i
  }
  return index
}

export function captionWordState(
  index: number, currentIndex: number,
  mode: 'single_word' | 'progressive_chunk' | 'full_chunk_highlight' = 'progressive_chunk',
): 'spoken' | 'current' | 'future' {
  if (index < currentIndex) return 'spoken'
  if (index > currentIndex) return mode === 'full_chunk_highlight' ? 'spoken' : 'future'
  return 'current'
}
