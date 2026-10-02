export function adjacentClip(index: number, count: number, direction: -1 | 1): number | null {
  const next = index + direction
  return next >= 0 && next < count ? next : null
}

export function clipEditorKey(sermonName: string, clipIndex: number): string {
  return `${sermonName}:${clipIndex}`
}

/** Do not change the app view until the editor's latest write succeeds. */
export async function afterClipSave(
  flush: () => Promise<void>, proceed: () => void | Promise<void>,
): Promise<void> {
  await flush()
  await proceed()
}
