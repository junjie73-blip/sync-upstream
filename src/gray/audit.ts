import fs from 'fs-extra'
import { logger } from '../logger'

export interface GrayAuditEntry {
  releaseId: string
  stage: string
  detail: string
  at: string
}

/**
 * Append-only JSONL audit trail for stage transitions. Writing the log must never break a
 * release, so every failure is reduced to a warning.
 */
export class GrayAudit {
  constructor(private readonly filePath: string) {}

  async append(entry: Omit<GrayAuditEntry, 'at'>): Promise<void> {
    const line = JSON.stringify({ ...entry, at: new Date().toISOString() })
    try {
      await fs.appendFile(this.filePath, `${line}\n`, 'utf8')
    }
    catch {
      logger.warn(`灰度审计日志写入失败: ${this.filePath}`)
    }
  }

  async read(): Promise<GrayAuditEntry[]> {
    try {
      if (!(await fs.pathExists(this.filePath)))
        return []
      const raw = await fs.readFile(this.filePath, 'utf8')
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line: string) => JSON.parse(line) as GrayAuditEntry)
    }
    catch {
      return []
    }
  }
}
