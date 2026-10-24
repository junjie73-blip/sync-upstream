import type { NotifyConfig, NotifyEvent, NotifyResult } from '../domain'
import crypto from 'node:crypto'
import { createLimit } from '../concurrency'
import { NotifyChannel } from '../domain'
import { toError } from '../errors'
import { logger } from '../logger'
import { eventPlaceholders, renderEvent } from './render'

export type { NotifyEvent, NotifyResult } from '../domain'
export { eventFromFailure, eventFromRun, eventFromUndo, notifyEnabled } from './event'
export { eventPlaceholders, renderEvent } from './render'

interface Prepared {
  url: string
  body: string
  headers: Record<string, string>
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

/** DingTalk robots reject unsigned requests once 加签 is enabled on the robot. */
function signedDingtalkUrl(url: string, secret: string): string {
  const timestamp = Date.now()
  const sign = crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
  return `${url}${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
}

function urlFor(channel: NotifyChannel, config: NotifyConfig): string | undefined {
  switch (channel) {
    case NotifyChannel.HTTP:
      return config.url
    case NotifyChannel.SLACK:
      return config.slackUrl
    case NotifyChannel.DINGTALK:
      return config.dingtalkUrl
    case NotifyChannel.WECOM:
      return config.wecomUrl
    default:
      return undefined
  }
}

/**
 * Chat providers accept text; the generic HTTP channel also gets the structured event so a
 * dashboard can consume notifications without parsing a sentence.
 */
function bodyFor(channel: NotifyChannel, event: NotifyEvent, config: NotifyConfig): string {
  const text = renderEvent(event, config.template, config.includeDetails !== false)
  switch (channel) {
    case NotifyChannel.SLACK:
      return JSON.stringify({ text })
    case NotifyChannel.DINGTALK:
    case NotifyChannel.WECOM:
      return JSON.stringify({ msgtype: 'text', text: { content: text } })
    case NotifyChannel.HTTP:
      return JSON.stringify({ text, event, fields: eventPlaceholders(event) })
    default:
      return text
  }
}

function providerError(status: number, body: string): string | undefined {
  // Slack/钉钉/企业微信 answer 200 for a rejected payload; the verdict is in the body.
  if (body.trim() === '')
    return status >= 200 && status < 300 ? undefined : `HTTP ${status}`
  let parsed: { errcode?: number, errmsg?: string, message?: string }
  try {
    parsed = JSON.parse(body)
  }
  catch {
    return status >= 200 && status < 300 ? undefined : `HTTP ${status}: ${body.slice(0, 200)}`
  }
  if (typeof parsed.errcode === 'number' && parsed.errcode !== 0)
    return `errcode ${parsed.errcode}: ${parsed.errmsg ?? '(无描述)'}`
  if (status >= 200 && status < 300)
    return undefined
  return `HTTP ${status}: ${parsed.message ?? body.slice(0, 200)}`
}

async function post(request: Prepared, timeoutMs: number): Promise<{ status: number, body: string }> {
  if (typeof globalThis.fetch !== 'function')
    throw new TypeError('当前 Node 运行时没有 fetch，通知需要 Node 18 以上')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs))
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
    const body = await response.text().catch(() => '')
    return { status: response.status, body }
  }
  finally {
    clearTimeout(timer)
  }
}

async function attempt(request: Prepared, config: NotifyConfig): Promise<{ ok: boolean, status?: number, detail?: string }> {
  const { status, body } = await post(request, config.timeoutMs)
  const detail = providerError(status, body)
  return detail ? { status, ok: false, detail } : { status, ok: true }
}

function channelUrl(channel: NotifyChannel, config: NotifyConfig): { url?: string, skip?: string } {
  const url = urlFor(channel, config)
  if (!url)
    return { skip: '未配置该渠道的 URL' }
  if (!/^https?:\/\//i.test(url))
    return { skip: `URL 不是 http(s): ${url}` }
  if (channel === NotifyChannel.DINGTALK && config.dingtalkSecret)
    return { url: signedDingtalkUrl(url, config.dingtalkSecret) }
  if (channel === NotifyChannel.DINGTALK)
    logger.warn('钉钉通知未配置 dingtalkSecret：机器人开启加签时投递会被拒')
  return { url }
}

async function sendToChannel(channel: NotifyChannel, event: NotifyEvent, config: NotifyConfig): Promise<NotifyResult> {
  if (channel === NotifyChannel.STDOUT) {
    logger.info(`[通知] ${renderEvent(event, config.template, config.includeDetails !== false)}`)
    return { channel, ok: true, detail: '已写入日志', attempts: 1 }
  }

  const { url, skip } = channelUrl(channel, config)
  if (!url)
    return { channel, ok: false, detail: skip, attempts: 0 }

  const request: Prepared = {
    url,
    body: bodyFor(channel, event, config),
    headers: { ...JSON_HEADERS, ...(config.headers ?? {}) },
  }

  const tries = Math.max(1, config.retries)
  let attempts = 0
  let last: { ok: boolean, status?: number, detail?: string } = { ok: false, detail: '未尝试' }
  for (let index = 0; index < tries; index++) {
    attempts++
    try {
      last = await attempt(request, config)
      if (last.ok)
        return { channel, ok: true, status: last.status, attempts }
    }
    catch (error) {
      last = { ok: false, detail: toError(error).message }
    }
    if (index < tries - 1)
      await new Promise(resolve => setTimeout(resolve, config.retryConfig?.initialDelay ?? 500))
  }
  return { channel, ok: false, status: last.status, detail: last.detail, attempts }
}

/** Fan out to every configured channel; one dead endpoint cannot hide the others. */
export async function notifyEvent(event: NotifyEvent, config?: NotifyConfig): Promise<NotifyResult[]> {
  if (!config?.enable)
    return []
  const channels = config.channels && config.channels.length > 0 ? config.channels : [NotifyChannel.STDOUT]
  const limit = createLimit(Math.min(channels.length, 4))
  return Promise.all(channels.map(channel => limit(() => sendToChannel(channel, event, config))))
}

/** Log lines for the CLI: a notification that failed silently is a notification nobody got. */
export function formatNotifyResults(results: NotifyResult[]): string[] {
  return results.map((result) => {
    if (result.ok)
      return `通知 ${result.channel} 已投递${result.status ? ` (HTTP ${result.status})` : ''}`
    return `通知 ${result.channel} 失败: ${result.detail ?? '未知原因'}${result.attempts > 1 ? ` · 已重试 ${result.attempts} 次` : ''}`
  })
}

/** Never let a delivery problem change the outcome of a sync that worked. */
export async function notifySafely(event: NotifyEvent, config?: NotifyConfig): Promise<void> {
  try {
    const results = await notifyEvent(event, config)
    for (const line of formatNotifyResults(results)) {
      if (line.includes('失败'))
        logger.warn(line)
      else
        logger.verbose(line)
    }
  }
  catch (error) {
    logger.warn(`通知渠道异常: ${toError(error).message}`)
  }
}
