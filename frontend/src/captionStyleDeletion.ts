type References = { current_clip: boolean; other_clips: number }

type DeleteOperations = {
  flushCurrentClip: () => Promise<void>
  persistCurrentClip: (styleKey: string) => Promise<void>
  references: () => Promise<References>
  selectDefault: () => void
  remove: () => Promise<void>
  refresh: () => Promise<void>
}

/** Persist replacement before delete; the backend remains the final reference guard. */
export async function deleteClipCaptionStyle(
  deletedKey: string, currentKey: string, defaultKey: string, operations: DeleteOperations,
): Promise<void> {
  // Flush only a pending edit before checking references. An unused preset
  // must not create an unrelated override on the clip being viewed.
  await operations.flushCurrentClip()
  const references = await operations.references()
  if (references.other_clips > 0) {
    const count = references.other_clips
    throw new Error(`This preset is still used by ${count} other clip${count === 1 ? '' : 's'}. Change those clips to another preset before deleting it.`)
  }
  if (references.current_clip) await operations.persistCurrentClip(defaultKey)
  if (currentKey === deletedKey) operations.selectDefault()
  await operations.remove()
  await operations.refresh()
}
