import type { RawSyncConfig, SyncConfig } from './domain'
import process from 'node:process'
import minimist from 'minimist'
import { bold, cyan, yellow } from 'picocolors'
import pkg from '../package.json'
import { buildConfig, generateDefaultConfig, loadConfig } from './config'
import { ConflictResolutionStrategy, GrayReleaseStrategy } from './domain'
import { exitCodeFor, isSyncError, toError } from './errors'
import { logger, LogLevel } from './logger'
import { failedChanges } from './pipeline/apply'
import { collectMissingOptions, conflictPrompt, displaySummary } from './prompts'
import { runSync } from './sync'

const STRING_FLAGS = [
  'repo',
  'branch',
  'company-branch',
  'dirs',
  'message',
  'config',
  'config-format',
  'retry-max',
  'retry-delay',
  'retry-backoff',
  'concurrency',
  'strategy',
  'percentage',
  'canary-dirs',
  'file-patterns',
  'validation-script',
  'ignore',
  'include-types',
  'conflict-strategy',
  'auth-type',
  'auth-username',
  'auth-token',
  'auth-password',
  'auth-key',
  'webhook-port',
  'webhook-path',
  'webhook-secret',
  'webhook-events',
  'webhook-branch',
]

const BOOLEAN_FLAGS = [
  'push',
  'version',
  'help',
  'force',
  'incremental',
  'verbose',
  'silent',
  'dry-run',
  'preview-only',
  'non-interactive',
  'generate-config',
  'gray-release',
  'full-release',
  'rollback',
  'webhook-enable',
]

const ALIASES: Record<string, string> = {
  r: 'repo',
  b: 'branch',
  c: 'company-branch',
  d: 'dirs',
  m: 'message',
  p: 'push',
  f: 'force',
  h: 'help',
  v: 'version',
  V: 'verbose',
  s: 'silent',
  n: 'dry-run',
  P: 'preview-only',
  C: 'config',
  F: 'config-format',
  y: 'non-interactive',
  g: 'generate-config',
  gr: 'gray-release',
  fr: 'full-release',
  ro: 'rollback',
  we: 'webhook-enable',
}

export function parseArgs(argv: string[]): minimist.ParsedArgs {
  return minimist(argv, {
    string: STRING_FLAGS,
    boolean: BOOLEAN_FLAGS,
    alias: ALIASES,
    default: { 'config-format': 'json', 'webhook-port': '3000', 'webhook-path': '/webhook', 'webhook-events': 'push', 'webhook-branch': 'main' },
  })
}

const KNOWN = new Set<string>([...STRING_FLAGS, ...BOOLEAN_FLAGS, ...Object.keys(ALIASES), '_'])

/** Reject unknown switches before they can be mistaken for "the tool ignored my flag". */
export function unknownFlags(argv: Record<string, unknown>): string[] {
  return Object.keys(argv).filter(key => !KNOWN.has(key))
}

/** Map parsed CLI flags onto canonical config keys; absent flags produce no key at all. */
export function cliLayer(argv: minimist.ParsedArgs): RawSyncConfig {
  const layer: Record<string, unknown> = {}
  const set = (key: string, value: unknown): void => {
    if (value !== undefined && value !== '')
      layer[key] = value
  }
  const list = (value: unknown): string[] => {
    if (Array.isArray(value))
      return value.flatMap(item => String(item).split(','))
    return String(value).split(',').map(item => item.trim()).filter(Boolean)
  }

  set('upstreamRepo', argv.repo)
  set('upstreamBranch', argv.branch)
  set('companyBranch', argv['company-branch'])
  if (argv.dirs)
    layer.syncDirs = list(argv.dirs)
  set('commitMessage', argv.message)
  if (argv.push)
    layer.autoPush = true
  if (argv.force)
    layer.forceOverwrite = true
  if (argv.incremental)
    layer.forceOverwrite = false
  if (argv.verbose)
    layer.verbose = true
  if (argv.silent)
    layer.silent = true
  if (argv['dry-run'])
    layer.dryRun = true
  if (argv['preview-only'])
    layer.previewOnly = true
  if (argv['non-interactive'])
    layer.nonInteractive = true
  if (argv.concurrency)
    layer.concurrencyLimit = Number(argv.concurrency)
  if (argv.ignore)
    layer.ignorePatterns = list(argv.ignore)
  if (argv['include-types'])
    layer.includeFileTypes = list(argv['include-types'])
  if (argv['conflict-strategy'])
    layer.conflictResolutionConfig = { defaultStrategy: argv['conflict-strategy'] as ConflictResolutionStrategy }
  if (argv['retry-max'] !== undefined) {
    layer.retryConfig = { maxRetries: Number(argv['retry-max']) }
  }
  if (argv['retry-delay'] !== undefined) {
    layer.retryConfig = { ...(layer.retryConfig as object), initialDelay: Number(argv['retry-delay']) }
  }
  if (argv['retry-backoff'] !== undefined) {
    layer.retryConfig = { ...(layer.retryConfig as object), backoffFactor: Number(argv['retry-backoff']) }
  }
  if (argv['gray-release']) {
    layer.grayReleaseConfig = {
      enable: true,
      strategy: (argv.strategy as GrayReleaseStrategy) ?? GrayReleaseStrategy.PERCENTAGE,
      percentage: argv.percentage === undefined ? 20 : Number(argv.percentage),
      canaryDirs: argv['canary-dirs'] ? list(argv['canary-dirs']) : undefined,
      filePatterns: argv['file-patterns'] ? list(argv['file-patterns']) : undefined,
      validationScript: argv['validation-script'],
    }
  }
  if (argv['full-release'])
    layer.fullRelease = true
  if (argv.rollback)
    layer.rollback = true
  if (argv['webhook-enable']) {
    layer.webhookConfig = {
      enable: true,
      port: Number(argv['webhook-port']),
      path: argv['webhook-path'],
      secret: argv['webhook-secret'] ?? '',
      allowedEvents: list(argv['webhook-events']),
      triggerBranch: argv['webhook-branch'],
      supportedPlatforms: ['github'],
    }
  }
  if (argv['auth-type']) {
    layer.authConfig = {
      type: argv['auth-type'],
      username: argv['auth-username'],
      token: argv['auth-token'],
      password: argv['auth-password'],
      privateKeyPath: argv['auth-key'],
    }
  }
  return layer as RawSyncConfig
}

const HELP = `${bold(cyan('sync-upstream — 目录级上游同步'))}

用法: sync-upstream [选项]

  -r, --repo <url>          上游仓库 URL
  -b, --branch <分支>        上游分支 (默认取配置或 main)
  -c, --company-branch <分支> 目标分支 (默认 main)
  -d, --dirs <a,b>          要同步的目录，逗号分隔
  -m, --message <文本>       提交消息
  -p, --push                同步后自动推送
  -f, --force / --incremental  强制覆盖 / 仅同步上次以来的变更
  -P, --preview-only        只打印计划，不修改工作区
  -n, --dry-run             同 --preview-only，用于脚本
  -y, --non-interactive     不询问任何问题
  -C, --config <路径>        指定配置文件（读取失败会直接报错）
  -F, --config-format <格式>  生成配置时的格式: json|json5|yaml|toml
  -g, --generate-config     生成默认配置文件后退出
      --ignore <a,b>        追加忽略规则（gitignore 语法）
      --include-types <a,b> 仅同步这些扩展名，如 .ts,.vue
      --conflict-strategy <s> use-source|keep-target|auto-merge|prompt-user|skip
      --retry-max/-delay/-backoff  网络重试参数
      --concurrency <n>     失败逐文件重试的并发数
  -gr, --gray-release       启用灰度发布
      --strategy <s>        percentage|directory|file
      --percentage <n>      灰度百分比 (0,100]
      --canary-dirs <a,b>   金丝雀目录
      --file-patterns <a,b> 金丝雀文件模式
      --validation-script <cmd> 灰度校验命令
  -fr, --full-release       发布灰度剩余文件
  -ro, --rollback           回滚最近一次灰度发布
  -we, --webhook-enable     以 webhook 守护模式常驻运行
      --webhook-port/-path/-secret/-events/-branch
  -V, --verbose / -s, --silent
  -v, --version / -h, --help

示例:
  sync-upstream -r https://github.com/org/upstream.git -d src/utils,docs -b main
  sync-upstream -C sync-upstream.json -P
`

/** CLI > config file > defaults, then interactive completion unless -y. */
export async function resolveRuntimeConfig(argv: minimist.ParsedArgs): Promise<{ config: SyncConfig, source: string | null }> {
  const loaded = await loadConfig({
    configPath: argv.config ? String(argv.config) : undefined,
    baseDir: process.cwd(),
  })
  for (const warning of loaded.warnings) logger.warn(warning)

  const layer = cliLayer(argv)
  if (argv['conflict-strategy']) {
    layer.conflictResolutionConfig = { defaultStrategy: argv['conflict-strategy'] as ConflictResolutionStrategy }
  }

  const { config, warnings } = buildConfig([loaded.layer, layer])
  for (const warning of warnings) logger.warn(warning)
  return { config, source: loaded.source }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)

  if (args.version) {
    logger.success(bold(cyan(`sync-upstream v${pkg.version}`)))
    return 0
  }
  if (args.help) {
    console.log(HELP)
    return 0
  }
  if (args['generate-config']) {
    const target = args.config || `./sync-upstream.config.${args['config-format'] ?? 'json'}`
    const written = await generateDefaultConfig(target, args['config-format'] as never)
    logger.success(`默认配置已生成: ${written}`)
    return 0
  }

  const unknown = unknownFlags(args)
  if (unknown.length > 0) {
    logger.error(`无法识别的命令行参数: ${unknown.join(', ')}`)
    console.log(yellow('使用 --help 查看全部可用参数'))
    return 2
  }

  const { config, source } = await resolveRuntimeConfig(args)
  if (args.verbose)
    logger.setLevel(LogLevel.VERBOSE)
  else if (args.silent)
    logger.setLevel(LogLevel.ERROR)

  const incomplete = !config.upstreamRepo || config.syncDirs.length === 0
  const interactive = !config.nonInteractive || incomplete
  const finalConfig = interactive ? await collectMissingOptions(config) : config

  displaySummary(finalConfig, source)
  if (finalConfig.webhookConfig?.enable) {
    const { serveWebhooks } = await import('./pipeline/webhook-mode')
    return serveWebhooks(finalConfig)
  }

  const result = await runSync({
    config: finalConfig,
    cwd: process.cwd(),
    prompt: finalConfig.conflictResolutionConfig.defaultStrategy === ConflictResolutionStrategy.PROMPT_USER
      ? conflictPrompt
      : undefined,
  })
  if (result.applied)
    return failedChanges(result.applied).length > 0 ? 1 : 0
  return 0
}

/** Fail loudly with the mapped exit code instead of a stack trace. */
export function reportFatal(error: unknown): number {
  if (isSyncError(error)) {
    error.report()
    return exitCodeFor(error)
  }
  const detail = toError(error)
  logger.error(`未预期的错误: ${detail.message}`, detail)
  return exitCodeFor(error)
}

if (/(?:^|[\\/])cli\.[cm]?[jt]sx?$/.test(process.argv[1] ?? '')) {
  main().then(code => process.exit(code)).catch((error) => {
    process.exit(reportFatal(error))
  })
}
