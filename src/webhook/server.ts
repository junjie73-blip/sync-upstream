import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { WebhookConfig, WebhookDelivery, WebhookPlatform } from '../domain/webhook'
import type { DeliveryDecision, DeliveryRecord } from './delivery-log'
import type { NormalizedDelivery } from './normalize'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { toError } from '../errors'
import { t } from '../i18n'
import { logger } from '../logger'
import { shouldTriggerSync } from './filters'
import { normalizeDelivery } from './normalize'
import { isIpAllowed, TokenBucket } from './rate-limit'
import { SeenStore } from './seen-store'
import { getHeader, verifySignature } from './signature'

/** 请求体默认上限：1 MiB，超限直接 413，防止内存被打爆 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** How many past delivery ids to remember for de-duplication. */
const SEEN_LIMIT = 512

/** How many syncs may wait for the repository lock before the daemon starts refusing. */
const DEFAULT_MAX_QUEUE = 8

export interface WebhookServerDeps {
  /** 过滤通过后异步执行的同步任务；失败会被捕获记录，不影响响应 */
  onSync: (delivery: WebhookDelivery) => Promise<void>
  /**
   * Every decision, in order, before and after the sync it started. The daemon keeps answering the
   * platform on its own schedule; this is what lets somebody read what happened afterwards.
   * Returns an error message when recording failed — the delivery is answered regardless, because a
   * broken audit file is not the platform's problem.
   */
  onDelivery?: (record: DeliveryRecord) => string | undefined
}

/** Provider-specific delivery GUID, if any. GitHub and Gitea both send one. */
export function deliveryIdOf(headers: NodeJS.Dict<string | string[]>): string | undefined {
  return getHeader(headers, 'x-github-delivery')
    ?? getHeader(headers, 'x-gitea-delivery')
    ?? getHeader(headers, 'x-request-id')
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
  /** Syncs started but not finished; `stop()` waits for these so SIGTERM cannot cut a commit in half. */
  private readonly inFlight = new Set<Promise<void>>()
  /** Recently handled delivery ids, oldest first, for provider redeliveries. */
  private readonly seen: SeenStore
  /** Running totals, reported by the health probe and the audit trail. */
  private readonly counts: Record<DeliveryDecision, number> = { accepted: 0, ignored: 0, rejected: 0, synced: 0, failed: 0 }
  private lastDelivery?: DeliveryRecord
  private startedAt?: number
  private closing = false

  constructor(config: WebhookConfig, deps: WebhookServerDeps) {
    this.config = config
    this.deps = deps
    this.seen = new SeenStore(config.seenHistory ?? SEEN_LIMIT, this.seenStateFile)
  }

  /** Bind address in use: loopback unless the operator explicitly opens it up. */
  private get host(): string {
    return this.config.host ?? '127.0.0.1'
  }

  /** Where handled delivery ids survive a restart; without it the set is process-local. */
  private get seenStateFile(): string | undefined {
    if (this.config.seenStateFile)
      return this.config.seenStateFile
    return this.config.deliveryLog ? `${this.config.deliveryLog}.seen.json` : undefined
  }

  /** How many syncs may queue for the repository lock before new deliveries get refused. */
  private get maxQueue(): number {
    return this.config.maxQueue && this.config.maxQueue > 0 ? this.config.maxQueue : DEFAULT_MAX_QUEUE
  }

  private get maxBodyBytes(): number {
    return this.config.maxBodyBytes && this.config.maxBodyBytes > 0
      ? this.config.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES
  }

  /**
   * 启动监听，返回实际绑定的地址与端口（config.port 为 0 时取系统分配端口）。
   * `host` 一并交出去，调用方才不会把"绑在 127.0.0.1"打印成"0.0.0.0"。
   */
  async start(): Promise<{ port: number, host: string, secure: boolean }> {
    if (this.server) {
      const address = this.server.address()
      return {
        port: typeof address === 'object' && address ? address.port : this.config.port,
        host: this.host,
        secure: Boolean(this.config.tlsCert),
      }
    }
    const secure = Boolean(this.config.tlsCert && this.config.tlsKey)
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      // handle 内部已捕获全部异常路径，这里兜底避免进程崩溃
      this.handle(req, res).catch((error: unknown) => {
        logger.error(`Webhook 请求处理异常: ${toError(error).message}`, toError(error))
        if (!res.headersSent)
          sendJson(res, 500, { error: '内部错误' })
      })
    }
    const server = secure
      ? createHttpsServer(
          {
            cert: readFileSync(this.config.tlsCert as string),
            key: readFileSync(this.config.tlsKey as string),
          },
          handler,
        )
      : createHttpServer(handler)
    server.on('error', (error: Error) => {
      logger.error(`Webhook 服务器错误: ${error.message}`, error)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port, this.host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
    this.closing = false
    this.startedAt = Date.now()
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : this.config.port
    // 不打横幅：监听地址归调用方（守护进程）呈现，否则同一行会在控制台出现两遍。
    return { port, host: this.host, secure }
  }

  /**
   * Promise that settles once every started sync has finished.
   */
  async pendingSyncs(): Promise<void> {
    while (this.inFlight.size > 0)
      await Promise.allSettled([...this.inFlight])
  }

  /**
   * 幂等关闭：先停止接收，再等待在途同步跑完，最后释放监听句柄。
   * 直接 close 会让一次提交做到一半的同步被进程退出打断。
   */
  async stop(): Promise<void> {
    this.closing = true
    const server = this.server
    if (server) {
      this.server = null
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
      logger.info('Webhook 监听已关闭，等待在途同步完成…')
    }
    await this.pendingSyncs()
    if (server)
      logger.success('Webhook 服务器已停止')
  }

  /** Health probe path, `false` disables it. */
  private get healthPath(): string | false {
    return this.config.healthPath === undefined ? '/healthz' : this.config.healthPath
  }

  /** True when this delivery id was already handled (and records it). */
  private alreadySeen(id: string | undefined): boolean {
    if (!id || this.config.deduplicate === false)
      return false
    const duplicate = this.seen.mark(id)
    if (this.seen.lastError)
      logger.warn(this.seen.lastError)
    return duplicate
  }

  /**
   * Answer and record in one move, so no branch of `handle()` can reply without leaving a trace.
   * `decision` is what the operator cares about; `status` is what the platform saw.
   */
  private answer(res: ServerResponse, status: number, body: Record<string, unknown>, record: Omit<DeliveryRecord, 'at'>): void {
    const entry: DeliveryRecord = { ...record, status, at: new Date().toISOString() }
    this.counts[entry.decision] += 1
    this.lastDelivery = entry
    const failure = this.deps.onDelivery?.(entry)
    // The platform still gets its answer: a broken audit file is not the sender's problem, and
    // making them redeliver for that would turn a disk hiccup into a sync storm.
    if (failure)
      logger.warn(failure)
    sendJson(res, status, body)
  }

  /**
   * 处理单个请求。公开方法，测试可直接注入 req/res 而不必经过 socket。
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = getPathname(req.url)

    // 0. 存活探针：负载均衡与容器编排需要不需要密钥就能问一句"你还活着吗"
    const health = this.healthPath
    if (health && pathname === health && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, this.closing ? 503 : 200, {
        status: this.closing ? 'shutting-down' : 'ok',
        running: this.inFlight.size,
        maxQueue: this.maxQueue,
        uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
        counts: { ...this.counts },
        // "最后一次投递是什么时候、当时怎么决定的" —— 探针回答不了的问题，这个字段能回答一半。
        lastDelivery: this.lastDelivery ? { at: this.lastDelivery.at, decision: this.lastDelivery.decision, branch: this.lastDelivery.branch } : undefined,
        dedupe: this.seen.size,
      })
      return
    }

    if (this.closing) {
      sendJson(res, 503, { error: '服务正在退出，请重新投递' })
      return
    }

    // 1. 路由：仅接受 POST config.path
    if (pathname !== this.config.path) {
      sendJson(res, 404, { error: 'Not Found' })
      return
    }
    if (req.method !== 'POST') {
      this.answer(res, 405, { error: 'Method Not Allowed，仅支持 POST' }, { decision: 'rejected', reason: `方法不允许: ${req.method}` })
      return
    }

    // 2. IP 白名单
    const clientIp = this.getClientIp(req)
    if (!isIpAllowed(clientIp, this.config.securityConfig?.ipWhitelist ?? [])) {
      logger.warn(`Webhook 请求被拒绝: IP 不在白名单 - ${clientIp}`)
      this.answer(res, 403, { error: 'Forbidden: IP 不在白名单中' }, { decision: 'rejected', reason: 'IP 不在白名单', ip: clientIp })
      return
    }

    // 3. 限流
    const rateLimit = this.config.securityConfig?.rateLimit
    if (rateLimit && rateLimit.maxRequestsPerSecond > 0) {
      this.bucket ??= new TokenBucket(rateLimit.maxRequestsPerSecond)
      if (!this.bucket.take(clientIp)) {
        logger.warn(`Webhook 请求被拒绝: 超出限流 - ${clientIp}`)
        const message = rateLimit.message || '请求过于频繁，请稍后重试'
        this.answer(res, rateLimit.statusCode || 429, { error: message }, { decision: 'rejected', reason: `限流: ${message}`, ip: clientIp })
        return
      }
    }

    // 4. 读取请求体（maxBodyBytes 上限）
    let raw: { body: Buffer, tooLarge: boolean }
    try {
      raw = await readRawBody(req, this.maxBodyBytes)
    }
    catch (error) {
      logger.warn(`Webhook 请求体读取失败: ${toError(error).message}`)
      this.answer(res, 400, { error: '读取请求体失败' }, { decision: 'rejected', reason: '请求体读取失败', ip: clientIp })
      return
    }
    if (raw.tooLarge) {
      req.destroy()
      const reason = `请求体超过 ${this.maxBodyBytes} 字节上限`
      this.answer(res, 413, { error: reason }, { decision: 'rejected', reason, ip: clientIp })
      return
    }

    // 5. 平台识别 + 签名校验（空 secret 一律拒绝）
    const platform = this.detectPlatform(req.headers)
    if (!platform) {
      this.answer(res, 401, { error: '无法识别 webhook 平台，缺少平台标识头' }, { decision: 'rejected', reason: '缺少平台标识头', ip: clientIp })
      return
    }
    const signatureResult = verifySignature(platform, raw.body, req.headers ?? {}, this.config.secret)
    if (!signatureResult.ok) {
      logger.warn(`Webhook 请求被拒绝: ${signatureResult.reason ?? '签名无效'} (platform=${platform})`)
      // The reason never carries the secret; see `verifySignature`.
      this.answer(res, 401, { error: signatureResult.reason ?? '签名校验失败' }, { decision: 'rejected', reason: signatureResult.reason ?? '签名校验失败', platform, ip: clientIp, deliveryId: deliveryIdOf(req.headers ?? {}) })
      return
    }

    // 6. 安全解析 JSON
    let payload: Record<string, any>
    try {
      const parsed: unknown = JSON.parse(raw.body.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(t('e.webhookJsonTopObject'))
      }
      payload = parsed as Record<string, any>
    }
    catch {
      this.answer(res, 400, { error: '无效的 JSON 请求体' }, { decision: 'rejected', reason: 'JSON 解析失败', platform, ip: clientIp })
      return
    }

    // 7. 归一化 + 事件过滤
    const normalized: NormalizedDelivery = normalizeDelivery(platform, payload, req.headers ?? {})
    const filterResult = shouldTriggerSync(this.config, normalized, payload)
    if (!filterResult.accept) {
      logger.info(`Webhook 事件未触发同步: ${filterResult.reason}`)
      this.answer(res, 200, { accepted: false, reason: filterResult.reason }, { decision: 'ignored', reason: filterResult.reason, platform, event: normalized.event, branch: normalized.branch, ip: clientIp, deliveryId: deliveryIdOf(req.headers ?? {}) })
      return
    }

    // 7.5 重复投递：provider 超时重发同一个 delivery id 时，第二次直接确认不再同步一遍
    const deliveryId = deliveryIdOf(req.headers ?? {})
    if (this.alreadySeen(deliveryId)) {
      logger.info(`投递 ${deliveryId} 已处理过，跳过重复同步`)
      this.answer(res, 200, { accepted: false, reason: `重复投递: ${deliveryId}` }, { decision: 'ignored', reason: `重复投递: ${deliveryId}`, platform, event: normalized.event, branch: normalized.branch, ip: clientIp, deliveryId })
      return
    }

    // 7.6 队列已满：同步会被仓库锁串起来，排不下的投递与其默默等，不如让平台稍后重投
    if (this.inFlight.size >= this.maxQueue) {
      const reason = `同步队列已满（${this.inFlight.size}/${this.maxQueue}），请稍后重新投递`
      logger.warn(`Webhook 请求被拒绝: ${reason}`)
      this.answer(res, 503, { error: reason }, { decision: 'rejected', reason, platform, event: normalized.event, branch: normalized.branch, ip: clientIp, deliveryId })
      return
    }

    // 8. 立即 202 应答，onSync 异步执行且不阻塞响应
    const delivery: WebhookDelivery = {
      platform,
      event: normalized.event,
      branch: normalized.branch,
      accepted: true,
      deliveryId,
    }
    this.answer(res, 202, { accepted: true }, { decision: 'accepted', platform, event: normalized.event, branch: normalized.branch, ip: clientIp, deliveryId })
    this.runSync(delivery)
  }

  /**
   * 异步触发同步：捕获所有失败并记录到投递结果，绝不抛出未处理拒绝。
   * 在途任务被登记，`stop()` 会等它们结束。
   */
  private runSync(delivery: WebhookDelivery): void {
    const startedAt = Date.now()
    /** 一次同步的成败要写在审计里：202 只说明"收到了"，运维要的是"最后同步成功了吗"。 */
    const outcome = (decision: 'synced' | 'failed', reason?: string) => {
      const record: DeliveryRecord = {
        decision,
        platform: delivery.platform,
        event: delivery.event,
        branch: delivery.branch,
        ...(delivery.deliveryId ? { deliveryId: delivery.deliveryId } : {}),
        durationMs: Date.now() - startedAt,
        ...(reason ? { reason } : {}),
        at: new Date().toISOString(),
      }
      this.counts[decision] += 1
      this.lastDelivery = record
      const failure = this.deps.onDelivery?.(record)
      if (failure)
        logger.warn(failure)
    }
    // 传入副本：失败记录写入内部结果时不影响已交付给 onSync 的 accepted 语义
    const task = this.deps.onSync({ ...delivery })
      .then(() => {
        logger.success(`Webhook 触发的同步完成: ${delivery.event} @ ${delivery.branch}`)
        outcome('synced')
      })
      .catch((error: unknown) => {
        const message = toError(error).message
        logger.error(`Webhook 触发的同步失败: ${message}`, toError(error), {
          platform: delivery.platform,
          event: delivery.event,
          branch: delivery.branch,
          accepted: delivery.accepted,
        })
        outcome('failed', message)
      })
    this.inFlight.add(task)
    void task.then(() => {
      this.inFlight.delete(task)
    })
  }

  /**
   * 客户端 IP：仅显式开启 trustProxy 时才看 x-forwarded-for 首跳，否则任何调用方
   * 都能伪造一个白名单地址绕过 `ipWhitelist` 与按 IP 的限流。
   */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = getHeader(req.headers, 'x-forwarded-for')
    if (forwarded && this.config.trustProxy)
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
