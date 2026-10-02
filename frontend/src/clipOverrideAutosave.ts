import type { ClipUserEdits } from './types'

export type OverrideSaveStatus = 'idle' | 'saving' | 'saved' | 'failed'

/** Serializes clip writes and keeps the newest unsaved draft available to flush. */
export class ClipOverrideAutosave {
  private timer: ReturnType<typeof setTimeout> | null = null
  private active: Promise<void> | null = null
  private latest: ClipUserEdits
  private version = 0
  private savedVersion = 0
  private status: OverrideSaveStatus = 'idle'
  private readonly write: (edits: ClipUserEdits) => Promise<unknown>
  private readonly onStatus: (status: OverrideSaveStatus) => void
  private readonly delay: number

  constructor(
    initial: ClipUserEdits,
    write: (edits: ClipUserEdits) => Promise<unknown>,
    onStatus: (status: OverrideSaveStatus) => void,
    delay = 500,
  ) {
    this.latest = { ...initial }
    this.write = write
    this.onStatus = onStatus
    this.delay = delay
  }

  private report(status: OverrideSaveStatus) {
    if (this.status !== status) {
      this.status = status
      this.onStatus(status)
    }
  }

  schedule(edits: ClipUserEdits): void {
    if (JSON.stringify(edits) === JSON.stringify(this.latest)) return
    this.latest = { ...edits }
    this.version += 1
    this.report('saving')
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush().catch(() => {}) }, this.delay)
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.active) return this.active
    if (this.savedVersion === this.version) return Promise.resolve()
    const run = (async () => {
      while (this.savedVersion < this.version) {
        const target = this.version
        const payload = { ...this.latest }
        this.report('saving')
        try {
          await this.write(payload)
        } catch (error) {
          this.report('failed')
          throw error
        }
        this.savedVersion = target
        if (this.savedVersion === this.version) this.report('saved')
      }
    })()
    const active = run.finally(() => { if (this.active === active) this.active = null })
    this.active = active
    return active
  }

  saveNow(edits: ClipUserEdits): Promise<void> {
    this.schedule(edits)
    return this.flush()
  }

  /** Call only after a separate successful persistence operation, such as reset. */
  markClean(edits: ClipUserEdits): void {
    if (this.active) throw new Error('cannot replace clip edits during a save')
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.latest = { ...edits }
    this.version += 1
    this.savedVersion = this.version
    this.report('saved')
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
