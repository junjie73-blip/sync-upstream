import type { SyncConfig } from '../domain'
import { BranchStrategy, ConflictResolutionStrategy, DELETE_POLICIES, LFS_MODES, LOG_FILE_LEVELS, NOTIFY_CHANNELS, PARTIAL_FILTERS, SYNC_OUTCOMES } from '../domain'
import { RepoPathError, ValidationError } from '../errors'
import { joinList, t } from '../i18n'
import { DEFAULT_CONFIG } from './defaults'
import { isBlank, mergeConfigLayers } from './merge'
import { normalizeConfigKeys, unknownKeys } from './normalize'

export interface ConfigResolution {
  config: SyncConfig
  warnings: string[]
  /**
   * Everything that makes this configuration unusable for a real sync. Strict callers throw on a
   * non-empty list; the lenient ones hand it to the user as warnings and carry on reading.
   */
  problems: string[]
}

export interface ResolveConfigOptions {
  /**
   * Report invalid input instead of refusing to run. `status`, `history` and `doctor` exist to
   * diagnose a repository whose configuration is broken or missing, so they ask for this and get
   * the problems back as warnings — a half-configured repo still produces a report, and the report
   * says what is missing. A real sync never uses it: writing commits with a broken config is worse.
   */
  lenient?: boolean
}

const CONFLICT_STRATEGIES: string[] = Object.values(ConflictResolutionStrategy)
const BRANCH_STRATEGIES: string[] = Object.values(BranchStrategy)

function checkRepoPath(dir: string): string | null {
  const normalized = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '')
    return t('v.pathEmpty')
  if (normalized.startsWith('/'))
    return t('v.pathRooted')
  if (/^[a-z]:/i.test(normalized))
    return t('v.pathAbsolute')
  if (normalized.split('/').includes('..'))
    return t('v.pathParent')
  if (normalized.includes('//'))
    return t('v.pathDoubleSeparator')
  return null
}

function normalizeRepoPath(dir: string): string {
  // Trim first: `" src/ui/ "` in a JSON config means `src/ui`, and keeping the spaces would
  // turn a typo into a sync directory that silently never matches anything.
  return dir.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

/** The `upstreams` list as written. A non-array value produces no entries and is reported below. */
function upstreamsOf(config: SyncConfig): Array<Record<string, any>> {
  const value = (config as unknown as { upstreams?: unknown }).upstreams
  if (!Array.isArray(value))
    return []
  return value.filter(item => item !== undefined && item !== null) as Array<Record<string, any>>
}

/** Same repo + same ref twice means the second pass re-fetches and re-plans the first one's source. */
function duplicateSources(entries: Array<Record<string, any>>, fallback: string): string[] {
  const seen = new Map<string, number>()
  const duplicates: string[] = []
  for (const entry of entries) {
    const repo = String(entry.repo ?? fallback ?? '')
    const key = `${repo}\u0000${String(entry.branch ?? '')}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
    if (seen.get(key) === 2)
      duplicates.push(repo ? `${repo}${entry.branch ? `@${entry.branch}` : ''}` : t('v.unnamedUpstream'))
  }
  return duplicates
}

/** Directories that two upstreams both claim, in configuration order. */
function overlappingDirs(entries: Array<Record<string, any>>, fallback: string[]): string[] {
  const taken: Array<{ dir: string, owner: number }> = []
  const overlaps = new Set<string>()
  entries.forEach((entry, index) => {
    const dirs = Array.isArray(entry.dirs) && entry.dirs.length > 0 ? entry.dirs.map(String) : fallback
    for (const dir of dirs) {
      const normalized = normalizeRepoPath(dir)
      const previous = taken.find(item => item.dir === normalized || normalized.startsWith(`${item.dir}/`) || item.dir.startsWith(`${normalized}/`))
      if (previous)
        overlaps.add(t('v.overlapPair', { dir: normalized, a: previous.owner, b: index }))
      taken.push({ dir: normalized, owner: index })
    }
  })
  return [...overlaps]
}

/**
 * Turn arbitrary config input into a fully populated, type-checked SyncConfig.
 * All problems are collected so one run reports every mistake instead of the first.
 *
 * Every message comes from the message catalog: the diagnosis reads in the user's language, while
 * the field names stay English because those are what has to be typed into the config file.
 */
export function resolveConfig(raw: Record<string, unknown>, options: ResolveConfigOptions = {}): ConfigResolution {
  const { value: aliased, warnings, errors } = normalizeConfigKeys(raw)
  const problems: string[] = [...errors]

  for (const key of unknownKeys(aliased)) {
    warnings.push(t('v.unknownKey', { key }))
  }

  const merged = mergeConfigLayers<SyncConfig>(DEFAULT_CONFIG, aliased as Partial<SyncConfig>)
  const fanIn = upstreamsOf(merged)
  if (merged.upstreams !== undefined && !Array.isArray(merged.upstreams))
    problems.push(t('v.upstreamsNotArray'))

  // Every upstream may leave `repo` out and inherit the top-level one; only when some of them
  // really do inherit it is the top-level URL required.
  const needsTopLevelRepo = fanIn.length === 0 || fanIn.some(entry => isBlank(entry.repo))
  if (needsTopLevelRepo && isBlank(merged.upstreamRepo)) {
    problems.push(t('v.upstreamRepoRequired'))
  }
  else if (needsTopLevelRepo && !isSupportedRepoUrl(merged.upstreamRepo)) {
    problems.push(t('v.upstreamRepoInvalid', { value: merged.upstreamRepo }))
  }
  if (fanIn.length === 0 && isBlank(merged.upstreamBranch))
    problems.push(t('v.required', { field: 'upstreamBranch' }))
  if (isBlank(merged.companyBranch))
    problems.push(t('v.required', { field: 'companyBranch' }))

  for (const [index, entry] of fanIn.entries()) {
    const at = `upstreams[${index}]`
    if (typeof entry !== 'object' || entry === null) {
      problems.push(t('v.entryMustBeObject', { at }))
      continue
    }
    const repo = typeof entry.repo === 'string' ? entry.repo.trim() : ''
    if (repo === '') {
      if (isBlank(merged.upstreamRepo))
        problems.push(t('v.entryRepoRequired', { at }))
    }
    else if (!isSupportedRepoUrl(repo)) {
      problems.push(t('v.entryRepoInvalid', { at, value: repo }))
    }
    if (entry.branch !== undefined && (typeof entry.branch !== 'string' || entry.branch.trim() === ''))
      problems.push(t('v.entryBranchNotString', { at, value: JSON.stringify(entry.branch) }))
    if (entry.message !== undefined && typeof entry.message !== 'string')
      problems.push(t('v.entryMessageNotString', { at }))
    if (entry.dirs !== undefined) {
      if (!Array.isArray(entry.dirs) || entry.dirs.length === 0) {
        problems.push(t('v.entryDirsNotArray', { at }))
      }
      else {
        for (const dir of entry.dirs) {
          if (typeof dir !== 'string') {
            problems.push(t('v.entryDirsItemNotString', { at, value: JSON.stringify(dir) }))
            continue
          }
          const issue = checkRepoPath(dir)
          if (issue)
            problems.push(t('v.dirInvalid', { field: `${at}.dirs`, dir, issue }))
        }
      }
    }
  }

  if (!Array.isArray(merged.syncDirs) || merged.syncDirs.length === 0) {
    problems.push(t('v.syncDirsNotArray'))
  }
  else {
    for (const dir of merged.syncDirs) {
      if (typeof dir !== 'string') {
        problems.push(t('v.syncDirsItemNotString', { value: JSON.stringify(dir) }))
        continue
      }
      const issue = checkRepoPath(dir)
      if (issue)
        problems.push(t('v.dirInvalid', { field: 'syncDirs', dir, issue }))
    }
  }

  // Fan-in pitfalls that still run correctly but never do what the author meant.
  if (fanIn.length > 1) {
    const fallback = Array.isArray(merged.syncDirs) ? merged.syncDirs : []
    const duplicates = duplicateSources(fanIn, merged.upstreamRepo)
    if (duplicates.length > 0)
      warnings.push(t('v.duplicateSources', { list: joinList(duplicates) }))
    const overlaps = overlappingDirs(fanIn, fallback)
    if (overlaps.length > 0)
      warnings.push(t('v.overlappingDirs', { list: joinList(overlaps, 'semicolon') }))
  }

  const { retryConfig, concurrencyLimit, lockWaitMs, conflictResolutionConfig, branchStrategyConfig } = merged
  if (!Number.isInteger(retryConfig?.maxRetries) || retryConfig.maxRetries < 0) {
    problems.push(t('v.retryMaxRetries', { value: JSON.stringify(retryConfig?.maxRetries) }))
  }
  if (!Number.isFinite(retryConfig?.initialDelay) || retryConfig.initialDelay < 0) {
    problems.push(t('v.retryInitialDelay', { value: JSON.stringify(retryConfig?.initialDelay) }))
  }
  if (!Number.isFinite(retryConfig?.backoffFactor) || retryConfig.backoffFactor < 1) {
    problems.push(t('v.retryBackoffFactor', { value: JSON.stringify(retryConfig?.backoffFactor) }))
  }
  if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1) {
    problems.push(t('v.concurrencyLimit', { value: JSON.stringify(concurrencyLimit) }))
  }
  if (!Number.isInteger(lockWaitMs) || lockWaitMs < 0) {
    problems.push(t('v.lockWaitMs', { value: JSON.stringify(lockWaitMs) }))
  }

  if (!CONFLICT_STRATEGIES.includes(conflictResolutionConfig?.defaultStrategy)) {
    problems.push(t('v.conflictStrategy', { value: JSON.stringify(conflictResolutionConfig?.defaultStrategy), allowed: CONFLICT_STRATEGIES.join(', ') }))
  }
  if (conflictResolutionConfig?.autoResolveTypes && !Array.isArray(conflictResolutionConfig.autoResolveTypes)) {
    problems.push(t('v.conflictAutoResolveTypes'))
  }
  if (conflictResolutionConfig?.resolutionLogFile !== undefined && typeof conflictResolutionConfig.resolutionLogFile !== 'string') {
    problems.push(t('v.conflictResolutionLogFile', { value: JSON.stringify(conflictResolutionConfig.resolutionLogFile) }))
  }

  if (branchStrategyConfig?.enable) {
    if (!BRANCH_STRATEGIES.includes(branchStrategyConfig.strategy)) {
      problems.push(t('v.branchStrategy', { value: JSON.stringify(branchStrategyConfig.strategy), allowed: BRANCH_STRATEGIES.join(', ') }))
    }
    if (isBlank(branchStrategyConfig.baseBranch))
      problems.push(t('v.required', { field: 'branchStrategyConfig.baseBranch' }))
    if (isBlank(branchStrategyConfig.branchPattern))
      problems.push(t('v.required', { field: 'branchStrategyConfig.branchPattern' }))
  }

  if (merged.webhookConfig?.enable) {
    const { port, path, secret, host, tlsCert, tlsKey, maxBodyBytes, deliveryLog, maxQueue, seenHistory, healthPath } = merged.webhookConfig
    // 0 交给系统分配端口：容器与 CI 里跑守护进程时不必先猜一个空闲端口，`start()` 会打印实际端口。
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      problems.push(t('v.webhookPort', { value: JSON.stringify(port) }))
    if (isBlank(path) || !path.startsWith('/'))
      problems.push(t('v.webhookPath'))
    if (isBlank(secret))
      problems.push(t('v.webhookSecret'))
    if (host !== undefined && (typeof host !== 'string' || host.trim() === ''))
      problems.push(t('v.webhookHost'))
    if (Boolean(tlsCert) !== Boolean(tlsKey))
      problems.push(t('v.webhookTlsPair'))
    if (maxBodyBytes !== undefined && (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024)) {
      problems.push(t('v.webhookMaxBodyBytes', { value: JSON.stringify(maxBodyBytes) }))
    }
    if (healthPath !== undefined && healthPath !== false && (typeof healthPath !== 'string' || !healthPath.startsWith('/')))
      problems.push(t('v.webhookHealthPath'))
    if (deliveryLog !== undefined && (typeof deliveryLog !== 'string' || deliveryLog.trim() === ''))
      problems.push(t('v.webhookDeliveryLog'))
    if (maxQueue !== undefined && (!Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 1000)) {
      problems.push(t('v.webhookMaxQueue', { value: JSON.stringify(maxQueue) }))
    }
    if (seenHistory !== undefined && (!Number.isInteger(seenHistory) || seenHistory < 1))
      problems.push(t('v.webhookSeenHistory', { value: JSON.stringify(seenHistory) }))
    // Without an audit file the operator cannot answer "did my push trigger a sync" after the
    // fact, which is the one thing a daemon has to be able to prove.
    if (deliveryLog === undefined)
      warnings.push(t('v.webhookNoDeliveryLog'))
  }

  if (merged.notifyConfig?.enable) {
    const notify = merged.notifyConfig
    const channels = Array.isArray(notify.channels) ? notify.channels.map(String) : []
    const unknown = channels.filter(channel => !NOTIFY_CHANNELS.includes(channel))
    if (channels.length === 0) {
      problems.push(t('v.notifyChannelsRequired', { allowed: NOTIFY_CHANNELS.join(', ') }))
    }
    else if (unknown.length > 0) {
      problems.push(t('v.notifyChannelsUnknown', { value: unknown.join(', '), allowed: NOTIFY_CHANNELS.join(', ') }))
    }
    const events = Array.isArray(notify.events) ? notify.events.map(String) : []
    const unknownEvents = events.filter(event => !SYNC_OUTCOMES.includes(event))
    if (unknownEvents.length > 0)
      problems.push(t('v.notifyEventsUnknown', { value: unknownEvents.join(', '), allowed: SYNC_OUTCOMES.join(', ') }))
    if (!Number.isInteger(notify.timeoutMs) || notify.timeoutMs < 500)
      problems.push(t('v.notifyTimeoutMs', { value: JSON.stringify(notify.timeoutMs) }))
    if (!Number.isInteger(notify.retries) || notify.retries < 1 || notify.retries > 5)
      problems.push(t('v.notifyRetries', { value: JSON.stringify(notify.retries) }))
    for (const [key, value] of Object.entries({ url: notify.url, slackUrl: notify.slackUrl, dingtalkUrl: notify.dingtalkUrl, wecomUrl: notify.wecomUrl })) {
      if (value !== undefined && !/^https?:\/\//i.test(String(value)))
        problems.push(t('v.notifyUrlHttp', { field: `notifyConfig.${key}`, value: JSON.stringify(value) }))
    }
    if (notify.headers !== undefined && (typeof notify.headers !== 'object' || Array.isArray(notify.headers)))
      problems.push(t('v.notifyHeaders'))
  }

  if (merged.grayReleaseConfig?.enable) {
    const { percentage, strategy } = merged.grayReleaseConfig
    if (strategy === 'percentage' && (!Number.isFinite(percentage) || percentage! <= 0 || percentage! > 100)) {
      problems.push(t('v.grayPercentage', { value: JSON.stringify(percentage) }))
    }
  }

  if (!DELETE_POLICIES.includes(merged.deletePolicy)) {
    problems.push(t('v.deletePolicy', { value: JSON.stringify(merged.deletePolicy) }))
  }
  if (typeof merged.renameDetection !== 'boolean')
    problems.push(t('v.renameDetection', { value: JSON.stringify(merged.renameDetection) }))
  if (!Number.isInteger(merged.renameThreshold) || merged.renameThreshold < 1 || merged.renameThreshold > 100) {
    problems.push(t('v.renameThreshold', { value: JSON.stringify(merged.renameThreshold) }))
  }
  // A rename does delete the old path; promising "never delete what upstream dropped" and then
  // moving the file would be the same promise broken with a nicer label.
  if (merged.deletePolicy === 'keep' && merged.renameDetection) {
    warnings.push(t('v.keepDisablesRenames'))
    merged.renameDetection = false
  }
  // Gray release applies a *subset* of the plan, and a rename can only be applied as a whole
  // (moving half of a pair is a delete). Partial stage machinery and renames do not mix, so the
  // pair stays delete+add while gray is on — it still syncs, just without the `git mv`.
  if (merged.grayReleaseConfig?.enable && merged.renameDetection) {
    warnings.push(t('v.grayDisablesRenames'))
    merged.renameDetection = false
  }
  const fetch = merged.fetchConfig
  if (fetch) {
    if (!PARTIAL_FILTERS.includes(fetch.filter)) {
      problems.push(t('v.fetchFilter', { value: JSON.stringify(fetch.filter) }))
    }
    if (fetch.depth !== undefined && fetch.depth !== null && (!Number.isInteger(fetch.depth) || fetch.depth < 1)) {
      problems.push(t('v.fetchDepth', { value: JSON.stringify(fetch.depth) }))
    }
    if (typeof fetch.tags !== 'boolean')
      problems.push(t('v.fetchTags', { value: JSON.stringify(fetch.tags) }))
    if (!LFS_MODES.includes(fetch.lfs))
      problems.push(t('v.fetchLfs', { value: JSON.stringify(fetch.lfs) }))

    // A shallow fetch leaves the older side of a rename pair out of the object store, so the
    // similarity comparison git would need cannot happen; better to say so than to plan nothing.
    if (fetch.depth && merged.renameDetection) {
      warnings.push(t('v.depthDisablesRenames'))
      merged.renameDetection = false
    }
    // Both modes read blobs the server never sent, which git then fetches lazily — correct, just
    // not the "small fetch" the operator meant. Say it once instead of letting them measure it.
    if (fetch.filter === 'tree')
      warnings.push(t('v.treeFilterSlow'))
    if (fetch.lfs === 'materialize' && fetch.filter !== 'none')
      warnings.push(t('v.materializeNeedsBlobs'))
  }

  const log = merged.logConfig
  if (log) {
    if (log.file !== undefined && (typeof log.file !== 'string' || log.file.trim() === ''))
      problems.push(t('v.logFile'))
    if (log.level !== undefined && !LOG_FILE_LEVELS.includes(log.level))
      problems.push(t('v.logLevel', { value: JSON.stringify(log.level) }))
    if (log.json !== undefined && typeof log.json !== 'boolean')
      problems.push(t('v.logJson', { value: JSON.stringify(log.json) }))
    if (log.maxBytes !== undefined && (!Number.isInteger(log.maxBytes) || log.maxBytes < 1024))
      problems.push(t('v.logMaxBytes', { value: JSON.stringify(log.maxBytes) }))
    if (log.keep !== undefined && (!Number.isInteger(log.keep) || log.keep < 0 || log.keep > 100))
      problems.push(t('v.logKeep', { value: JSON.stringify(log.keep) }))
    if (log.redact !== undefined && (!Array.isArray(log.redact) || log.redact.some(item => typeof item !== 'string' || item === '')))
      problems.push(t('v.logRedact'))
  }

  if (merged.prConfig?.enable) {
    const pr = merged.prConfig
    if (pr.branchPattern !== undefined && (typeof pr.branchPattern !== 'string' || pr.branchPattern.trim() === ''))
      problems.push(t('v.prBranchPattern'))
    if (pr.create !== undefined && !['auto', 'never'].includes(pr.create))
      problems.push(t('v.prCreate', { value: JSON.stringify(pr.create) }))
    if (pr.tool !== undefined && !['gh', 'glab'].includes(pr.tool))
      problems.push(t('v.prTool', { value: JSON.stringify(pr.tool) }))
    if (pr.remote !== undefined && (typeof pr.remote !== 'string' || pr.remote.trim() === ''))
      problems.push(t('v.prRemote'))
    if (merged.previewOnly || merged.dryRun)
      problems.push(t('v.prVsPreview'))
    if (merged.branchStrategyConfig?.enable)
      problems.push(t('v.prVsBranchStrategy'))
    if (merged.grayReleaseConfig?.enable)
      problems.push(t('v.prVsGray'))
    if (merged.autoPush) {
      // Pushing the *target* branch is exactly what a PR mode promises not to do.
      warnings.push(t('v.prKeepsTargetBranch'))
      merged.autoPush = false
    }
  }

  if (problems.length > 0 && !options.lenient) {
    throw new ValidationError(`${t('v.summary')}\n  - ${problems.join('\n  - ')}`)
  }

  const rawDirs = Array.isArray(merged.syncDirs) ? merged.syncDirs.filter(dir => typeof dir === 'string') : []
  const config: SyncConfig = {
    ...merged,
    syncDirs: rawDirs.map(dir => normalizeRepoPath(dir)),
    // Trimmed here so `sourcesOf` and every log line see exactly what the user meant, and an
    // absent per-source field means "inherit the top-level one" rather than "empty string".
    ...(Array.isArray(merged.upstreams)
      ? {
          upstreams: merged.upstreams
            .filter(entry => entry !== undefined && entry !== null)
            .map(entry => ({
              ...(typeof entry.repo === 'string' && entry.repo.trim() ? { repo: entry.repo.trim() } : {}),
              ...(typeof entry.branch === 'string' && entry.branch.trim() ? { branch: entry.branch.trim() } : {}),
              ...(Array.isArray(entry.dirs) && entry.dirs.length > 0
                ? { dirs: entry.dirs.filter(dir => typeof dir === 'string').map(dir => normalizeRepoPath(dir)) }
                : {}),
              ...(typeof entry.message === 'string' && entry.message.trim() ? { message: entry.message } : {}),
            })),
        }
      : {}),
    includeFileTypes: (Array.isArray(merged.includeFileTypes) ? merged.includeFileTypes : []).map(ext => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`),
    ignorePatterns: merged.ignorePatterns || [],
  }

  if (config.dryRun && config.autoPush) {
    warnings.push(t('v.dryRunSkipsPush'))
    config.autoPush = false
  }

  return { config, warnings, problems }
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
      throw new RepoPathError(t('e.repoPathInvalid', { dir, issue }), undefined, { repoRoot })
  }
}
