import type { GrayReleaseAlertThresholds } from '../domain'
import { logger } from '../logger'

export interface GraySample {
  elapsedMs: number
  released: number
  failed: number
}

export type GrayAlert = (message: string) => void

/**
 * Elapsed-time / error-rate watchdog for a gray release. The timer is unref'd and stopped
 * explicitly: the previous implementation started one inside a constructor and never
 * cleared it, which kept the process alive after the release finished.
 */
export class GrayMonitor {
  private timer: NodeJS.Timeout | null = null
  private readonly thresholds: GrayReleaseAlertThresholds
  private readonly intervalMs: number
  private samples: GraySample[] = []

  constructor(
    thresholds: GrayReleaseAlertThresholds = {},
    intervalMs = 5000,
    private readonly alert: GrayAlert = message => logger.warn(`[灰度告警] ${message}`),
  ) {
    this.thresholds = thresholds
    this.intervalMs = Math.max(500, intervalMs)
  }

  get watched(): number {
    return this.samples.length
  }

  start(sample: () => GraySample): void {
    if (this.timer)
      return
    this.timer = setInterval(() => {
      const current = sample()
      this.samples.push(current)
      this.check(current)
    }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (!this.timer)
      return
    clearInterval(this.timer)
    this.timer.unref()
    this.timer = null
  }

  private check(sample: GraySample): void {
    const { maxExecutionTime, errorRate } = this.thresholds
    const total = sample.released + sample.failed

    if (maxExecutionTime && sample.elapsedMs > maxExecutionTime * 1000) {
      this.alert(`执行时长 ${Math.round(sample.elapsedMs / 1000)}s 超过阈值 ${maxExecutionTime}s`)
    }
    if (errorRate && total > 0) {
      const rate = (sample.failed / total) * 100
      if (rate > errorRate)
        this.alert(`错误率 ${rate.toFixed(1)}% 超过阈值 ${errorRate}%`)
    }
  }
}
