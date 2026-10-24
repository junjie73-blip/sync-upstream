import type { FileSinkOptions } from '../../src/log/sink'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { LogFileSink, readLogTail, scrubForFile } from '../../src/log/sink'

let dir: string
let counter = 0

/** One directory per case: rotation renames files in place, so sharing a folder hides mistakes. */
function sinkPath(name: string): string {
  counter += 1
  return path.join(dir, `${counter}-${name}`)
}

function linesOf(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
}

function makeSink(options: Partial<FileSinkOptions> & { file: string }): LogFileSink {
  return new LogFileSink(options)
}

/** `[时间] [INFO] 正文` with an ASCII body is 39 bytes, which is what the rotation cases count on. */
function timed(message: string): { level: string, message: string, at: string } {
  return { level: 'info', message, at: '2026-10-23T00:00:00.000Z' }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-log-'))
})

afterEach(async () => {
  await fs.remove(dir)
})

describe('LogFileSink 的等级与格式', () => {
  it('默认只留 info 及以上，debug 不该把文件变成垃圾场', () => {
    const file = sinkPath('level.log')
    const sink = makeSink({ file })

    expect(sink.write({ ...timed('逐条文件的比对细节'), level: 'debug' })).toBeUndefined()
    sink.write(timed('已提交 5c6b3a8'))
    sink.write({ ...timed('上游有本地未推送的提交'), level: 'warn' })

    const kept = linesOf(file)
    expect(kept).toHaveLength(2)
    expect(kept[0]).toBe('[2026-10-23T00:00:00.000Z] [INFO] 已提交 5c6b3a8')
    expect(kept[1]).toContain('[WARN] 上游有本地未推送的提交')
  })

  it('文件等级设成 warn 时，success 与 step 仍然按信息级看待', () => {
    const file = sinkPath('warn.log')
    const sink = makeSink({ file, level: 'warn' })

    sink.write({ level: 'success', message: '同步完成' })
    sink.write({ level: 'step', message: 'Step 1: 拉取上游' })
    sink.write({ level: 'fatal', message: '进程要退出了' })

    // `fatal` 是控制台等级，文件里只有四级；显式映射到 error 才不会整行丢掉。
    expect(linesOf(file)).toEqual([expect.stringMatching(/^\[\d{4}-.*\[ERROR\] 进程要退出了$/)])
  })

  it('verbose/trace/perf 归到 debug，开了 debug 就一起进文件', () => {
    const file = sinkPath('debug.log')
    const sink = makeSink({ file, level: 'debug' })

    for (const level of ['verbose', 'trace', 'perf'])
      sink.write({ level, message: `来自 ${level} 的一行` })

    const kept = linesOf(file)
    expect(kept).toHaveLength(3)
    expect(kept[0]).toContain('[DEBUG] 来自 verbose 的一行')
  })

  it('未知等级按 info 处理，不能让一个拼错的等级把日志吞掉', () => {
    const file = sinkPath('unknown.log')
    const sink = makeSink({ file, level: 'warn' })

    expect(sink.accepts({ level: 'notice', message: 'x' })).toBe(false)
    expect(makeSink({ file: sinkPath('unknown2.log') }).accepts({ level: 'notice', message: 'x' })).toBe(true)
  })

  it('写进文件之前先剥掉终端颜色码', () => {
    const file = sinkPath('color.log')
    const sink = makeSink({ file })

    sink.write({ level: 'error', message: `${String.fromCharCode(27)}[31m推送失败${String.fromCharCode(27)}[39m`, at: '2026-10-23T00:00:00.000Z' })

    const line = linesOf(file)[0]
    expect(line).toBe('[2026-10-23T00:00:00.000Z] [ERROR] 推送失败')
    expect(line).not.toContain(String.fromCharCode(27))
  })

  it('JSON 模式一行一个对象，context 保持成对象而不是字符串', () => {
    const file = sinkPath('json.log')
    const sink = makeSink({ file, json: true })

    sink.write({ level: 'error', message: '推送失败', at: '2026-10-23T00:00:00.000Z', context: { branch: 'main', attempts: 2 } })

    expect(JSON.parse(linesOf(file)[0])).toEqual({
      at: '2026-10-23T00:00:00.000Z',
      level: 'error',
      message: '推送失败',
      context: { branch: 'main', attempts: 2 },
    })
  })

  it('context 的字符串值先打码再序列化，转义引号挡不住规则', () => {
    const file = sinkPath('json-nested.log')
    const sink = makeSink({ file, json: true })

    sink.write({
      level: 'error',
      message: '认证失败',
      context: { note: '他说 "token": hunter2 就通过了', nested: { authorization: 'Bearer ghp_secretvalue' } },
    })

    const entry = JSON.parse(linesOf(file)[0])
    expect(entry.context.note).toBe('他说 "token": *** 就通过了')
    expect(entry.context.nested.authorization).toBe('Bearer ***')
    expect(entry.message).toBe('认证失败')
  })

  it('普通模式把 context 挂在行尾，值里的 URL 口令一样抹掉', () => {
    const file = sinkPath('plain-ctx.log')
    const sink = makeSink({ file })

    sink.write({ level: 'warn', message: '推送被拒', at: '2026-10-23T00:00:00.000Z', context: { remote: 'https://user:ghp_abcdef@github.com/a/b.git' } })

    expect(linesOf(file)[0]).toBe('[2026-10-23T00:00:00.000Z] [WARN] 推送被拒 {"remote":"https://***@github.com/a/b.git"}')
  })

  it('context 里是 stringify 处理不了的值时交回失败信息，而不是抛给正在同步的流程', () => {
    const file = sinkPath('unstringify.log')
    const sink = makeSink({ file })

    expect(() => sink.write({ level: 'info', message: '体积', context: { bytes: 10n as unknown as number } })).not.toThrow()
    expect(sink.write(timed('这行仍然写得下去'))).toBeUndefined()
    expect(linesOf(file)).toHaveLength(1)
  })

  it('空 context 不占字段', () => {
    const file = sinkPath('json-empty-ctx.log')
    makeSink({ file, json: true }).write({ level: 'info', message: '只有一句话', context: {} })

    expect(JSON.parse(linesOf(file)[0])).toEqual({ at: expect.any(String), level: 'info', message: '只有一句话' })
  })

  it('没给时间就自己补一个，日志文件不该留下无时间行', () => {
    const file = sinkPath('stamp.log')
    makeSink({ file }).write({ level: 'info', message: '顺手记一句' })

    expect(linesOf(file)[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe('LogFileSink 的打码', () => {
  it('颜色码和密钥一起去掉', () => {
    const file = sinkPath('scrub.log')
    const sink = makeSink({ file, redact: ['whsec_real_token'] })

    sink.write({
      level: 'info',
      message: `${String.fromCharCode(27)}[36m拉取 https://user:ghp_abcdef@github.com/a/b.git 失败，签名用 whsec_real_token${String.fromCharCode(27)}[39m`,
    })

    const line = linesOf(file)[0]
    expect(line).not.toContain('ghp_abcdef')
    expect(line).not.toContain('whsec_real_token')
    expect(line).not.toContain(String.fromCharCode(27))
    expect(line).toContain('github.com/a/b.git')
  })

  it('scrubForFile 是审计日志复用的同一套清洗', () => {
    expect(scrubForFile(`token${String.fromCharCode(27)}[39m=abc123`)).toBe('token=***')
  })
})

describe('LogFileSink 的体积轮转', () => {
  it('超过上限就先轮转再写：当前文件永远留着最新一行', () => {
    const file = sinkPath('rotate.log')
    const sink = makeSink({ file, maxBytes: 60, keep: 2 })

    // 39 字节一行，两行就到上限；keep 为 2 意味着最早的两次写入会被挤掉。
    for (const message of ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE'])
      sink.write(timed(message))

    const textOf = (target: string) => linesOf(target).map(line => line.replace(/.*\[INFO\] /, ''))
    expect(textOf(file)).toEqual(['EEEE'])
    expect(textOf(`${file}.1`)).toEqual(['DDDD'])
    expect(textOf(`${file}.2`)).toEqual(['CCCC'])
    expect(fs.existsSync(`${file}.3`)).toBe(false)
  })

  it('keep 为 0 表示不留历史：到上限直接清空重开', () => {
    const file = sinkPath('keep0.log')
    const sink = makeSink({ file, maxBytes: 20, keep: 0 })

    sink.write(timed('第一次'))
    sink.write(timed('第二次'))

    expect(fs.existsSync(`${file}.1`)).toBe(false)
    expect(linesOf(file)).toEqual([expect.stringContaining('第二次')])
  })

  it('接手已存在的旧文件时按磁盘大小起算，不会以为自己是空的', () => {
    const file = sinkPath('existing.log')
    fs.writeFileSync(file, `${'x'.repeat(50)}\n`, 'utf8')

    const sink = makeSink({ file, maxBytes: 60, keep: 1 })
    sink.write(timed('y'))

    expect(linesOf(`${file}.1`)).toEqual(['x'.repeat(50)])
    expect(linesOf(file)).toEqual([expect.stringContaining('[INFO] y')])
  })

  it('单行本身就超上限时照样写进去，宁可越界也别丢日志', () => {
    const file = sinkPath('huge.log')
    const sink = makeSink({ file, maxBytes: 20 })

    expect(sink.write(timed('x'.repeat(300)))).toBeUndefined()
    expect(linesOf(file)).toHaveLength(1)
  })

  it('maxBytes 或 keep 写了非法值时退回默认，而不是把日志关掉', () => {
    const file = sinkPath('defaults.log')
    const sink = makeSink({ file, maxBytes: 0, keep: -1 })

    expect(sink.write(timed('正常写进去'))).toBeUndefined()
    expect(linesOf(file)).toHaveLength(1)
  })

  it('目录不存在时先建目录再写，日志路径可以带子目录', () => {
    const file = sinkPath(path.join('nested', 'deeper', 'run.log'))

    expect(makeSink({ file }).write(timed('嵌套路径'))).toBeUndefined()
    expect(linesOf(file)).toHaveLength(1)
  })
})

describe('LogFileSink 的失败处理', () => {
  it('写不进去时把错误当返回值交出去，而不是抛给正在同步的流程', () => {
    const blocker = sinkPath('blocker')
    fs.writeFileSync(blocker, '这是个文件，不是目录', 'utf8')
    const sink = makeSink({ file: path.join(blocker, 'run.log') })

    const failure = sink.write(timed('这行写不下去'))

    expect(typeof failure).toBe('string')
    expect(failure).toContain('写入日志文件')
  })

  it('等级过滤掉的行连文件系统都不碰，返回值也该是 undefined', () => {
    const blocker = sinkPath('blocker2')
    fs.writeFileSync(blocker, 'x', 'utf8')
    const sink = makeSink({ file: path.join(blocker, 'run.log'), level: 'error' })

    expect(sink.write(timed('不该写'))).toBeUndefined()
  })

  it('path 暴露配置的路径，doctor 与 status 靠它报告位置', () => {
    const file = sinkPath('path.log')
    expect(makeSink({ file }).path).toBe(file)
  })
})

describe('readLogTail', () => {
  it('文件不存在返回 undefined，doctor 不该因此报错', () => {
    expect(readLogTail(path.join(dir, 'nothing.log'))).toBeUndefined()
  })

  it('取最后几行且倒序，最新的一行排在最前', () => {
    const file = sinkPath('tail.log')
    const sink = makeSink({ file })
    for (const message of ['一', '二', '三', '四', '五', '六'])
      sink.write(timed(message))

    const tail = readLogTail(file, 2)
    expect(tail?.lines.map(line => line.replace(/.*\[INFO\] /, ''))).toEqual(['六', '五'])
    expect(tail?.offset).toBe(0)
  })

  it('超过 64 KiB 的文件只读尾巴，被截断的半行不会当成一行返回', () => {
    const file = sinkPath('big.log')
    const padding = `${'p'.repeat(70 * 1024)}\n`
    fs.writeFileSync(file, `${padding}[t] [INFO] 倒数第二行\n[t] [INFO] 最后一行\n`, 'utf8')

    const tail = readLogTail(file, 5)
    expect(tail?.offset).toBeGreaterThan(0)
    expect(tail?.lines).toEqual(['[t] [INFO] 最后一行', '[t] [INFO] 倒数第二行'])
  })

  it('轮转当下也留得下最新一行，doctor 才答得出"上次是什么时候写的"', () => {
    const file = sinkPath('tail-after-rotate.log')
    const sink = makeSink({ file, maxBytes: 60 })

    sink.write(timed('AAAA'))
    sink.write(timed('BBBB'))

    expect(readLogTail(file, 1)?.lines).toEqual([expect.stringContaining('BBBB')])
  })

  it('路径指向目录时读不出内容也不能抛，doctor 只是少一段尾巴', () => {
    expect(() => readLogTail(dir)).not.toThrow()
  })
})
