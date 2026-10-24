import type { SyncConfig } from '../../src/domain'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { resolveConfig } from '../../src/config/resolve'
import { logger } from '../../src/logger'
import { serveWebhooks } from '../../src/pipeline/webhook-mode'
import { readDeliveryLog } from '../../src/webhook/delivery-log'

const SECRET = 'daemon-test-secret'

let dir: string

function baseConfig(overrides: Record<string, unknown> = {}): SyncConfig {
  return resolveConfig({
    upstreamRepo: 'https://git.example.com/org/upstream.git',
    upstreamBranch: 'main',
    companyBranch: 'company',
    syncDirs: ['src/config'],
    nonInteractive: true,
    webhookConfig: {
      enable: true,
      port: 0,
      path: '/webhook',
      secret: SECRET,
      allowedEvents: ['push'],
      triggerBranch: 'main',
      supportedPlatforms: ['github'],
      securityConfig: { ipWhitelist: [], rateLimit: { maxRequestsPerSecond: 100, statusCode: 429, message: 'x' } },
    },
    ...overrides,
  } as never).config
}

function signed(body: string): Record<string, string> {
  const digest = createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex')
  return { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${digest}` }
}

/**
 * 用 node:http 而不是 fetch：undici 的连接池会留着 keep-alive 句柄，测试跑完 jest 也不肯退出。
 * agent:false 让每个请求自己建连、自己关，收尾干净。
 */
function post(port: number, urlPath: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers, agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function until<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const startedAt = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined)
      return value
    if (Date.now() - startedAt > timeoutMs)
      throw new Error('等待超时：守护进程没有把启动信息写进日志文件')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** 进程级事件名在 @types/node 里是一堆重载，用字符串取反而匹配不到，所以集中转一次（保留 this）。 */
type LooseListener = (arg: unknown) => void

interface LooseProcess {
  listeners: (name: string) => LooseListener[]
  emit: (name: string, ...args: unknown[]) => boolean
  off: (name: string, listener: LooseListener) => void
}

function loose(): LooseProcess {
  return process as unknown as LooseProcess
}

/** 从日志文件里读出实际端口：不猜端口号，同时正好验证日志确实落到了盘上。 */
function portFromLog(file: string): number | undefined {
  if (!fs.existsSync(file))
    return undefined
  const match = fs.readFileSync(file, 'utf8').match(/https?:\/\/[\d.]+:(\d+)\/webhook/)
  return match ? Number(match[1]) : undefined
}

function logLines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
}

// 守护进程的崩溃兜底是进程级的：注册一次就跟着这个文件跑到最后，所以基线在文件层面取一次，
// 收尾时再收回，否则它会替同一个 worker 里后面的套件吞掉真正的未处理拒绝。
const listenerBaseline = {
  unhandledRejection: loose().listeners('unhandledRejection').length,
  uncaughtException: loose().listeners('uncaughtException').length,
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-webhook-daemon-'))
})

afterEach(async () => {
  logger.setFileSink(null)
  await fs.remove(dir)
})

afterAll(() => {
  for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
    const keep = listenerBaseline[event]
    for (const listener of loose().listeners(event).slice(keep))
      process.off(event, listener)
  }
})

describe('serveWebhooks 的落盘与审计', () => {
  it('控制台安静时文件仍留有完整链路，投递决定单独成一份 JSONL', async () => {
    const logFile = path.join(dir, 'logs', 'daemon.log')
    const config = baseConfig({
      logConfig: { file: 'logs/daemon.log', level: 'debug' },
      webhookConfig: { ...baseConfig().webhookConfig, deliveryLog: 'logs/deliveries.jsonl' },
    })

    const running = serveWebhooks(config, dir)
    const port = await until(() => portFromLog(logFile))

    // 非触发分支：不该起同步，但必须在审计里留下一行"为什么没同步"。
    const body = JSON.stringify({ ref: 'refs/heads/dev' })
    expect(await post(port, '/webhook', signed(body), body)).toBe(200)

    loose().emit('SIGTERM')
    expect(await running).toBe(0)

    const text = logLines(logFile).join('\n')
    expect(text).toContain(`日志同时写入 ${logFile}`)
    expect(text).toContain(`投递决定写入 ${path.join(dir, 'logs', 'deliveries.jsonl')}`)
    expect(text).toContain('Webhook 服务已停止')
    // 落的是解析后的绝对路径，相对 cwd 的写法不会留在日志里让人猜。
    expect(text).not.toMatch(/file: logs/)

    const tail = readDeliveryLog(path.join(dir, 'logs', 'deliveries.jsonl'))
    expect(tail.records[0]).toMatchObject({ decision: 'ignored', branch: 'dev', status: 200 })
    // 密钥永远不进日志与审计。
    expect(text).not.toContain(SECRET)
    expect(fs.readFileSync(path.join(dir, 'logs', 'deliveries.jsonl'), 'utf8')).not.toContain(SECRET)
    // 去重状态文件的落盘与重启复用由 `__tests__/webhook/audit.test.ts` 覆盖：那里可以把 accepted
    // 分支的 onSync 换成桩，而这里只要 accepted 就会真的拉一次不存在的上游。
  })

  it('打印的监听地址就是实际绑定的地址，不会谎报成 0.0.0.0', async () => {
    const logFile = path.join(dir, 'daemon.log')
    const config = baseConfig({ logConfig: { file: 'daemon.log' } })

    const running = serveWebhooks(config, dir)
    const port = await until(() => portFromLog(logFile))

    loose().emit('SIGTERM')
    await running

    expect(port).toBeGreaterThan(0)
    expect(logLines(logFile).join('\n')).toContain(`http://127.0.0.1:${port}/webhook`)
  })

  it('没配 deliveryLog 时提醒一次，日志文件仍然照写', async () => {
    const logFile = path.join(dir, 'no-audit.log')
    const config = baseConfig({ logConfig: { file: 'no-audit.log' } })

    const running = serveWebhooks(config, dir)
    await until(() => portFromLog(logFile))
    loose().emit('SIGTERM')
    await running

    const text = logLines(logFile).join('\n')
    expect(text).toContain('未设置 webhookConfig.deliveryLog')
    expect(fs.readdirSync(dir).filter(name => name.includes('deliveries'))).toEqual([])
  })

  it('webhookConfig.enable 为 false 就直接返回，不占端口也不建日志', async () => {
    const consoleSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const config = baseConfig({ logConfig: { file: 'unused.log' } })

    // 关掉开关时连日志都不该起：`--webhook-enable` 没给却写了日志文件会让人以为守护进程在跑。
    const disabled = baseConfig({ webhookConfig: { ...config.webhookConfig, enable: false } })
    expect(await serveWebhooks(disabled, dir)).toBe(0)

    consoleSpy.mockRestore()
    expect(fs.existsSync(path.join(dir, 'unused.log'))).toBe(false)
  })

  it('崩了不退出：未处理的 Promise 拒绝只记日志，并且只注册一个监听', async () => {
    const logFile = path.join(dir, 'crash.log')
    const config = baseConfig({ logConfig: { file: 'crash.log' } })

    const running = serveWebhooks(config, dir)
    await until(() => portFromLog(logFile))

    // 这个文件里前面几个测试各起过一次守护，进程级监听仍然只有一个：起第 N 次不该再翻倍。
    expect(loose().listeners('unhandledRejection')).toHaveLength(listenerBaseline.unhandledRejection + 1)
    loose().emit('unhandledRejection', new Error('拉取时网络断了'))
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(logLines(logFile).join('\n')).toContain('拉取时网络断了')

    loose().emit('SIGTERM')
    expect(await running).toBe(0)
  })
})
