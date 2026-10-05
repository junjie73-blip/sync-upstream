import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { WebhookConfig, WebhookDelivery, WebhookPlatform } from '../domain/webhook'
import type { NormalizedDelivery } from './normalize'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { toError } from '../errors'
import { logger } from '../logger'
import { shouldTriggerSync } from './filters'
import { normalizeDelivery } from './normalize'
import { isIpAllowed, TokenBucket } from './rate-limit'
import { getHeader, verifySignature } from './signature'

/** 请求体上限：1 MiB，超限直接 413，防止内存被打爆 */
const MAX_BODY_BYTES = 1024 * 1024

export interface WebhookServerDeps {
  /** 过滤通过后异步执行的同步任务；失败会被捕获记录，不影响响应 */
  onSync: (delivery: WebhookDelivery) => Promise<void>
}

/**
 * 读取请求体为 Buffer，超过 maxBytes 时提前结束并标记 tooLarge
 */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<{ body: Buffer, tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const onData = (chunk: Buffer | string) => {
      if (settled)
        return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      chunks.push(buf)
      size += buf.length
      if (size > maxBytes) {
        settled = true
        detach()
        resolve({ body: Buffer.concat(chunks), tooLarge: true })
      }
    }
    const onEnd = () => {
      if (settled)
        return
      settled = true
      detach()
      resolve({ body: Buffer.concat(chunks), tooLarge: false })
    }
    const onError = (error: unknown) => {
      if (settled)
        return
      settled = true
      detach()
      reject(toError(error))
    }
    function detach() {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/**
 * 解析请求路径；URL 非法时返回 undefined（按 404 处理）
 */
function getPathname(url: string | undefined): string | undefined {
  if (!url)
    return undefined
  try {
    return new URL(url, 'http://localhost').pathname
  }
  catch {
    return undefined
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Webhook 接收服务器：HTTP 传输 + 安全校验 + 事件过滤的编排层。
 * 各单项能力拆分在 signature/normalize/filters/rate-limit 模块中，本类只负责组装。
 */
export class WebhookServer {
  private readonly config: WebhookConfig
  private readonly deps: WebhookServerDeps
  private server: Server | null = null
  private bucket: TokenBucket | null = null

  constructor(config: WebhookConfig, deps: WebhookServerDeps) {
    this.config = config
    this.deps = deps
  }

  /**
   * 启动监听，返回实际端口（config.port 为 0 时取系统分配端口）
   */
  async start(): Promise<{ port: number }> {
    if (this.server) {
      const address = this.server.address()
      return { port: typeof address === 'object' && address ? address.port : this.config.port }
    }
    const server = createServer((req, res) => {
      // handle 内部已捕获全部异常路径，这里兜底避免进程崩溃
      this.handle(req, res).catch((error: unknown) => {
        logger.error(`Webhook 请求处理异常: ${toError(error).message}`, toError(error))
        if (!res.headersSent)
          sendJson(res, 500, { error: '内部错误' })
      })
    })
    server.on('error', (error: Error) => {
      logger.error(`Webhook 服务器错误: ${error.message}`, error)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : this.config.port
    logger.success(`Webhook 服务器已启动，端口: ${port}，路径: ${this.config.path}`)
    return { port }
  }

  /**
   * 幂等关闭：重复调用安全，关闭后释放监听句柄，不会挂住进程
   */
  async stop(): Promise<void> {
    const server = this.server
    if (!server)
      return
    this.server = null
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    logger.success('Webhook 服务器已停止')
  }

  /**
   * 处理单个请求。公开方法，测试可直接注入 req/res 而不必经过 socket。
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. 路由：仅接受 POST config.path
    const pathname = getPathname(req.url)
    if (pathname !== this.config.path) {
      sendJson(res, 404, { error: 'Not Found' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed，仅支持 POST' })
      return
    }

    // 2. IP 白名单
    const clientIp = this.getClientIp(req)
    if (!isIpAllowed(clientIp, this.config.securityConfig?.ipWhitelist ?? [])) {
      logger.warn(`Webhook 请求被拒绝: IP 不在白名单 - ${clientIp}`)
      sendJson(res, 403, { error: 'Forbidden: IP 不在白名单中' })
      return
    }

    // 3. 限流
    const rateLimit = this.config.securityConfig?.rateLimit
    if (rateLimit && rateLimit.maxRequestsPerSecond > 0) {
      this.bucket ??= new TokenBucket(rateLimit.maxRequestsPerSecond)
      if (!this.bucket.take(clientIp)) {
        logger.warn(`Webhook 请求被拒绝: 超出限流 - ${clientIp}`)
        sendJson(res, rateLimit.statusCode || 429, { error: rateLimit.message || '请求过于频繁，请稍后重试' })
        return
      }
    }

    // 4. 读取请求体（1 MiB 上限）
    let raw: { body: Buffer, tooLarge: boolean }
    try {
      raw = await readRawBody(req, MAX_BODY_BYTES)
    }
    catch (error) {
      logger.warn(`Webhook 请求体读取失败: ${toError(error).message}`)
      sendJson(res, 400, { error: '读取请求体失败' })
      return
    }
    if (raw.tooLarge) {
      req.destroy()
      sendJson(res, 413, { error: `请求体超过 ${MAX_BODY_BYTES} 字节上限` })
      return
    }

    // 5. 平台识别 + 签名校验（空 secret 一律拒绝）
    const platform = this.detectPlatform(req.headers)
    if (!platform) {
      sendJson(res, 401, { error: '无法识别 webhook 平台，缺少平台标识头' })
      return
    }
    const signatureResult = verifySignature(platform, raw.body, req.headers ?? {}, this.config.secret)
    if (!signatureResult.ok) {
      logger.warn(`Webhook 请求被拒绝: ${signatureResult.reason ?? '签名无效'} (platform=${platform})`)
      sendJson(res, 401, { error: signatureResult.reason ?? '签名校验失败' })
      return
    }

    // 6. 安全解析 JSON
    let payload: Record<string, any>
    try {
      const parsed: unknown = JSON.parse(raw.body.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('顶层必须是 JSON 对象')
      }
      payload = parsed as Record<string, any>
    }
    catch {
      sendJson(res, 400, { error: '无效的 JSON 请求体' })
      return
    }

    // 7. 归一化 + 事件过滤
    const normalized: NormalizedDelivery = normalizeDelivery(platform, payload, req.headers ?? {})
    const filterResult = shouldTriggerSync(this.config, normalized, payload)
    if (!filterResult.accept) {
      logger.info(`Webhook 事件未触发同步: ${filterResult.reason}`)
      sendJson(res, 200, { accepted: false, reason: filterResult.reason })
      return
    }

    // 8. 立即 202 应答，onSync 异步执行且不阻塞响应
    const delivery: WebhookDelivery = {
      platform,
      event: normalized.event,
      branch: normalized.branch,
      accepted: true,
    }
    sendJson(res, 202, { accepted: true })
    this.runSync(delivery)
  }

  /**
   * 异步触发同步：捕获所有失败并记录到投递结果，绝不抛出未处理拒绝
   */
  private runSync(delivery: WebhookDelivery): void {
    // 传入副本：失败记录写入内部结果时不影响已交付给 onSync 的 accepted 语义
    this.deps.onSync({ ...delivery })
      .then(() => {
        logger.success(`Webhook 触发的同步完成: ${delivery.event} @ ${delivery.branch}`)
      })
      .catch((error: unknown) => {
        const message = toError(error).message
        logger.error(`Webhook 触发的同步失败: ${message}`, toError(error), {
          platform: delivery.platform,
          event: delivery.event,
          branch: delivery.branch,
          accepted: delivery.accepted,
        })
      })
  }

  /**
   * 客户端 IP：优先 x-forwarded-for 首跳，其次 socket；去掉 IPv4-mapped IPv6 前缀
   */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = getHeader(req.headers, 'x-forwarded-for')
    if (forwarded)
      return normalizeIp(forwarded.split(',')[0].trim())
    return normalizeIp(req.socket?.remoteAddress || 'unknown')
  }

  /**
   * 通过平台标识头识别来源平台；无法识别且仅配置了一个平台时按该处理
   */
  private detectPlatform(headers: NodeJS.Dict<string | string[]>): WebhookPlatform | null {
    if (getHeader(headers, 'x-github-event'))
      return 'github'
    if (getHeader(headers, 'x-gitea-event'))
      return 'gitea'
    if (getHeader(headers, 'x-gitlab-event') || getHeader(headers, 'x-gitlab-token'))
      return 'gitlab'
    if (getHeader(headers, 'x-event-key'))
      return 'bitbucket'
    const supported = this.config.supportedPlatforms ?? []
    return supported.length === 1 ? supported[0] : null
  }
}

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip
}

/**
 * 工厂函数：创建（但不启动）Webhook 服务器
 */
export function createWebhookServer(config: WebhookConfig, deps: WebhookServerDeps): WebhookServer {
  return new WebhookServer(config, deps)
}
