import type { ConsolaInstance } from 'consola'
import path from 'node:path'
import process from 'node:process'
import { consola } from 'consola'
import dayjs from 'dayjs'
import fs from 'fs-extra'
import { blue, bold, cyan, gray, green, magenta, red, yellow } from 'picocolors'
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

// 日志配置接口
export interface LoggerConfig {
  level: LogLevel
  logToFile: boolean
  logFilePath: string
  showTimestamp: boolean
  showLevel: boolean
  structedLogging: boolean
  perfMetricsEnabled: boolean
  traceEnabled: boolean
}

// 默认日志配置
const DEFAULT_CONFIG: LoggerConfig = {
  level: LogLevel.INFO,
  logToFile: false,
  logFilePath: path.join(process.cwd(), 'sync-upstream.log'),
  showTimestamp: true,
  showLevel: true,
  structedLogging: false,
  perfMetricsEnabled: true,
  traceEnabled: false,
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

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.consola = this.createConsola()

    // 如果配置了日志文件，确保目录存在
    if (this.config.logToFile) {
      fs.ensureDirSync(path.dirname(this.config.logFilePath))
    }
  }

  private rank(): number {
    return this.logLevels.indexOf(this.config.level)
  }

  private enabled(level: LogLevel): boolean {
    return this.logLevels.indexOf(level) >= this.rank()
  }

  // 获取当前时间戳
  private getTimestamp(): string {
    return dayjs().format('YYYY-MM-DD HH:mm:ss')
  }

  // 记录到文件
  private logToFile(level: LogLevel, message: string, context?: Record<string, any>): void {
    if (!this.config.logToFile)
      return

    const timestamp = this.getTimestamp()

    if (this.config.structedLogging) {
      // 结构化日志格式
      const logEntry = {
        timestamp,
        level: level.toUpperCase(),
        message,
        context: context || {},
      }
      const logMessage = `${JSON.stringify(logEntry)}
`
      fs.appendFile(this.config.logFilePath, logMessage)
        .catch(error => console.error('写入日志文件失败:', error))
    }
    else {
      // 普通文本日志格式
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      const logMessage = this.config.showLevel
        ? `[${timestamp}] [${level.toUpperCase()}] ${message}${contextStr}\n`
        : `[${timestamp}] ${message}${contextStr}\n`

      fs.appendFile(this.config.logFilePath, logMessage)
        .catch(error => console.error('写入日志文件失败:', error))
    }
  }

  // 调试日志
  debug(message: string, context?: Record<string, any>): void {
    if (this.enabled(LogLevel.DEBUG)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.debug(blue(`[DEBUG] ${message}${contextStr}`))
      this.logToFile(LogLevel.DEBUG, message, context)
    }
  }

  // 详细日志
  verbose(message: string): void {
    if (this.enabled(LogLevel.VERBOSE)) {
      this.consola.log(gray(`[VERBOSE] ${message}`))
      this.logToFile(LogLevel.VERBOSE, message)
    }
  }

  // 追踪日志
  trace(message: string, context?: Record<string, any>): void {
    if (this.config.traceEnabled && this.enabled(LogLevel.TRACE)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.log(`[TRACE] ${message}${contextStr}`)
      this.logToFile(LogLevel.TRACE, message, context)
    }
  }

  // 性能日志
  perf(operation: string, durationMs: number, context?: Record<string, any>): void {
    if (this.config.perfMetricsEnabled && this.enabled(LogLevel.PERF)) {
      const formattedDuration = durationMs.toFixed(2)
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.log(cyan(`[PERF] ${operation} took ${formattedDuration}ms${contextStr}`))
      this.logToFile(LogLevel.PERF, `${operation} took ${formattedDuration}ms`, context)
    }
  }

  // 设置日志级别：过滤只由 logLevels 顺序决定，consola 保持全放行
  setLevel(level: LogLevel): void {
    this.config.level = level
  }

  // 信息日志
  info(message: string, context?: Record<string, any>): void {
    if (this.enabled(LogLevel.INFO)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.info(cyan(`[INFO] ${message}${contextStr}`))
      this.logToFile(LogLevel.INFO, message, context)
    }
  }

  // 成功日志
  success(message: string, context?: Record<string, any>): void {
    if (this.enabled(LogLevel.SUCCESS)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.success(green(`[SUCCESS] ${message}${contextStr}`))
      this.logToFile(LogLevel.SUCCESS, message, context)
    }
  }

  // 警告日志
  warn(message: string, context?: Record<string, any>): void {
    if (this.enabled(LogLevel.WARN)) {
      const contextStr = context ? ` ${JSON.stringify(context)}` : ''
      this.consola.warn(yellow(`[WARN] ${message}${contextStr}`))
      this.logToFile(LogLevel.WARN, message, context)
    }
  }

  // 错误日志
  error(message: string, error?: Error, context?: Record<string, any>): void {
    if (this.enabled(LogLevel.ERROR)) {
      const errorMessage = error ? `${message}: ${error.message}` : message
      const contextObj = { ...(context || {}), ...(error?.stack ? { stack: error.stack } : {}) }
      const contextStr = contextObj ? ` ${JSON.stringify(contextObj)}` : ''
      this.consola.error(red(`[ERROR] ${errorMessage}${contextStr}`))
      this.logToFile(LogLevel.ERROR, errorMessage, contextObj)
    }
  }

  // 步骤日志（用于显示同步过程中的主要步骤）
  step(stepNumber: number, message: string): void {
    if (!this.enabled(LogLevel.INFO))
      return
    const formattedMessage = bold(magenta(`
${stepNumber}. ${message}`))
    this.consola.log(formattedMessage)
    this.logToFile(LogLevel.INFO, `Step ${stepNumber}: ${message}`)
  }

  // 更新配置
  updateConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config }
    this.consola = this.createConsola()

    // 如果开启了日志文件，确保目录存在
    if (this.config.logToFile) {
      fs.ensureDirSync(path.dirname(this.config.logFilePath))
    }
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
