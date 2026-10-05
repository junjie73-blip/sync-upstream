import type { SyncConfig } from '../domain'
import { BranchStrategy, ConflictResolutionStrategy } from '../domain'
import { RepoPathError, ValidationError } from '../errors'
import { DEFAULT_CONFIG } from './defaults'
import { isBlank, mergeConfigLayers } from './merge'
import { normalizeConfigKeys, unknownKeys } from './normalize'

export interface ConfigResolution {
  config: SyncConfig
  warnings: string[]
}

const CONFLICT_STRATEGIES: string[] = Object.values(ConflictResolutionStrategy)
const BRANCH_STRATEGIES: string[] = Object.values(BranchStrategy)

function checkRepoPath(dir: string): string | null {
  const normalized = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '')
    return '目录名为空'
  if (normalized.startsWith('/'))
    return '必须是仓库根目录下的相对路径，不能以 / 开头'
  if (/^[a-z]:/i.test(normalized))
    return '必须是仓库根目录下的相对路径，不能是绝对路径'
  if (normalized.split('/').includes('..'))
    return '不允许包含 ..'
  if (normalized.includes('//'))
    return '包含连续的路径分隔符'
  return null
}

/**
 * Turn arbitrary config input into a fully populated, type-checked SyncConfig.
 * All problems are collected so one run reports every mistake instead of the first.
 */
export function resolveConfig(raw: Record<string, unknown>): ConfigResolution {
  const { value: aliased, warnings, errors } = normalizeConfigKeys(raw)
  const problems: string[] = [...errors]

  for (const key of unknownKeys(aliased)) {
    warnings.push(`未识别的配置项 \`${key}\` 已忽略（拼写错误不会产生任何效果）`)
  }

  const merged = mergeConfigLayers<SyncConfig>(DEFAULT_CONFIG, aliased as Partial<SyncConfig>)

  if (isBlank(merged.upstreamRepo)) {
    problems.push('upstreamRepo 不能为空（上游仓库 URL）')
  }
  else if (!isSupportedRepoUrl(merged.upstreamRepo)) {
    problems.push(`upstreamRepo 不是可识别的仓库地址: ${merged.upstreamRepo}`)
  }
  if (isBlank(merged.upstreamBranch))
    problems.push('upstreamBranch 不能为空')
  if (isBlank(merged.companyBranch))
    problems.push('companyBranch 不能为空')

  if (!Array.isArray(merged.syncDirs) || merged.syncDirs.length === 0) {
    problems.push('syncDirs 必须是非空数组，例如 ["src/config", "build"]')
  }
  else {
    for (const dir of merged.syncDirs) {
      if (typeof dir !== 'string') {
        problems.push(`syncDirs 中存在非字符串项: ${JSON.stringify(dir)}`)
        continue
      }
      const issue = checkRepoPath(dir)
      if (issue)
        problems.push(`syncDirs 中的 "${dir}" ${issue}`)
    }
  }

  const { retryConfig, concurrencyLimit, conflictResolutionConfig, branchStrategyConfig } = merged

  if (!Number.isInteger(retryConfig?.maxRetries) || retryConfig.maxRetries < 0) {
    problems.push(`retryConfig.maxRetries 必须是不小于 0 的整数，实际是 ${JSON.stringify(retryConfig?.maxRetries)}`)
  }
  if (!Number.isFinite(retryConfig?.initialDelay) || retryConfig.initialDelay < 0) {
    problems.push(`retryConfig.initialDelay 必须是不小于 0 的数字，实际是 ${JSON.stringify(retryConfig?.initialDelay)}`)
  }
  if (!Number.isFinite(retryConfig?.backoffFactor) || retryConfig.backoffFactor < 1) {
    problems.push(`retryConfig.backoffFactor 必须是不小于 1 的数字，实际是 ${JSON.stringify(retryConfig?.backoffFactor)}`)
  }
  if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1) {
    problems.push(`concurrencyLimit 必须是不小于 1 的整数，实际是 ${JSON.stringify(concurrencyLimit)}`)
  }

  if (!CONFLICT_STRATEGIES.includes(conflictResolutionConfig?.defaultStrategy)) {
    problems.push(`conflictResolutionConfig.defaultStrategy 无效: ${JSON.stringify(conflictResolutionConfig?.defaultStrategy)}，可选值: ${CONFLICT_STRATEGIES.join(', ')}`)
  }
  if (conflictResolutionConfig?.autoResolveTypes && !Array.isArray(conflictResolutionConfig.autoResolveTypes)) {
    problems.push('conflictResolutionConfig.autoResolveTypes 必须是字符串数组')
  }

  if (branchStrategyConfig?.enable) {
    if (!BRANCH_STRATEGIES.includes(branchStrategyConfig.strategy)) {
      problems.push(`branchStrategyConfig.strategy 无效: ${JSON.stringify(branchStrategyConfig.strategy)}，可选值: ${BRANCH_STRATEGIES.join(', ')}`)
    }
    if (isBlank(branchStrategyConfig.baseBranch))
      problems.push('branchStrategyConfig.baseBranch 不能为空')
    if (isBlank(branchStrategyConfig.branchPattern))
      problems.push('branchStrategyConfig.branchPattern 不能为空')
  }

  if (merged.webhookConfig?.enable) {
    const { port, path, secret } = merged.webhookConfig
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      problems.push(`webhookConfig.port 无效: ${JSON.stringify(port)}`)
    if (isBlank(path) || !path.startsWith('/'))
      problems.push('webhookConfig.path 必须以 / 开头')
    if (isBlank(secret))
      problems.push('启用 webhook 时 webhookConfig.secret 不能为空')
  }

  if (merged.grayReleaseConfig?.enable) {
    const { percentage, strategy } = merged.grayReleaseConfig
    if (strategy === 'percentage' && (!Number.isFinite(percentage) || percentage! <= 0 || percentage! > 100)) {
      problems.push(`grayReleaseConfig.percentage 必须在 (0, 100] 区间，实际是 ${JSON.stringify(percentage)}`)
    }
  }

  if (problems.length > 0) {
    throw new ValidationError(`配置校验失败:\n  - ${problems.join('\n  - ')}`)
  }

  const config: SyncConfig = {
    ...merged,
    syncDirs: merged.syncDirs.map(dir => dir.replace(/\\/g, '/').replace(/\/+$/, '')),
    includeFileTypes: (merged.includeFileTypes || []).map(ext => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`),
    ignorePatterns: merged.ignorePatterns || [],
  }

  if (config.dryRun && config.autoPush) {
    warnings.push('dryRun 与 autoPush 同时开启，已跳过推送')
    config.autoPush = false
  }

  return { config, warnings }
}

/** Accept https/http/ssh/ssh-scoped and scp-like git URLs (git@host:org/repo.git), plus local paths. */
export function isSupportedRepoUrl(url: string): boolean {
  const value = url.trim()
  if (/^(?:https?|ssh|git|file):\/\/\S+/.test(value))
    return true
  // scp-like form: user@host:path — no scheme, exactly one colon separator.
  if (/^[\w.-]+@[\w.-]+:\S+$/.test(value))
    return true
  if (/^\/\S+$/.test(value) || /^[a-z]:[\\/]\S+/i.test(value) || /^\.\.?[\\/]\S+/.test(value))
    return true
  return false
}

export function assertSyncDirsInsideRepo(dirs: string[], repoRoot: string): void {
  for (const dir of dirs) {
    const issue = checkRepoPath(dir)
    if (issue)
      throw new RepoPathError(`同步目录 "${dir}" ${issue}`, undefined, { repoRoot })
  }
}
