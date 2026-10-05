import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebhookConfig, WebhookDelivery } from '../../src/domain/webhook'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { logger } from '../../src/logger'
import { WebhookServer } from '../../src/webhook/server'

const SECRET = 'unit-test-secret'
const CLIENT_IP = '203.0.113.10'

function makeConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    enable: true,
    port: 0,
    path: '/webhook',
    secret: SECRET,
    allowedEvents: ['push'],
    triggerBranch: 'main',
    supportedPlatforms: ['github'],
    securityConfig: {
      ipWhitelist: [],
      rateLimit: { maxRequestsPerSecond: 100, statusCode: 429, message: '请求过于频繁' },
    },
    ...overrides,
  }
}

function makeReq(options: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string | Buffer
  remoteAddress?: string
}): IncomingMessage {
  const req = new EventEmitter() as unknown as Record<string, any>
  req.method = options.method ?? 'POST'
  req.url = options.url ?? '/webhook'
  req.headers = options.headers ?? {}
  req.socket = { remoteAddress: options.remoteAddress ?? CLIENT_IP }
  req.destroy = () => {
    req.destroyed = true
  }
  const raw = options.body ? Buffer.from(options.body) : Buffer.alloc(0)
  queueMicrotask(() => {
    for (let offset = 0; offset < raw.length; offset += 64 * 1024) {
      if (req.destroyed)
        break
      req.emit('data', raw.subarray(offset, offset + 64 * 1024))
    }
    req.emit('end')
  })
  return req as unknown as IncomingMessage
}

function makeRes(): { res: ServerResponse, statusCode: () => number, json: () => any, finished: () => boolean } {
  const state = { statusCode: 0, body: '', ended: false }
  const res = {
    headersSent: false,
    writeHead(status: number) {
      state.statusCode = status
      this.headersSent = true
    },
    end(data?: string) {
      state.body = data ?? ''
      state.ended = true
    },
  }
  return {
    res: res as unknown as ServerResponse,
    statusCode: () => state.statusCode,
    json: () => JSON.parse(state.body),
    finished: () => state.ended,
  }
}

function signedGitHubHeaders(body: string): Record<string, string> {
  const digest = createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex')
  return { 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${digest}` }
}

const PUSH_BODY = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'org/upstream' } })

function flushAsync(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('webhookServer.handle', () => {
  let onSync: jest.Mock

  beforeEach(() => {
    onSync = jest.fn().mockResolvedValue(undefined)
  })

  it('正确签名 + 触发分支：202 且 onSync 收到 accepted:true 的投递', async () => {
    const server = new WebhookServer(makeConfig(), { onSync })
    const { res, statusCode, json } = makeRes()
    await server.handle(makeReq({ headers: signedGitHubHeaders(PUSH_BODY), body: PUSH_BODY }), res)

    expect(statusCode()).toBe(202)
    expect(json()).toEqual({ accepted: true })
    expect(onSync).toHaveBeenCalledTimes(1)
    const delivery: WebhookDelivery = onSync.mock.calls[0][0]
    expect(delivery).toMatchObject({ platform: 'github', event: 'push', branch: 'main', accepted: true })
    await flushAsync()
  })

  it('gitLab token 平台路径同样可用', async () => {
    const server = new WebhookServer(makeConfig({ supportedPlatforms: ['gitlab'], secret: SECRET }), { onSync })
    const body = JSON.stringify({ object_kind: 'push', ref: 'refs/heads/main' })
    const { res, statusCode } = makeRes()
    await server.handle(makeReq({
      headers: { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': SECRET },
      body,
    }), res)
    expect(statusCode()).toBe(202)
    await flushAsync()
  })

  it('路径不匹配返回 404', async () => {
    const server = new WebhookServer(makeConfig(), { onSync })
    const { res, statusCode } = makeRes()
    await server.handle(makeReq({ url: '/other', headers: signedGitHubHeaders(PUSH_BODY), body: PUSH_BODY }), res)
    expect(statusCode()).toBe(404)
    expect(onSync).not.toHaveBeenCalled()
  })

  it('非 POST 方法返回 405', async () => {
    const server = new WebhookServer(makeConfig(), { onSync })
    const { res, statusCode } = makeRes()
    await server.handle(makeReq({ method: 'GET' }), res)
    expect(statusCode()).toBe(405)
  })

  it('iP 不在白名单返回 403', async () => {
    const server = new WebhookServer(
      makeConfig({ securityConfig: { ipWhitelist: ['198.51.100.7'], rateLimit: { maxRequestsPerSecond: 100, statusCode: 429, message: 'x' } } }),
      { onSync },
    )
    const { res, statusCode } = makeRes()
    await server.handle(makeReq({ headers: signedGitHubHeaders(PUSH_BODY), body: PUSH_BODY }), res)
    expect(statusCode()).toBe(403)
  })

  it('x-forwarded-for 首跳参与白名单判断', async () => {
    const server = new WebhookServer(
      makeConfig({ securityConfig: { ipWhitelist: ['10.0.0.0/8'], rateLimit: { maxRequestsPerSecond: 100, statusCode: 429, message: 'x' } } }),
      { onSync },
    )
    const { res, statusCode } = makeRes()
    await server.handle(makeReq({
      headers: { ...signedGitHubHeaders(PUSH_BODY), 'x-forwarded-for': '10.1.2.3, 192.168.0.1' },
      body: PUSH_BODY,
    }), res)
    expect(statusCode()).toBe(202)
    await flushAsync()
  })

  it('超出限流返回配置的状态码与消息', async () => {
    const server = new WebhookServer(
      makeConfig({ securityConfig: { ipWhitelist: [], rateLimit: { maxRequestsPerSecond: 1, statusCode: 429, message: '慢一点' } } }),
      { onSync },
    )
    const first = makeRes()
    await server.handle(makeReq({ headers: signedGitHubHeaders(PUSH_BODY), body: PUSH_BODY }), first.res)
    expect(first.statusCode()).toBe(202)

    const second = makeRes()
    await server.handle(makeReq({ headers: signedGitHubHeaders(PUSH_BODY), body: PUSH_BODY }), second.res)
    expect(second.statusCode()).toBe(429)
    expect(second.json()).toEqual({ error: '慢一点' })
    await flushAsync()
  })

  it('请求体超过 1 MiB 返回 413', async () => {
    const server = new WebhookServer(makeConfig(), { onSync })
    const bigBody = JSON.stringify({ ref: 'refs/heads/main', padding: 'x'.repeat(2 * 1024 * 1024) })
    const { res, statusCode } = makeRes()
    await server.handle(makeReq({ headers: { 'x-github-event': 'push' }, body: bigBody }), res)
    expect(statusCode()).toBe(413)
    expect(onSync).not.toHaveBeenCalled()
  })

  it('签名无效返回 401', async () => {
    const server = new WebhookServer(makeConfig(), { onSync })
    const { res, statusCode } = makeRes()
    await server.handle(makeReq({
      headers: { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=deadbeef' },
      body: PUSH_BODY,
    }), res)
    expect(statusCode()).toBe(401)
  })

  it('空 secret 时即使带正确格式签名头也返回 401', async () => {
    const server = new WebhookServer(makeConfig({ secret: '' }), { onSync })
    const { res, statusCode } = makeRes()
    await server.handle(makeReq({ headers: signedGitHubHeaders(PUSH_BODY), body: PUSH_BODY }), res)
    expect(statusCode()).toBe(401)
  })

  it('JSON 非法返回 400', async () => {
    const server = new WebhookServer(makeConfig(), { onSync })
    const broken = '{not json'
    const { res, statusCode } = makeRes()
    await server.handle(makeReq({ headers: signedGitHubHeaders(broken), body: broken }), res)
    expect(statusCode()).toBe(400)
  })

  it('非触发分支返回 200 accepted:false 且不触发同步', async () => {
    const server = new WebhookServer(makeConfig(), { onSync })
    const body = JSON.stringify({ ref: 'refs/heads/dev' })
    const { res, statusCode, json } = makeRes()
    await server.handle(makeReq({ headers: signedGitHubHeaders(body), body }), res)
    expect(statusCode()).toBe(200)
    expect(json()).toEqual({ accepted: false, reason: '非触发分支: dev' })
    expect(onSync).not.toHaveBeenCalled()
  })

  it('onSync 失败被捕获并记录，响应仍是 202', async () => {
    onSync.mockRejectedValue(new Error('同步炸了'))
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})
    const server = new WebhookServer(makeConfig(), { onSync })
    const { res, statusCode } = makeRes()
    await server.handle(makeReq({ headers: signedGitHubHeaders(PUSH_BODY), body: PUSH_BODY }), res)
    expect(statusCode()).toBe(202)
    expect(onSync.mock.calls[0][0]).toMatchObject({ accepted: true })
    await flushAsync()
    expect(errorSpy).toHaveBeenCalled()
    const message = errorSpy.mock.calls[0][0]
    expect(message).toContain('同步炸了')
    expect(message).not.toContain(SECRET)
    errorSpy.mockRestore()
  })
})

describe('webhookServer 生命周期', () => {
  it('start 返回实际端口，可接收真实请求；stop 幂等且释放句柄', async () => {
    const onSync = jest.fn().mockResolvedValue(undefined)
    const server = new WebhookServer(makeConfig({ port: 0 }), { onSync })

    await expect(server.stop()).resolves.toBeUndefined()

    const { port } = await server.start()
    expect(Number.isInteger(port) && port > 0).toBe(true)

    const body = PUSH_BODY
    const headers = signedGitHubHeaders(body)
    const response = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', headers, body })
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ accepted: true })
    await flushAsync()
    expect(onSync).toHaveBeenCalledTimes(1)

    await server.stop()
    await server.stop()
  })
})
