import type { Buffer } from 'node:buffer'
import type { GrayReleaseConfig } from '../domain'
import { spawn } from 'node:child_process'
import { toError, ValidationError } from '../errors'
import { logger } from '../logger'

export interface ValidationResult {
  ok: boolean
  attempts: number
  durationMs: number
  /** Last script output, trimmed; never longer than OUTPUT_LIMIT characters. */
  output: string
  error?: string
}

const OUTPUT_LIMIT = 4000
const DEFAULT_TIMEOUT_MS = 120_000

interface RunResult {
  ok: boolean
  output: string
  error?: string
}

/** Run the validation command once, with a hard timeout so a hanging script cannot wedge a release. */
function runOnce(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true })
    let output = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (result: RunResult) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, output: trim(output), error: `验证脚本超时（${timeoutMs}ms）` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', error => finish({ ok: false, output: trim(output), error: toError(error).message }))
    child.on('close', code => finish({ ok: code === 0, output: trim(output), error: code === 0 ? undefined : `退出码 ${code}` }))
  })
}

function trim(value: string): string {
  return value.length > OUTPUT_LIMIT ? `${value.slice(0, OUTPUT_LIMIT)}…` : value
}

/**
 * Execute `validationScript` with retries. A missing command name is a configuration error;
 * a failing script is a release outcome, so it is reported rather than thrown.
 */
export async function validateRelease(
  config: GrayReleaseConfig,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ValidationResult> {
  const command = config.validationScript?.trim()
  if (!command)
    throw new ValidationError('启用灰度发布校验时 validationScript 不能为空')

  const attempts = Math.max(0, config.maxRetries ?? 0) + 1
  const startedAt = Date.now()
  let last: RunResult = { ok: false, output: '', error: '未执行' }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await runOnce(command, cwd, timeoutMs)
    if (last.ok) {
      return { ok: true, attempts: attempt, durationMs: Date.now() - startedAt, output: last.output }
    }
    logger.warn(`灰度校验第 ${attempt}/${attempts} 次失败: ${last.error ?? '未知原因'}`)
  }

  return {
    ok: false,
    attempts,
    durationMs: Date.now() - startedAt,
    output: last.output,
    error: last.error,
  }
}
