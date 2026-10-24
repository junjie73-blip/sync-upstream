import path from 'node:path'
import fs from 'fs-extra'

/**
 * Bounded set of provider delivery ids, optionally kept in a file.
 *
 * Providers redeliver when they time out, and the daemon answers 202 before the sync finishes — so
 * a redelivery that arrives while the first sync is still running is normal, and a redelivery that
 * arrives after a restart is the one an in-memory set cannot see. The file is what makes the second
 * one cost nothing. Insertion order is kept so the ceiling drops the oldest id, not an arbitrary one.
 */
export class SeenStore {
  private readonly ids = new Set<string>()
  private readonly order: string[] = []
  /** Last write failure, so the caller can report it once instead of throwing at a delivery. */
  private failure?: string

  constructor(private readonly limit = 512, private readonly file?: string) {
    this.load()
  }

  get size(): number {
    return this.ids.size
  }

  get lastError(): string | undefined {
    return this.failure
  }

  /** True when this id was already recorded; records it otherwise. */
  mark(id: string): boolean {
    if (this.ids.has(id))
      return true
    this.ids.add(id)
    this.order.push(id)
    while (this.order.length > this.limit) {
      const oldest = this.order.shift()
      if (oldest !== undefined)
        this.ids.delete(oldest)
    }
    this.save()
    return false
  }

  private load(): void {
    if (!this.file)
      return
    try {
      if (!fs.existsSync(this.file))
        return
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { ids?: unknown }
      const list = Array.isArray(parsed.ids) ? parsed.ids.filter((item): item is string => typeof item === 'string') : []
      for (const id of list.slice(-this.limit)) {
        if (!this.ids.has(id)) {
          this.ids.add(id)
          this.order.push(id)
        }
      }
    }
    catch {
      // A corrupt file means "remember nothing", which costs a duplicate sync at worst and is
      // better than refusing to start.
      this.ids.clear()
      this.order.length = 0
    }
  }

  private save(): void {
    if (!this.file)
      return
    try {
      fs.ensureDirSync(path.dirname(this.file))
      fs.writeFileSync(this.file, `${JSON.stringify({ ids: this.order })}\n`, 'utf8')
      this.failure = undefined
    }
    catch (error) {
      this.failure = `写入投递去重状态 ${this.file} 失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
