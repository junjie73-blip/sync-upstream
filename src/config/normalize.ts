import type { RawSyncConfig } from '../domain'
import { DEFAULT_CONFIG } from './defaults'

export interface AliasRule {
  /** Dotted destination path, e.g. `retryConfig.maxRetries`. */
  target: string
  kind?: 'number' | 'boolean' | 'string' | 'string[]'
}

/**
 * Historical and CLI-flavoured spellings accepted in config files. Without this a
 * typo like `targetBranch` silently fell back to the default branch.
 */
export const CONFIG_ALIASES: Record<string, AliasRule> = {
  repo: { target: 'upstreamRepo', kind: 'string' },
  upstreamUrl: { target: 'upstreamRepo', kind: 'string' },
  upstream: { target: 'upstreamRepo', kind: 'string' },
  branch: { target: 'upstreamBranch', kind: 'string' },
  upstreamRef: { target: 'upstreamBranch', kind: 'string' },
  targetBranch: { target: 'companyBranch', kind: 'string' },
  downstreamBranch: { target: 'companyBranch', kind: 'string' },
  baseBranch: { target: 'companyBranch', kind: 'string' },
  dirs: { target: 'syncDirs', kind: 'string[]' },
  syncDirectories: { target: 'syncDirs', kind: 'string[]' },
  directories: { target: 'syncDirs', kind: 'string[]' },
  message: { target: 'commitMessage', kind: 'string' },
  push: { target: 'autoPush', kind: 'boolean' },
  force: { target: 'forceOverwrite', kind: 'boolean' },
  fileTypes: { target: 'includeFileTypes', kind: 'string[]' },
  ignore: { target: 'ignorePatterns', kind: 'string[]' },
  maxParallelFiles: { target: 'concurrencyLimit', kind: 'number' },
  parallel: { target: 'concurrencyLimit', kind: 'number' },
  maxRetries: { target: 'retryConfig.maxRetries', kind: 'number' },
  retryMax: { target: 'retryConfig.maxRetries', kind: 'number' },
  initialRetryDelay: { target: 'retryConfig.initialDelay', kind: 'number' },
  retryDelay: { target: 'retryConfig.initialDelay', kind: 'number' },
  retryDelayFactor: { target: 'retryConfig.backoffFactor', kind: 'number' },
  retryBackoff: { target: 'retryConfig.backoffFactor', kind: 'number' },
  previewMode: { target: 'previewOnly', kind: 'boolean' },
  preview: { target: 'previewOnly', kind: 'boolean' },
  yes: { target: 'nonInteractive', kind: 'boolean' },
  grayRelease: { target: 'grayReleaseConfig' },
  conflictResolution: { target: 'conflictResolutionConfig' },
  webhook: { target: 'webhookConfig' },
  branchStrategy: { target: 'branchStrategyConfig' },
}

/** Keys the rewrite removed: reported instead of being silently dropped. */
export const REMOVED_KEYS: Record<string, string> = {
  cache: '缓存层已移除，同步判定直接使用 git blob oid',
  cacheConfig: '缓存层已移除，同步判定直接使用 git blob oid',
  adaptiveConcurrency: '并发数固定由 concurrencyLimit 控制',
}

export interface NormalizationResult {
  value: RawSyncConfig
  warnings: string[]
  errors: string[]
}

function setByPath(target: Record<string, any>, dottedPath: string, value: unknown) {
  const segments = dottedPath.split('.')
  let node = target
  for (const segment of segments.slice(0, -1)) {
    if (typeof node[segment] !== 'object' || node[segment] === null)
      node[segment] = {}
    node = node[segment]
  }
  const leaf = segments[segments.length - 1]
  node[leaf] = value
}

function getByPath(source: Record<string, any>, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<any>((node, segment) => {
    if (node && typeof node === 'object')
      return node[segment]
    return undefined
  }, source)
}

export function coerceValue(value: unknown, kind: AliasRule['kind'], key: string): { value?: unknown, error?: string } {
  if (value === undefined || value === null)
    return { value: undefined }
  switch (kind) {
    case 'number': {
      const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
      if (!Number.isFinite(num))
        return { error: `配置项 ${key} 需要数字，实际得到 ${JSON.stringify(value)}` }
      return { value: num }
    }
    case 'boolean': {
      if (typeof value === 'boolean')
        return { value }
      if (value === 'true' || value === '1')
        return { value: true }
      if (value === 'false' || value === '0')
        return { value: false }
      return { error: `配置项 ${key} 需要布尔值，实际得到 ${JSON.stringify(value)}` }
    }
    case 'string':
      return { value: String(value) }
    case 'string[]': {
      if (Array.isArray(value))
        return { value: value.map(String) }
      if (typeof value === 'string') {
        return { value: value.split(',').map(item => item.trim()).filter(Boolean) }
      }
      return { error: `配置项 ${key} 需要字符串数组，实际得到 ${JSON.stringify(value)}` }
    }
    default:
      return { value }
  }
}

/** Rewrite alias keys onto canonical config paths, collecting warnings and hard errors. */
export function normalizeConfigKeys(raw: Record<string, unknown>): NormalizationResult {
  const output: Record<string, unknown> = {}
  const warnings: string[] = []
  const errors: string[] = []

  for (const [key, value] of Object.entries(raw)) {
    if (key in REMOVED_KEYS) {
      warnings.push(`配置项 \`${key}\` 已废弃并被忽略：${REMOVED_KEYS[key]}`)
      continue
    }
    const alias = CONFIG_ALIASES[key]
    if (alias) {
      const coerced = coerceValue(value, alias.kind, key)
      if (coerced.error) {
        errors.push(coerced.error)
        continue
      }
      warnings.push(`配置项 \`${key}\` 是 \`${alias.target}\` 的别名，已自动转换`)
      setByPath(output, alias.target, coerced.value)
      continue
    }
    output[key] = value
  }

  return { value: output as RawSyncConfig, warnings, errors }
}

/** Canonical top-level keys, so a correctly spelled option is never reported as a typo. */
export const CANONICAL_KEYS = new Set<string>(Object.keys(DEFAULT_CONFIG))

export function isKnownKey(key: string): boolean {
  return key in CONFIG_ALIASES || CANONICAL_KEYS.has(key)
}

export function unknownKeys(raw: Record<string, unknown>): string[] {
  return Object.keys(raw).filter(key => !isKnownKey(key))
}

export { getByPath as readByPath }
