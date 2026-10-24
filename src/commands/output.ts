import type { CommandReport } from './types'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { toError } from '../errors'

/** Wrap a payload with the fields every subcommand shares. */
export function toReport<T>(
  command: CommandReport<T>['command'],
  data: T,
  options: { ok?: boolean, exitCode?: number, warnings?: string[], summary?: string } = {},
): CommandReport<T> {
  const warnings = options.warnings ?? []
  const ok = options.ok ?? true
  return {
    command,
    ok,
    exitCode: options.exitCode ?? (ok ? 0 : 1),
    generatedAt: new Date().toISOString(),
    data,
    warnings,
    ...(options.summary ? { summary: options.summary } : {}),
  }
}

/**
 * Machine mode prints exactly one JSON document on stdout — no logs, no colors — so CI can
 * pipe it straight into `jq`. Human mode prints the pre-rendered lines.
 */
export function emit<T>(report: CommandReport<T>, lines: string[], json: boolean): void {
  if (json) {
    process.stdout.write(`${stripAnsi(JSON.stringify(report, null, 2))}\n`)
    return
  }
  for (const line of lines) process.stdout.write(`${line}\n`)
}

/**
 * `data` fields double as human lines, so they can carry picocolors escapes in a terminal.
 * Both spellings have to go: the real control character when it survives, and the literal
 * text `\u001b[33m` that `JSON.stringify` turns it into — otherwise the document is either
 * unparseable by `jq` or full of escapes.
 */
// The control character here is the point: it is what picocolors emits.
// eslint-disable-next-line no-control-regex
const ANSI_REAL = /\u001B\[[0-9;]*m/g
const ANSI_ESCAPED = /\\u001b\[[0-9;]*m/g

export function stripAnsi(value: string): string {
  return value.replace(ANSI_REAL, '').replace(ANSI_ESCAPED, '')
}

/** Write markdown to `$GITHUB_STEP_SUMMARY`; returns a warning string when it failed. */
export async function appendCiSummary(markdown: string): Promise<string | undefined> {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (!target)
    return undefined
  try {
    await fs.ensureDir(path.dirname(target))
    await fs.appendFile(target, `${markdown}\n`, 'utf8')
    return undefined
  }
  catch (error) {
    return `GITHUB_STEP_SUMMARY 写入失败: ${toError(error).message}`
  }
}
