import type { WebhookPlatform } from '../domain/webhook'
import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * verifySignature 的可选行为开关
 */
export interface VerifySignatureOptions {
  /**
   * 仅对 gitea 生效：额外接受旧版 `x-hub-signature: sha1=<hmac>`。
   * GitHub/Bitbucket 的旧版 sha1 一律拒绝。
   */
  allowLegacySha1?: boolean
}

/**
 * 读取请求头（大小写不敏感，数组取第一个值）。
 * 供签名校验、事件归一化与服务器平台探测共用。
 */
export function getHeader(headers: NodeJS.Dict<string | string[]> | undefined, name: string): string | undefined {
  if (!headers)
    return undefined
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value))
    return value[0]
  return value
}

/**
 * 计算 hex 形式的 HMAC 摘要
 */
function hmacHex(algorithm: 'sha1' | 'sha256', secret: string, rawBody: Buffer): string {
  return createHmac(algorithm, secret).update(rawBody).digest('hex')
}

/**
 * 使用 timingSafeEqual 的定长安全字符串比较；长度不同直接判定失败
 */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length)
    return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * 按平台校验 webhook 签名/token。
 * 所有密钥比较均走 crypto.timingSafeEqual；失败原因绝不回显 secret。
 */
export function verifySignature(
  platform: WebhookPlatform,
  rawBody: Buffer,
  headers: NodeJS.Dict<string | string[]>,
  secret: string,
  options: VerifySignatureOptions = {},
): { ok: boolean, reason?: string } {
  if (!secret) {
    return { ok: false, reason: '未配置 webhook secret，无法校验签名' }
  }

  switch (platform) {
    case 'github':
    case 'gitea': {
      const signature = getHeader(headers, 'x-hub-signature-256')
      if (signature) {
        if (!signature.startsWith('sha256=')) {
          return { ok: false, reason: '签名头格式错误，期望 sha256=<hmac>' }
        }
        const expected = `sha256=${hmacHex('sha256', secret, rawBody)}`
        if (timingSafeCompare(signature, expected)) {
          return { ok: true }
        }
      }
      // Gitea 可选择性兼容旧版 sha1 签名（sha256 头缺失或不匹配时回退）
      if (platform === 'gitea' && options.allowLegacySha1) {
        const legacy = getHeader(headers, 'x-hub-signature')
        if (legacy && legacy.startsWith('sha1=')) {
          const expectedLegacy = `sha1=${hmacHex('sha1', secret, rawBody)}`
          if (timingSafeCompare(legacy, expectedLegacy)) {
            return { ok: true }
          }
        }
      }
      return {
        ok: false,
        reason: signature ? '签名校验失败' : `缺少签名头 x-hub-signature-256 (platform=${platform})`,
      }
    }
    case 'gitlab': {
      const token = getHeader(headers, 'x-gitlab-token')
      if (!token) {
        return { ok: false, reason: '缺少签名头 x-gitlab-token' }
      }
      if (!timingSafeCompare(token, secret)) {
        return { ok: false, reason: 'GitLab token 校验失败' }
      }
      return { ok: true }
    }
    case 'bitbucket': {
      const signature = getHeader(headers, 'x-hub-signature')
      if (!signature) {
        return { ok: false, reason: '缺少签名头 x-hub-signature' }
      }
      if (!signature.startsWith('sha256=')) {
        return { ok: false, reason: '签名头格式错误，期望 sha256=<hmac>' }
      }
      const expected = `sha256=${hmacHex('sha256', secret, rawBody)}`
      if (!timingSafeCompare(signature, expected)) {
        return { ok: false, reason: '签名校验失败' }
      }
      return { ok: true }
    }
    default:
      return { ok: false, reason: `不支持的 webhook 平台: ${String(platform)}` }
  }
}
