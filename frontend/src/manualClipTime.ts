export type ManualClipPayload = { title: string; start: number; end: number }

export function parseManualClipTime(input: string): number | null {
  const value = input.trim()
  const secondsOnly = value.match(/^(\d+)(?:\.(\d{1,3}))?$/)
  if (secondsOnly) {
    const seconds = Number(value)
    return Number.isFinite(seconds) ? seconds : null
  }
  const minuteTime = value.match(/^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/)
  const hourTime = value.match(/^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/)
  if (!minuteTime && !hourTime) return null
  const matched = hourTime ?? minuteTime!
  const hours = hourTime ? Number(matched[1]) : 0
  const minutes = Number(matched[hourTime ? 2 : 1])
  const seconds = Number(matched[hourTime ? 3 : 2])
  const fraction = matched[hourTime ? 4 : 3]
  const total = hours * 3600 + minutes * 60 + seconds +
    (fraction ? Number(`0.${fraction}`) : 0)
  return Number.isFinite(total) ? total : null
}

export function manualClipDuration(start: number, end: number): number {
  return Math.round((end - start) * 1000) / 1000
}

export function buildManualClipPayload(titleInput: string, startInput: string,
  endInput: string): ManualClipPayload {
  const title = titleInput.trim()
  if (!title || title.length > 200) throw new Error('Enter a title of 1–200 characters.')
  const start = parseManualClipTime(startInput)
  const end = parseManualClipTime(endInput)
  if (start === null || end === null) {
    throw new Error('Enter time as MM:SS, MM:SS.mmm, or HH:MM:SS.mmm.')
  }
  if (end <= start) throw new Error('End time must be after start time.')
  return { title, start, end }
}

export async function submitManualClipInputs<T>(title: string, start: string, end: string,
  send: (payload: ManualClipPayload) => Promise<T>): Promise<T> {
  return send(buildManualClipPayload(title, start, end))
}
