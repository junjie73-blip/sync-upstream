/**
 * Writing the log somewhere besides the terminal.
 *
 * A CLI that exits after one sync can get away with stdout, and that is the default. The daemon
 * modes cannot: a `sync-upstream --webhook` process that dies at 3am leaves nothing behind unless
 * its lines went to a file somebody can read, and a CI job that reuses the same runner needs that
 * file to stop growing. These knobs cover both, and nothing else — the log is a plain append-only
 * file that gets rotated, not a log framework.
 */

/**
 * Levels a file is worth keeping. `success`/`verbose`/`perf`/`trace` are console flourishes;
 * a machine-parsed file gets the four that mean something three months later.
 */
export type LogFileLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_FILE_LEVELS: LogFileLevel[] = ['debug', 'info', 'warn', 'error']

export interface LogConfig {
  /**
   * Append every log line here too. Absent means "terminal only", which is what every release
   * before 0.3 did. Relative paths are resolved against the current working directory.
   */
  file?: string
  /**
   * Only lines at this level or louder reach the file. Default `info`: a debug line in a
   * long-lived daemon file is how the file stops being readable.
   */
  level?: LogFileLevel
  /**
   * One JSON object per line instead of `[时间] [级别] 文本`. `json` costs nothing to grep with
   * `jq` and is what a log shipper wants; `text` is what a person wants.
   */
  json?: boolean
  /** Rotate once the file passes this many bytes. Default 5 MiB. */
  maxBytes?: number
  /** How many rotated files to keep — `<file>.1` is the newest. Default 5; `0` deletes instead of rotating. */
  keep?: number
  /**
   * Literal strings that must never appear in the file, on top of the automatic scrubbing
   * (URL credentials, `token=`/`Bearer …`). The webhook secret is added by the caller.
   */
  redact?: string[]
}

/**
 * Every knob except `file`, which is what turns file logging on at all — a config that sets
 * nothing else still gets these.
 */
export const DEFAULT_LOG_CONFIG: Required<Omit<LogConfig, 'file'>> = {
  level: 'info',
  json: false,
  maxBytes: 5 * 1024 * 1024,
  keep: 5,
  redact: [],
}
