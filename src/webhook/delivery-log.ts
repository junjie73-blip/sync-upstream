import type { WebhookPlatform } from '../domain/webhook'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import fs from 'fs-extra'
import { scrubForFile } from '../log/sink'

/**
 * What the daemon decided about one delivery.
 *
 * `accepted` means a sync was started, not that it finished — the outcome arrives later as its own
 * line, because the answer to the platform has to go out before the sync does.
 */
export type DeliveryDecision = 'accepted' | 'ignored' | 'rejected' | 'synced' | 'failed'

export interface DeliveryRecord {
  at?: string
  decision: DeliveryDecision
  /** HTTP status the daemon answered with, so a redelivery can be matched to the response. */
  status?: number
  platform?: WebhookPlatform
  event?: string
  branch?: string
  deliveryId?: string
  /** Why, in the operator's terms: `签名校验失败`, `分支不匹配`, `重复投递`, `同步失败: …`. */
  reason?: string
  /** How long the sync took, on the line that reports its outcome. */
  durationMs?: number
  /** Normalised client address — no port, and only ever recorded, never used to decide. */
  ip?: string
}

/** Newest-first tail of the audit file, for `doctor` and `status`. */
export interface DeliveryTail {
  total: number
  records: DeliveryRecord[]
}

/**
 * Scrub one text field, keeping its type.
 *
 * The audit line is cleaned field by field rather than after `JSON.stringify`: serialising first
 * turns `"` into `\"` and a colour escape into `\u001b`, at which point the escape is no longer a
 * control character the stripper can see, and a key that ends up glued to a word character (`m` in
 * `[31m`) loses the `\b` boundary the key patterns rely on. Both leak.
 */
function scrubField<T extends string | undefined>(value: T, literals: string[]): T {
  return (value === undefined ? undefined : scrubForFile(value, literals)) as T
}

/**
 * Append-only JSONL audit trail of delivery decisions.
 *
 * The signature check proves a delivery came from the platform; it does not answer the question
 * somebody asks at 3am — "did my push at 14:02 trigger a sync, and what did the daemon do about
 * it". Writing must never break the delivery it is describing, so every failure is swallowed and
 * reported through the return value instead.
 */
export class DeliveryLog {
  constructor(private readonly file: string, private readonly literals: string[] = []) {}

  get path(): string {
    return this.file
  }

  /** Append one record. Returns an error message when the write failed; never throws. */
  record(entry: DeliveryRecord): string | undefined {
    // The payload itself is never logged: a push event carries commit messages, author emails and
    // sometimes secrets. Only the fields above, which describe the shape of the delivery.
    const record: DeliveryRecord = {
      ...entry,
      at: scrubField(entry.at, this.literals) ?? new Date().toISOString(),
      platform: scrubField(entry.platform, this.literals),
      event: scrubField(entry.event, this.literals),
      branch: scrubField(entry.branch, this.literals),
      deliveryId: scrubField(entry.deliveryId, this.literals),
      reason: scrubField(entry.reason, this.literals),
      ip: scrubField(entry.ip, this.literals),
    }
    const line = JSON.stringify(record)
    try {
      fs.ensureDirSync(path.dirname(this.file))
      // A previous write killed mid-line leaves no newline behind, and appending straight onto that
      // would glue the new record to the fragment — losing two records where one was already lost.
      fs.appendFileSync(this.file, `${this.needsBreak() ? '\n' : ''}${line}\n`, 'utf8')
      return undefined
    }
    catch (error) {
      return `写入投递审计 ${this.file} 失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** True when the file exists but does not end on a line break. */
  private needsBreak(): boolean {
    if (!fs.existsSync(this.file))
      return false
    const size = fs.statSync(this.file).size
    if (size === 0)
      return false
    const handle = fs.openSync(this.file, 'r')
    try {
      const last = Buffer.alloc(1)
      fs.readSync(handle, last, 0, 1, size - 1)
      return last.toString('utf8') !== '\n'
    }
    finally {
      fs.closeSync(handle)
    }
  }
}

/**
 * Read the last `limit` records, newest first.
 *
 * Unparseable lines are skipped rather than failing the read: a half-written line from a killed
 * process is exactly what a post-mortem finds in a log file.
 */
export function readDeliveryLog(file: string, limit = 10): DeliveryTail {
  const empty: DeliveryTail = { total: 0, records: [] }
  try {
    if (!fs.existsSync(file))
      return empty
    const records = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line: string) => {
        try {
          return JSON.parse(line) as DeliveryRecord
        }
        catch {
          return undefined
        }
      })
      .filter((record): record is DeliveryRecord => record !== undefined && typeof record.decision === 'string')
    return { total: records.length, records: records.slice(-limit).reverse() }
  }
  catch {
    return empty
  }
}

/** Count of each decision, oldest-to-newest order preserved in `records`. */
export function summariseDeliveries(records: DeliveryRecord[]): Record<DeliveryDecision, number> {
  const counts: Record<DeliveryDecision, number> = { accepted: 0, ignored: 0, rejected: 0, synced: 0, failed: 0 }
  for (const record of records) {
    if (record.decision in counts)
      counts[record.decision] += 1
  }
  return counts
}
