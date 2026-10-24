import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { configureLogging, Logger, logger, loggingSink, LogLevel } from '../../src/logger'

let dir: string
let counter = 0

function logFile(name: string): string {
  counter += 1
  return path.join(dir, `${counter}-${name}`)
}

function linesOf(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
}

/** Run against a logger that only writes to a file, so console noise cannot hide a missing line. */
function toFileOnly(file: string, write: (log: Logger) => void): string[] {
  const log = new Logger()
  log.setFileSink(loggingSink({ file }))
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    write(log)
  }
  finally {
    stderr.mockRestore()
    stdout.mockRestore()
  }
  return linesOf(file)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-logger-file-'))
})

afterEach(async () => {
  logger.setFileSink(null)
  await fs.remove(dir)
})

describe('loggingSink 按配置建文件写入器', () => {
  it('没给 file 就是只打控制台，与 0.2 之前一致', () => {
    expect(loggingSink(undefined)).toBeNull()
    expect(loggingSink({})).toBeNull()
    expect(loggingSink({ file: '   ' })).toBeNull()
  })

  it('相对路径按当前目录解析，绝对路径原样接受', () => {
    expect(loggingSink({ file: 'logs/run.log' })?.path)
      .toBe(path.resolve(process.cwd(), 'logs/run.log'))
    const absolute = logFile('abs.log')
    expect(loggingSink({ file: absolute })?.path).toBe(absolute)
  })

  it('配置文件里的 redact 与运行时密钥合并后一起交给写入器', () => {
    const file = logFile('secrets.log')
    const sink = loggingSink({ file, redact: ['whsec_from_file'] }, { secrets: [undefined, 'ghp_from_auth'] })

    sink?.write({ level: 'info', message: '签名 whsec_from_file，令牌 ghp_from_auth 已使用' })

    const line = linesOf(file)[0]
    expect(line).not.toContain('whsec_from_file')
    expect(line).not.toContain('ghp_from_auth')
  })
})

describe('Logger 落盘的那一份', () => {
  it('--silent 让控制台闭嘴，文件仍然要有整条链路', () => {
    const file = logFile('silent.log')
    const lines = toFileOnly(file, (log) => {
      log.setLevel(LogLevel.ERROR)
      log.info('同步了 3 个文件')
      log.warn('上游有本地未推送的提交')
      log.error('推送失败')
    })

    expect(lines.map(line => line.replace(/.*\[(INFO|WARN|ERROR)\] /, ''))).toEqual(['同步了 3 个文件', '上游有本地未推送的提交', '推送失败'])
  })

  it('步骤日志也进文件，事后能还原跑过哪几步', () => {
    const file = logFile('step.log')
    const lines = toFileOnly(file, (log) => {
      log.step(2, '拉取上游')
      log.success('同步完成')
    })

    expect(lines[0]).toContain('[INFO] Step 2: 拉取上游')
    expect(lines[1]).toContain('[INFO] 同步完成')
  })

  it('错误带上堆栈时一起落盘，事后不用复现', () => {
    const file = logFile('stack.log')
    const lines = toFileOnly(file, (log) => {
      log.error('合并冲突', new Error('CONFLICT (content): src/a.ts'), { branch: 'company' })
    })

    expect(lines[0]).toContain('合并冲突: CONFLICT (content): src/a.ts')
    expect(lines[0]).toContain('"branch":"company"')
    expect(lines[0]).toContain('stack')
  })

  it('文件等级独立于控制台等级，warn 以上的文件不会被 debug 刷屏', () => {
    const file = logFile('level.log')
    const log = new Logger()
    log.setFileSink(loggingSink({ file, level: 'warn' }))
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      log.setLevel(LogLevel.DEBUG)
      log.debug('调试细节')
      log.info('一条信息')
      log.warn('一条警告')
    }
    finally {
      stdout.mockRestore()
    }

    expect(linesOf(file).map(line => line.replace(/.*\[WARN\] /, ''))).toEqual(['一条警告'])
  })

  it('setFileSink(null) 就回到只打控制台', () => {
    const file = logFile('detach.log')
    const log = new Logger()
    log.setFileSink(loggingSink({ file }))
    expect(log.fileSinkPath).toBe(file)

    log.setFileSink(null)
    expect(log.fileSinkPath).toBeUndefined()
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      log.info('这行只该出现在控制台')
    }
    finally {
      stdout.mockRestore()
    }
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('日志文件写不下去时的自持', () => {
  it('只报一次 stderr，且不通过 logger 自己报告', () => {
    const blocker = logFile('blocker')
    fs.writeFileSync(blocker, '不是目录', 'utf8')
    const log = new Logger()
    log.setFileSink(loggingSink({ file: path.join(blocker, 'run.log') }))

    const chunks: string[] = []
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      chunks.push(String(chunk))
      return true
    })
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      log.info('第一条')
      log.warn('第二条')
      log.error('第三条')
    }
    finally {
      stderr.mockRestore()
      stdout.mockRestore()
    }

    const reported = chunks.filter(chunk => chunk.includes('[LOG]'))
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('写入日志文件')
    // 报告本身不能再变成一条新日志，否则一次失败会递归到进程撑爆。
    expect(reported.join('')).not.toContain('第一条')
  })

  it('换一个新写入器就重新报告一次，不会永久沉默', () => {
    const log = new Logger()
    const first = logFile('bad-1')
    fs.writeFileSync(first, 'x', 'utf8')
    log.setFileSink(loggingSink({ file: path.join(first, 'run.log') }))

    const chunks: string[] = []
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      chunks.push(String(chunk))
      return true
    })
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const second = logFile('bad-2')
    fs.writeFileSync(second, 'x', 'utf8')
    try {
      log.info('第一条')
      // 换目标（比如 doctor 之后修好了路径）时，报告次数也要归零。
      log.setFileSink(loggingSink({ file: path.join(second, 'nested', 'run.log') }))
      log.info('第二条')
    }
    finally {
      stderr.mockRestore()
      stdout.mockRestore()
    }

    // 每换一个写入器就重新报告一次：修好路径之后又坏了，不该因为第一次报过就永远沉默。
    expect(chunks.filter(chunk => chunk.includes('[LOG]'))).toHaveLength(2)
  })
})

describe('configureLogging 把共享 logger 接到文件上', () => {
  it('返回落盘路径，之后的日志双写；配置为空则退回只打控制台', () => {
    const file = logFile('shared.log')

    expect(configureLogging({ file }, { cwd: dir })).toBe(file)
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      logger.info('经过单例的一行')
      logger.setFileSink(null)
      logger.info('摘掉之后不该再写文件')
    }
    finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }

    expect(linesOf(file)).toHaveLength(1)
    expect(linesOf(file)[0]).toContain('经过单例的一行')
    expect(configureLogging(undefined, { cwd: dir })).toBeUndefined()
    expect(logger.fileSinkPath).toBeUndefined()
  })
})
