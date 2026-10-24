import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebhookConfig } from '../../src/domain/webhook'
import type { DeliveryRecord } from '../../src/webhook/delivery-log'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { logger } from '../../src/logger'
import { DeliveryLog, readDeliveryLog } from '../../src/webhook/delivery-log'
import { WebhookServer } from '../../src/webhook/server'

const SECRET = 'audit-test-secret'
const CLIENT_IP = '203.0.113.10'
const PUSH_BODY = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'org/upstream' } })

let dir: string
let logFile: string

function makeConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    enable: true,
    port: 0,
    path: '/webhook',
    secret: SECRET,
    allowedEvents: ['push'],
    triggerBranch: 'main',
    supportedPlatforms: ['github'],
    deliveryLog: logFile,
    securityConfig: {
      ipWhitelist: [],
      rateLimit: { maxRequestsPerSecond: 100, statusCode: 429, message: '请求过于频繁' },
    },
    ...overrides,
  }
}

function makeReq(headers: Record<string, string>, body: string, deliveryId?: string): IncomingMessage {
  const req = new EventEmitter() as unknown as Record<string, any>
  req.method = 'POST'
  req.url = '/webhook'
  req.headers = deliveryId ? { 'x-github-delivery': deliveryId, ...headers } : headers
  req.socket = { remoteAddress: CLIENT_IP }
  req.destroy = () => {}
  const raw = Buffer.from(body)
  queueMicrotask(() => {
    req.emit('data', raw)
    req.emit('end')
  })
  return req as unknown as IncomingMessage
}

function makeRes(): { res: ServerResponse, status: () => number, body: () => Record<string, unknown> } {
  const state = { status: 0, text: '' }
  const res = {
    headersSent: false,
    writeHead(status: number) {
      state.status = status
      this.headersSent = true
    },
    end(data?: string) {
      state.text = data ?? ''
    },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => state.status,
    body: () => JSON.parse(state.text) as Record<string, unknown>,
  }
}

function signed(body: string, event = 'push'): Record<string, string> {
  const digest = createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex')
  return { 'x-github-event': event, 'x-hub-signature-256': `sha256=${digest}` }
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5))
}

/** 审计里的顺序是写入顺序，返回成数组方便断言。 */
function audit(): DeliveryRecord[] {
  return readDeliveryLog(logFile).records.slice().reverse()
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-webhook-audit-'))
  logFile = path.join(dir, 'deliveries.jsonl')
})

afterEach(async () => {
  await fs.remove(dir)
})

describe('webhook 审计：每个决定都留得下一行', () => {
  it('收到就记 accepted，同步结束再记 synced，两行都能对上投递号', async () => {
    const onSync = jest.fn().mockResolvedValue(undefined)
    const server = new WebhookServer(makeConfig(), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })

    const { res, status } = makeRes()
    await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'delivery-1'), res)
    expect(status()).toBe(202)
    await server.pendingSyncs()

    const records = audit()
    expect(records.map(record => record.decision)).toEqual(['accepted', 'synced'])
    expect(records[0]).toMatchObject({ deliveryId: 'delivery-1', platform: 'github', event: 'push', branch: 'main', status: 202 })
    expect(records[1]).toMatchObject({ deliveryId: 'delivery-1' })
    // 结果行没有状态码：平台早就拿到 202 了，这一行说的是同步本身。
    expect(records[1].status).toBeUndefined()
    expect(typeof records[1].durationMs).toBe('number')
  })

  it('同步失败也要写清原因和耗时，运维不必去翻控制台', async () => {
    const onSync = jest.fn().mockRejectedValue(new Error('锁被占用'))
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})
    const server = new WebhookServer(makeConfig(), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })

    const { res } = makeRes()
    await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'delivery-2'), res)
    await server.pendingSyncs()

    const [accepted, failed] = audit()
    expect(accepted.decision).toBe('accepted')
    expect(failed).toMatchObject({ decision: 'failed', reason: '锁被占用', branch: 'main' })
    errorSpy.mockRestore()
  })

  it('签名错的投递记 rejected 并带上 HTTP 状态码，方便和平台的红点对照', async () => {
    const onSync = jest.fn()
    const server = new WebhookServer(makeConfig(), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })

    const { res, status } = makeRes()
    await server.handle(makeReq({ 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=deadbeef' }, PUSH_BODY, 'delivery-3'), res)

    expect(status()).toBe(401)
    expect(audit()[0]).toMatchObject({ decision: 'rejected', status: 401, deliveryId: 'delivery-3', ip: CLIENT_IP })
    expect(onSync).not.toHaveBeenCalled()
  })

  it('分支不匹配是 ignored 不是 rejected：平台没做错什么，只是不该同步', async () => {
    const onSync = jest.fn()
    const server = new WebhookServer(makeConfig(), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })
    const body = JSON.stringify({ ref: 'refs/heads/dev' })

    const { res, status } = makeRes()
    await server.handle(makeReq(signed(body), body, 'delivery-4'), res)

    expect(status()).toBe(200)
    const [record] = audit()
    expect(record).toMatchObject({ decision: 'ignored', branch: 'dev' })
    expect(record.reason).toContain('非触发分支')
  })

  it('没配审计文件也照样应答，只是少一行记录', async () => {
    const onSync = jest.fn().mockResolvedValue(undefined)
    const server = new WebhookServer(makeConfig({ deliveryLog: undefined }), { onSync })

    const { res, status } = makeRes()
    await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'delivery-5'), res)

    expect(status()).toBe(202)
    expect(fs.existsSync(logFile)).toBe(false)
  })

  it('审计写不下去也不能拖累应答，失败只报一次警告', async () => {
    const onSync = jest.fn().mockResolvedValue(undefined)
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, '不是目录', 'utf8')
    const server = new WebhookServer(makeConfig(), {
      onSync,
      onDelivery: record => new DeliveryLog(path.join(blocker, 'a.jsonl')).record(record),
    })

    const { res, status } = makeRes()
    await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'delivery-6'), res)

    expect(status()).toBe(202)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('写入投递审计'))
    warnSpy.mockRestore()
  })
})

describe('webhook 去重跨进程', () => {
  it('重启后收到同一个投递号不再同步第二遍', async () => {
    const onSync = jest.fn().mockResolvedValue(undefined)
    const first = new WebhookServer(makeConfig(), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })
    const resA = makeRes()
    await first.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'delivery-restart'), resA.res)
    expect(resA.status()).toBe(202)
    await first.pendingSyncs()

    // 状态文件默认挂在审计文件旁边，不需要额外配置。
    expect(fs.existsSync(`${logFile}.seen.json`)).toBe(true)

    const second = new WebhookServer(makeConfig(), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })
    const resB = makeRes()
    await second.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'delivery-restart'), resB.res)

    expect(resB.status()).toBe(200)
    expect(resB.body()).toEqual({ accepted: false, reason: '重复投递: delivery-restart' })
    expect(onSync).toHaveBeenCalledTimes(1)
    expect(readDeliveryLog(logFile).records[0]).toMatchObject({ decision: 'ignored', reason: '重复投递: delivery-restart' })
  })

  it('显式关掉去重时，同一个投递号来几次同步几次', async () => {
    const onSync = jest.fn().mockResolvedValue(undefined)
    const server = new WebhookServer(makeConfig({ deduplicate: false }), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })

    for (let attempt = 0; attempt < 2; attempt++) {
      const { res } = makeRes()
      await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'delivery-dup'), res)
    }
    await server.pendingSyncs()

    expect(onSync).toHaveBeenCalledTimes(2)
  })

  it('没带投递号的平台无法去重，也不会误判成重复', async () => {
    const onSync = jest.fn().mockResolvedValue(undefined)
    const server = new WebhookServer(makeConfig(), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })

    for (let attempt = 0; attempt < 2; attempt++) {
      const { res, status } = makeRes()
      await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY), res)
      expect(status()).toBe(202)
    }
    await server.pendingSyncs()

    expect(onSync).toHaveBeenCalledTimes(2)
  })
})

describe('webhook 队列上限', () => {
  it('排不下就回 503 让平台稍后重投，而不是默默堆积', async () => {
    let release: () => void = () => {}
    const onSync = jest.fn().mockImplementation(() => new Promise<void>(resolve => (release = resolve)))
    const server = new WebhookServer(makeConfig({ maxQueue: 1 }), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })

    const first = makeRes()
    await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'queue-1'), first.res)
    expect(first.status()).toBe(202)

    const second = makeRes()
    await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'queue-2'), second.res)

    expect(second.status()).toBe(503)
    expect(second.body().error).toContain('同步队列已满')
    expect(onSync).toHaveBeenCalledTimes(1)
    expect(audit()[1]).toMatchObject({ decision: 'rejected', status: 503, deliveryId: 'queue-2' })

    release()
    await server.pendingSyncs()
  })

  it('腾出位置后新投递又能进队列', async () => {
    let release: () => void = () => {}
    const onSync = jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const server = new WebhookServer(makeConfig({ maxQueue: 1 }), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })

    const first = makeRes()
    await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'free-1'), first.res)
    const blocked = makeRes()
    await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'free-2'), blocked.res)
    expect(blocked.status()).toBe(503)

    release()
    await server.pendingSyncs()

    const third = makeRes()
    await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'free-3'), third.res)
    expect(third.status()).toBe(202)
    release()
    await server.pendingSyncs()
  })

  it('没配 maxQueue 时也有默认上限，不会无限吃内存', async () => {
    const onSync = jest.fn().mockImplementation(() => new Promise<void>(() => {}))
    const server = new WebhookServer(makeConfig(), { onSync })
    const statuses: number[] = []

    for (let index = 0; index < 10; index++) {
      const { res, status } = makeRes()
      await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, `cap-${index}`), res)
      statuses.push(status())
    }

    expect(statuses.filter(value => value === 202)).toHaveLength(8)
    expect(statuses.filter(value => value === 503)).toHaveLength(2)
  })
})

describe('healthz 把守护进程的真实状态说清楚', () => {
  it('带上计数、最后一次投递、去重表大小与队列上限', async () => {
    const onSync = jest.fn().mockResolvedValue(undefined)
    const server = new WebhookServer(makeConfig(), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })
    const accepted = makeRes()
    await server.handle(makeReq(signed(PUSH_BODY), PUSH_BODY, 'health-1'), accepted.res)
    await server.pendingSyncs()
    const wrongBranch = makeRes()
    await server.handle(makeReq(signed(JSON.stringify({ ref: 'refs/heads/dev' })), JSON.stringify({ ref: 'refs/heads/dev' }), 'health-2'), wrongBranch.res)

    const probe = makeRes()
    const req = { method: 'GET', url: '/healthz', headers: {}, socket: { remoteAddress: CLIENT_IP } }
    await server.handle(req as unknown as IncomingMessage, probe.res)

    expect(probe.status()).toBe(200)
    const body = probe.body()
    expect(body).toMatchObject({ status: 'ok', maxQueue: 8, dedupe: 1 })
    expect(body.counts).toEqual({ accepted: 1, ignored: 1, rejected: 0, synced: 1, failed: 0 })
    expect(body.lastDelivery).toMatchObject({ decision: 'ignored', branch: 'dev' })
    expect(typeof body.uptimeSec).toBe('number')
    expect(body.running).toBe(0)
  })

  it('没 start 过时 uptime 记 0，探针不至于报错', async () => {
    const server = new WebhookServer(makeConfig(), { onSync: jest.fn() })
    const probe = makeRes()
    await server.handle({ method: 'GET', url: '/healthz', headers: {}, socket: {} } as unknown as IncomingMessage, probe.res)

    expect(probe.status()).toBe(200)
    expect(probe.body().uptimeSec).toBe(0)
  })

  it('healthPath 设成 false 就不再有免密钥的入口', async () => {
    const server = new WebhookServer(makeConfig({ healthPath: false }), { onSync: jest.fn() })
    const probe = makeRes()
    await server.handle({ method: 'GET', url: '/healthz', headers: {}, socket: {} } as unknown as IncomingMessage, probe.res)

    expect(probe.status()).toBe(404)
  })

  it('退出过程中探针回 503，编排平台才肯把流量摘掉', async () => {
    const server = new WebhookServer(makeConfig(), { onSync: jest.fn() })
    await server.start()
    await server.stop()

    const probe = makeRes()
    await server.handle({ method: 'GET', url: '/healthz', headers: {}, socket: {} } as unknown as IncomingMessage, probe.res)
    expect(probe.status()).toBe(503)
    expect(probe.body().status).toBe('shutting-down')
  })
})

describe('stop 等在途同步', () => {
  it('SIGTERM 打断不了写到一半的提交：stop 返回时结果已经进审计', async () => {
    let release: () => void = () => {}
    const onSync = jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const server = new WebhookServer(makeConfig(), { onSync, onDelivery: record => new DeliveryLog(logFile).record(record) })
    const { port } = await server.start()

    const response = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', headers: signed(PUSH_BODY), body: PUSH_BODY })
    expect(response.status).toBe(202)
    await flush()

    const stopping = server.stop()
    release()
    await stopping

    expect(readDeliveryLog(logFile).records[0].decision).toBe('synced')
  })
})
