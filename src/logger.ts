import type { ConsolaInstance } from 'consola'
import type { LogConfig } from './domain/log'
import path from 'node:path'
import process from 'node:process'
import { consola } from 'consola'
import { blue, bold, cyan, gray, green, magenta, red, yellow } from 'picocolors'
import { DEFAULT_LOG_CONFIG } from './domain/log'
import { LogFileSink } from './log/sink'

// 定义日志级别
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  SUCCESS = 'success',
  WARN = 'warn',
  ERROR = 'error',
  VERBOSE = 'verbose',
  PERF = 'perf', // 性能指标日志
  TRACE = 'trace', // 详细追踪日志
}

/**
 * Console knobs only. Where the lines also go is a `LogConfig` (see `configureLogging`), because a
 * file needs a level, a format and a size ceiling the terminal does not care about.
 */
export interface LoggerConfig {
  level: LogLevel
  showTimestamp: boolean
  showLevel: boolean
}

// 默认日志配置
const DEFAULT_CONFIG: LoggerConfig = {
  level: LogLevel.INFO,
  showTimestamp: true,
  showLevel: true,
}

export class Logger {
  private consola: ConsolaInstance
  private config: LoggerConfig
  // 从最啰嗦到最安静；配置等级及其以上的日志才会输出。
  private logLevels = [
    LogLevel.TRACE,
    LogLevel.DEBUG,
    LogLevel.VERBOSE,
    LogLevel.INFO,
    LogLevel.SUCCESS,
    LogLevel.PERF,
    LogLevel.WARN,
    LogLevel.ERROR,
  ]

  private sink: LogFileSink | null = null
  /** A log file that cannot be written gets one console line, not one per log line. */
  private sinkWarned = false

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.consola = this.createConsola()
  }

  private rank(): number {
    return this.logLevels.indexOf(this.config.level)
  }

  /**
   * 控制台要不要打印这一行。落盘不受它约束：`--silent` 是不想看见输出，不是不想留下记录，否则一个
   * 安静退出的守护进程和一个从没启动的守护进程在日志里长得一模一样。文件那一边由 sink 自己的等级过滤。
   */
  private enabled(level: LogLevel): boolean {
    return this.logLevels.indexOf(level) >= this.rank()
  }

  /**
   * Write every line to a rotated file as well. `null` — the default — means console only, which is
   * what every release up to 0.2 did.
   *
   * The file is deliberately not filtered by the console level: `--silent` still has to leave a
   * trail, otherwise a daemon that died quietly is indistinguishable from one that never started.
   */
  setFileSink(sink: LogFileSink | null): void {
    this.sink = sink
    this.sinkWarned = false
  }

  /** Absolute path of the log file, or `undefined` when logging to the console only. */
  get fileSinkPath(): string | undefined {
    return this.sink?.path
  }

  /**
   * Hand a line to the sink. Colour and credentials are stripped inside it, so callers can pass
   * whatever they just printed to the terminal.
   */
  private toFile(level: LogLevel | 'step', message: string, context?: Record<string, any>): void {
    const failure = this.sink?.write({ level, message, at: new Date().toISOString(), ...(context ? { context } : {}) })
    if (!failure || this.sinkWarned)
      return
    this.sinkWarned = true
    // `process.stderr` on purpose: reporting a log-file failure through the logger recurses.
    process.stderr.write(`${gray('[LOG]')} ${failure}\n`)
  }

  // 调试日志
  debug(message: string, context?: Record<string, any>): void {
    if (this.enabled(LogLevel.DEBUG)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.debug(blue(`[DEBUG] ${message}${contextStr}`))
    }
    this.toFile(LogLevel.DEBUG, message, context)
  }

  // 详细日志
  verbose(message: string): void {
    if (this.enabled(LogLevel.VERBOSE))
      this.consola.log(gray(`[VERBOSE] ${message}`))
    this.toFile(LogLevel.VERBOSE, message)
  }

  // 追踪日志
  trace(message: string, context?: Record<string, any>): void {
    if (this.enabled(LogLevel.TRACE)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.log(gray(`[TRACE] ${message}${contextStr}`))
    }
    this.toFile(LogLevel.TRACE, message, context)
  }

  // 性能日志
  perf(operation: string, durationMs: number, context?: Record<string, any>): void {
    const message = `${operation} took ${durationMs.toFixed(2)}ms`
    if (this.enabled(LogLevel.PERF)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.log(cyan(`[PERF] ${message}${contextStr}`))
    }
    this.toFile(LogLevel.PERF, message, context)
  }

  // 设置日志级别：过滤只由 logLevels 顺序决定，consola 保持全放行
  setLevel(level: LogLevel): void {
    this.config.level = level
  }

  getLevel(): LogLevel {
    return this.config.level
  }

  // 信息日志
  info(message: string, context?: Record<string, any>): void {
    if (this.enabled(LogLevel.INFO)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.info(cyan(`[INFO] ${message}${contextStr}`))
    }
    this.toFile(LogLevel.INFO, message, context)
  }

  // 成功日志
  success(message: string, context?: Record<string, any>): void {
    if (this.enabled(LogLevel.SUCCESS)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.success(green(`[SUCCESS] ${message}${contextStr}`))
    }
    this.toFile(LogLevel.SUCCESS, message, context)
  }

  // 警告日志
  warn(message: string, context?: Record<string, any>): void {
    if (this.enabled(LogLevel.WARN)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.warn(yellow(`[WARN] ${message}${contextStr}`))
    }
    this.toFile(LogLevel.WARN, message, context)
  }

  // 错误日志
  error(message: string, error?: Error, context?: Record<string, any>): void {
    const errorMessage = error ? `${message}: ${error.message}` : message
    const contextObj = { ...(context || {}), ...(error?.stack ? { stack: error.stack } : {}) }
    const hasContext = Object.keys(contextObj).length > 0
    if (this.enabled(LogLevel.ERROR))
      this.consola.error(red(`[ERROR] ${errorMessage}${hasContext ? ` ${JSON.stringify(contextObj)}` : ''}`))
    this.toFile(LogLevel.ERROR, errorMessage, hasContext ? contextObj : undefined)
  }

  // 步骤日志（用于显示同步过程中的主要步骤）
  step(stepNumber: number, message: string): void {
    if (this.enabled(LogLevel.INFO))
      this.consola.log(bold(magenta(`\n${stepNumber}. ${message}`)))
    this.toFile('step', `Step ${stepNumber}: ${message}`)
  }

  // 更新配置
  updateConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config }
    this.consola = this.createConsola()
  }

  private createConsola(): ConsolaInstance {
    return consola.create({
      // 过滤全部由 logLevels 决定，这里只保证 consola 自身不会二次拦截。
      level: Number.MAX_SAFE_INTEGER,
      formatOptions: {
        colors: true,
        date: this.config.showTimestamp,
      },
    })
  }
}

// 创建默认 logger 实例
export const logger = new Logger()

/**
 * Build the file sink a config describes, or `null` when it asks for console-only logging.
 * Relative paths resolve against `cwd` (the repository root in practice).
 */
export function loggingSink(config: LogConfig | undefined, options: { secrets?: (string | undefined)[], cwd?: string } = {}): LogFileSink | null {
  const file = config?.file?.trim()
  if (!file)
    return null
  const redact = [...(config?.redact ?? []), ...(options.secrets ?? [])].filter((item): item is string => typeof item === 'string' && item.length > 0)
  return new LogFileSink({
    ...DEFAULT_LOG_CONFIG,
    ...config,
    file: path.isAbsolute(file) ? file : path.resolve(options.cwd ?? process.cwd(), file),
    redact,
  })
}

/**
 * Point the shared logger at a file, from either the config file or the command line.
 *
 * Colour and credentials are stripped on the way in, so what reaches the file is something it is
 * safe to commit, paste into an issue, or ship to a log aggregator.
 */
export function configureLogging(config: LogConfig | undefined, options: { secrets?: (string | undefined)[], cwd?: string } = {}): string | undefined {
  const sink = loggingSink(config, options)
  logger.setFileSink(sink)
  return sink?.path
}
