import { logger } from '../logger'

interface BucketState {
  tokens: number
  lastRefill: number
}

/**
 * 按 key 隔离的令牌桶限流器。
 * 采用惰性补充（take 时按时间差计算 token），内部不注册任何定时器，
 * 因此不会阻塞进程退出；闲置 key 由调用方择机通过 sweep() 清理。
 */
export class TokenBucket {
  private readonly capacity: number
  private readonly refillPerSecond: number
  private readonly buckets = new Map<string, BucketState>()

  constructor(maxPerSecond: number) {
    this.refillPerSecond = Math.max(0, maxPerSecond)
    this.capacity = this.refillPerSecond
  }

  /**
   * 取走一个令牌；桶不足时返回 false。空桶初始为满桶。
   */
  take(key: string): boolean {
    if (this.capacity <= 0)
      return false
    const now = Date.now()
    const state = this.buckets.get(key)
    if (!state) {
      this.buckets.set(key, { tokens: this.capacity - 1, lastRefill: now })
      return true
    }
    const elapsedMs = Math.max(0, now - state.lastRefill)
    state.tokens = Math.min(this.capacity, state.tokens + (elapsedMs / 1000) * this.refillPerSecond)
    state.lastRefill = now
    if (state.tokens < 1)
      return false
    state.tokens -= 1
    return true
  }

  /**
   * 清理超过 idleMs（默认 60s）未活动的 key，返回被清理的数量
   */
  sweep(idleMs = 60_000): number {
    const now = Date.now()
    let removed = 0
    for (const [key, state] of this.buckets) {
      if (now - state.lastRefill >= idleMs) {
        this.buckets.delete(key)
        removed += 1
      }
    }
    return removed
  }
}

/**
 * IPv4 点分十进制转 32 位无符号整数；非法输入返回 null
 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4)
    return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part))
      return null
    const octet = Number(part)
    if (octet > 255)
      return null
    value = ((value << 8) | octet) >>> 0
  }
  return value >>> 0
}

/**
 * 单条白名单匹配：CIDR 用整数位运算，其余按字符串精确比较（兼容 IPv6 字面量）
 */
function matchEntry(clientIp: string, entry: string): boolean {
  if (!entry.includes('/'))
    return entry === clientIp

  const separator = entry.lastIndexOf('/')
  const network = entry.slice(0, separator)
  const bits = Number(entry.slice(separator + 1))
  const networkInt = ipv4ToInt(network)
  if (networkInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    logger.warn(`忽略非法的 IP 白名单 CIDR 条目: ${entry}`)
    return false
  }
  const clientInt = ipv4ToInt(clientIp)
  if (clientInt === null)
    return false
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
  return (clientInt & mask) >>> 0 === (networkInt & mask) >>> 0
}

/**
 * IP 准入判断：白名单为空时放行所有；支持精确 IPv4/IPv6 与 IPv4 CIDR。
 * 非法 CIDR 条目记录 warn 并忽略，不影响其余条目。
 */
export function isIpAllowed(clientIp: string, whitelist: string[]): boolean {
  if (!whitelist || whitelist.length === 0)
    return true
  return whitelist.some(entry => matchEntry(clientIp, entry))
}
