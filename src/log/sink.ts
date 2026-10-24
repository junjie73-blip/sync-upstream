import type { LogConfig, LogFileLevel } from '../domain/log'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import fs from 'fs-extra'
import { DEFAULT_LOG_CONFIG } from '../domain/log'
import { redactSecrets } from './redact'

/**
 * One line waiting to be written. `level` is the console level, which is wider than the four
 * levels a file keeps — `fileRankOf` folds the extras onto the nearest one.
 */
export interface LogEntry {
  level: string
  message: string
  at?: string
  context?: Record<string, unknown>
}

const FILE_RANK: Record<LogFileLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Console levels have no file equivalent. `success` is an info line that happens to be green, and
 * `verbose`/`trace`/`perf` are debug chatter — mapping them explicitly is what keeps
 * `--log-level warn` from throwing away the sync summary.
 */
const LEVEL_ALIAS: Record<string, LogFileLevel> = {
  debug: 'debug',
  verbose: 'debug',
  trace: 'debug',
  perf: 'debug',
  info: 'info',
  success: 'info',
  step: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
}

// Built from the code point rather than written as a literal: the escape character has no business
// sitting in a source file, and `prefer-regex-literals` and `no-control-regex` cannot both be
// satisfied by any spelling of the literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function fileRankOf(level: string): number {
  return FILE_RANK[LEVEL_ALIAS[level] ?? 'info'] ?? FILE_RANK.info
}

/** The file has four levels, so a line named `verbose` in the terminal is a `debug` line on disk. */
function fileLevelOf(level: string): LogFileLevel {
  return LEVEL_ALIAS[level] ?? 'info'
}

/** Strip console colour, then scrub credentials. Exported because the delivery log shares it. */
export function scrubForFile(value: string, literals: string[] = []): string {
  return redactSecrets(value.replace(ANSI, ''), literals)
}

export interface FileSinkOptions extends Partial<LogConfig> {
  file: string
}

/**
 * Append-only log file with size-based rotation.
 *
 * Two rules shape this: writing must never break the run it is logging, and the file must never
 * grow without bound — a daemon on a CI runner that fills the disk takes the build with it. So
 * every failure comes back as a value instead of throwing, and every write checks the ceiling.
 */
export class LogFileSink {
  private readonly file: string
  private readonly minRank: number
  private readonly json: boolean
  private readonly maxBytes: number
  private readonly keep: number
  private readonly literals: string[]
  /** Bytes the file is believed to hold, which is what decides rotation. */
  private bytes = 0
  private sized = false
  private dirReady = false

  constructor(options: FileSinkOptions) {
    // Read field by field rather than spreading: a config file that says `{ file, level }` leaves
    // the rest absent, and spreading an object with explicit `undefined` values would overwrite
    // the defaults with `undefined`.
    this.file = options.file
    this.minRank = FILE_RANK[options.level ?? DEFAULT_LOG_CONFIG.level] ?? FILE_RANK.info
    this.json = options.json ?? DEFAULT_LOG_CONFIG.json
    this.maxBytes = typeof options.maxBytes === 'number' && options.maxBytes > 0 ? options.maxBytes : DEFAULT_LOG_CONFIG.maxBytes
    this.keep = typeof options.keep === 'number' && options.keep >= 0 ? options.keep : DEFAULT_LOG_CONFIG.keep
    this.literals = options.redact ?? []
  }

  get path(): string {
    return this.file
  }

  /** True when this entry belongs in the file at the configured level. */
  accepts(entry: LogEntry): boolean {
    return fileRankOf(entry.level) >= this.minRank
  }

  /**
   * Append one entry. Returns an error message when the write failed — the caller prints it to the
   * console once, because a logger that reports its own failures through itself recurses.
   */
  write(entry: LogEntry): string | undefined {
    if (!this.accepts(entry))
      return undefined
    try {
      // Inside the guard on purpose: formatting touches caller data, and a value `JSON.stringify`
      // chokes on must come back as a failure message rather than land in the middle of a sync.
      const line = this.format(entry)
      const lineBytes = Buffer.byteLength(line)
      if (!this.dirReady) {
        fs.ensureDirSync(path.dirname(this.file))
        this.dirReady = true
      }
      if (!this.sized) {
        this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
        this.sized = true
      }
      // Rotate before appending, so the live file always holds the newest line — `doctor` reads its
      // tail to answer "when did this last run", and a file left empty by a post-write rotation
      // cannot answer that until the next line happens to arrive. The one exception is a single line
      // that is already over the ceiling: it gets written rather than thrown away.
      if (this.bytes > 0 && this.bytes + lineBytes >= this.maxBytes) {
        this.rotate()
        this.bytes = 0
      }
      fs.appendFileSync(this.file, line, 'utf8')
      this.bytes += lineBytes
      return undefined
    }
    catch (error) {
      return `写入日志文件 ${this.file} 失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * Serialise context with every string value scrubbed on the way out.
   *
   * Cleaning the finished JSON text is not enough. Serialising escapes the quotes around a value, and
   * once the text reads like an escaped key followed by a colon, neither rule fires: the quoted rule
   * wants a bare quote before the colon, and the bare rule wants a word boundary the backslash used
   * to supply. Scrubbing values before serialising keeps the secret out and the line valid JSON.
   */
  private contextJson(context: Record<string, unknown>): string {
    return JSON.stringify(context, (_key, value: unknown) => typeof value === 'string'
      ? scrubForFile(value, this.literals)
      : value)
  }

  private format(entry: LogEntry): string {
    const at = entry.at ?? new Date().toISOString()
    // The file gets its own four-level name, so a log aggregator parsing `level` never sees
    // `verbose` or `fatal` and has to guess where they sit.
    const level = fileLevelOf(entry.level)
    const message = scrubForFile(entry.message, this.literals)
    const hasContext = Boolean(entry.context && Object.keys(entry.context).length > 0)
    const context = hasContext ? this.contextJson(entry.context as Record<string, unknown>) : undefined
    if (this.json) {
      // Re-parsing the already-scrubbed context keeps one JSON object per line instead of nesting an
      // escaped JSON string inside it.
      return `${JSON.stringify({ at, level, message, ...(context === undefined ? {} : { context: JSON.parse(context) as unknown }) })}\n`
    }
    return `[${at}] [${level.toUpperCase()}] ${message}${context ? ` ${context}` : ''}\n`
  }

  /**
   * `<file>` → `<file>.1`, `<file>.1` → `<file>.2`, … and the oldest slot is dropped.
   * `keep: 0` means "no history": the file goes and starts over.
   */
  private rotate(): void {
    if (this.keep <= 0) {
      fs.removeSync(this.file)
      return
    }
    fs.removeSync(`${this.file}.${this.keep}`)
    for (let index = this.keep - 1; index >= 1; index--) {
      const older = `${this.file}.${index}`
      if (fs.existsSync(older))
        fs.renameSync(older, `${this.file}.${index + 1}`)
    }
    if (fs.existsSync(this.file))
      fs.renameSync(this.file, `${this.file}.1`)
  }
}

/**
 * The last `lines` entries of a log file, newest first, plus where the file started being read.
 *
 * Reads the tail rather than the file: a log that hit its ceiling is exactly the log nobody wants
 * to load into memory to answer "when did this last run".
 */
export function readLogTail(file: string, lines = 5): { lines: string[], offset: number } | undefined {
  try {
    if (!fs.existsSync(file))
      return undefined
    const size = fs.statSync(file).size
    const offset = Math.max(0, size - 64 * 1024)
    const handle = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(size - offset)
      fs.readSync(handle, buffer, 0, buffer.length, offset)
      const all = buffer.toString('utf8').split('\n').filter(Boolean)
      // The first chunk after a mid-file offset is a partial line.
      const tail = offset > 0 ? all.slice(1) : all
      return { lines: tail.slice(-lines).reverse(), offset }
    }
    finally {
      fs.closeSync(handle)
    }
  }
  catch {
    return undefined
  }
}
