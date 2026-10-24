import type { CompletionSource } from './completion'
import type { ConfigFormat } from './config/parse'
import type { ResolveConfigOptions } from './config/resolve'
import type { FetchConfig, LfsMode, LogConfig, LogFileLevel, PartialFilter, RawSyncConfig, SyncConfig } from './domain'
import process from 'node:process'
import minimist from 'minimist'
import { bold, cyan, yellow } from 'picocolors'
import pkg from '../package.json'
import { isSubcommand, runSubcommand, SUBCOMMAND_HELP, SUBCOMMANDS } from './commands'
import { askInitPrompts, runInit } from './commands/init'
import { appendCiSummary, emit, toReport } from './commands/output'
import { buildSyncReport } from './commands/sync-report'
import { completionScript, isCompletionShell } from './completion'
import { buildConfig, generateDefaultConfig, loadConfig } from './config'
import { ConflictResolutionStrategy, GrayReleaseStrategy } from './domain'
import { exitCodeFor, isSyncError, toError } from './errors'
import { helpText } from './help'
import { initLocale, isLocale, t } from './i18n'
import { configureLogging, logger, LogLevel } from './logger'
import { failedChanges } from './pipeline/apply'
import { formatUndoResult } from './pipeline/preview'
import { collectMissingOptions, confirmDeletesPrompt, conflictPrompt, displaySummary } from './prompts'
import { runSync, undoSync } from './sync'

/**
 * The flag tables below are the single source of truth for what the CLI accepts: `parseArgs`
 * reads them, `unknownFlags` validates against them, and `sync-upstream completion` generates the
 * shell scripts from them. Adding a switch here documents and completes it at the same time.
 */
const STRING_FLAGS = [
  'repo',
  'branch',
  'company-branch',
  'dirs',
  'message',
  'config',
  'config-format',
  'lang',
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
  'webhook-host',
  'lock-wait',
  'notify',
  'notify-url',
  'notify-events',
  'limit',
  'delete-policy',
  'rename-threshold',
  'fetch-filter',
  'fetch-depth',
  'lfs',
  'log-file',
  'log-level',
  'log-max',
  'log-keep',
  'webhook-log',
  'webhook-queue',
  'pr-branch',
  'pr-remote',
  'pr-title',
  'pr-body',
]

const BOOLEAN_FLAGS = [
  'push',
  'version',
  'help',
  'force',
  'incremental',
  'verbose',
  'silent',
  'debug',
  'dry-run',
  'preview-only',
  'non-interactive',
  'generate-config',
  'gray-release',
  'full-release',
  'rollback',
  'webhook-enable',
  'json',
  'fetch',
  'undo',
  'no-notify',
  'pr-draft',
  'pr-no-create',
]

/**
 * Flags that also accept a `--no-` spelling.
 *
 * They must NOT be handed to minimist as `boolean`, because that makes an absent flag come back
 * as `false` — indistinguishable from an explicit `--no-delete`, and it would then silently
 * override the config file on every run. Left undeclared they stay `undefined` / `true` / `false`.
 *
 * Both spellings are listed: `--no-fetch-tags` and `--no-pr` arrive here as their own keys, and
 * an unlisted one would be rejected as an unknown switch even though `--help` advertises it.
 * (`--no-log-json` and `--no-notify` are different — `log-json` is a declared boolean, so minimist
 * folds the negated form into `log-json: false`.)
 */
const NEGATABLE_FLAGS = [
  'delete',
  'no-delete',
  'renames',
  'no-renames',
  'pr',
  'no-pr',
  'fetch-tags',
  'no-fetch-tags',
  'log-json',
]

/**
 * Verbs the CLI handles itself, before a config file is read.
 *
 * Neither fits the read-only subcommands: `init` writes a file and `completion` prints a script,
 * and both have to work in a directory that has no configuration yet.
 */
const CLI_VERBS = ['init', 'completion']

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
  uo: 'undo',
}

/**
 * minimist expands `-xy` into `-x -y`, so the multi-letter short flags advertised by `--help`
 * never reached their alias: `-gr` silently meant `-g` (write a default config file and exit),
 * `-fr` became `-f` (force overwrite), and `-uo`/`-ro`/`-we` failed as unknown flags.
 * Expanding them before parsing makes the documented spelling the accepted spelling.
 */
export const SHORT_GROUPS: Record<string, string> = {
  '-uo': '--undo',
  '-gr': '--gray-release',
  '-fr': '--full-release',
  '-ro': '--rollback',
  '-we': '--webhook-enable',
}

export function expandShortGroups(argv: string[]): string[] {
  return argv.map(token => SHORT_GROUPS[token] ?? token)
}

/**
 * Plain stdout lines (`--help`, the "did you mean a subcommand?" hint) go through
 * `process.stdout` like every other byte this tool writes, so a host that captures or
 * intercepts `console` — a test runner, an embedding process — still sees the CLI's own output
 * on its stream, and `--json`'s "stdout is one document" rule has a single writer.
 */
export function out(message: string): void {
  process.stdout.write(`${message}\n`)
}

export function parseArgs(argv: string[]): minimist.ParsedArgs {
  return minimist(expandShortGroups(argv), {
    string: STRING_FLAGS,
    boolean: BOOLEAN_FLAGS,
    alias: ALIASES,
    default: { 'config-format': 'json', 'webhook-port': '3000', 'webhook-path': '/webhook', 'webhook-events': 'push', 'webhook-branch': 'main' },
  })
}

const KNOWN = new Set<string>([...STRING_FLAGS, ...BOOLEAN_FLAGS, ...NEGATABLE_FLAGS, ...Object.keys(ALIASES), '_'])

/** Reject unknown switches before they can be mistaken for "the tool ignored my flag". */
export function unknownFlags(argv: Record<string, unknown>): string[] {
  return Object.keys(argv).filter(key => !KNOWN.has(key))
}

/** `sync-upstream status`, `sync-upstream why src/a.ts` → the subcommand and its arguments. */
export function subcommandOf(argv: minimist.ParsedArgs): { name: string, positional: string[] } | null {
  const [first, ...rest] = argv._
  if (first === undefined || String(first).trim() === '')
    return null
  return { name: String(first), positional: rest.map(String) }
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

  const many = (value: unknown): string[] => {
    if (Array.isArray(value))
      return value.map(item => String(item).trim()).filter(Boolean)
    return value === undefined ? [] : [String(value).trim()].filter(Boolean)
  }
  const repos = many(argv.repo)
  const branches = many(argv.branch)

  // A repeated `-r`/`-b` is the shell-friendly spelling of the `upstreams` array: minimist
  // already hands us a list, so pairing them by position is all multi-upstream needs here.
  // Shorter list falls back to its first value, which keeps `-r a -r b -b main` legal.
  if (repos.length > 1 || branches.length > 1) {
    const size = Math.max(repos.length, branches.length)
    layer.upstreams = Array.from({ length: size }, (_, index) => ({
      ...(repos[index] ?? repos[0] ? { repo: repos[index] ?? repos[0] } : {}),
      ...(branches[index] ?? branches[0] ? { branch: branches[index] ?? branches[0] } : {}),
    }))
  }
  set('upstreamRepo', repos[0])
  set('upstreamBranch', branches[0])
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
  if (argv['lock-wait'] !== undefined)
    layer.lockWaitMs = Number(argv['lock-wait'])
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
      host: argv['webhook-host'],
      // The daemon accepts gitlab/bitbucket/gitea payloads too; the platform is detected
      // per request, so hard-coding ['github'] only made non-GitHub secrets fail to verify.
      supportedPlatforms: ['github', 'gitlab', 'bitbucket', 'gitea'],
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
  // `--notify slack,dingtalk` turns the section on and picks the channels; the URLs themselves
  // belong in the config file (a chat webhook URL is a secret, and secrets do not go in argv,
  // where every other process on the machine can read them).
  // minimist reports `--no-notify` either as `no-notify: true` or as `notify: false` depending
  // on version, and both spellings must beat an enabled section in the config file.
  const notifyOff = argv['no-notify'] === true || argv.notify === false
  if (argv.notify !== undefined && argv.notify !== false && argv.notify !== '')
    layer.notifyConfig = { enable: true, channels: list(argv.notify) }
  if (argv['notify-url']) {
    const previous = (layer.notifyConfig ?? {}) as { channels?: string[] }
    layer.notifyConfig = {
      ...previous,
      enable: true,
      url: argv['notify-url'],
      // A URL without the `http` channel would be configured but never used.
      channels: [...new Set([...(previous.channels ?? []), 'http'])],
    }
  }
  if (argv['notify-events'])
    layer.notifyConfig = { ...(layer.notifyConfig as object), events: list(argv['notify-events']) }
  if (notifyOff)
    layer.notifyConfig = { ...(layer.notifyConfig as object), enable: false }

  // Deletions: `--no-delete` is the memorable spelling of `deletePolicy: keep`, and an explicit
  // `--delete` must beat a `keep` in the config file the same way.
  if (argv['delete-policy'])
    layer.deletePolicy = argv['delete-policy']
  if (argv.delete)
    layer.deletePolicy = 'mirror'
  if (argv['no-delete'] === true || argv.delete === false)
    layer.deletePolicy = 'keep'

  if (argv['rename-threshold'] !== undefined)
    layer.renameThreshold = Number(argv['rename-threshold'])
  if (argv.renames === true)
    layer.renameDetection = true
  if (argv['no-renames'] === true || argv.renames === false)
    layer.renameDetection = false

  // Large repositories: what the fetch asks the server for, and what to do with LFS pointers.
  // Every key is written only when given, so `--fetch-depth 1` does not reset the other knobs.
  const fetchLayer: Partial<FetchConfig> = {}
  if (argv['fetch-filter'])
    fetchLayer.filter = argv['fetch-filter'] as PartialFilter
  if (argv['fetch-depth'] !== undefined && argv['fetch-depth'] !== '')
    fetchLayer.depth = Number(argv['fetch-depth'])
  if (argv['fetch-tags'] !== undefined)
    fetchLayer.tags = argv['fetch-tags'] === true
  if (argv['no-fetch-tags'] === true)
    fetchLayer.tags = false
  if (argv.lfs)
    fetchLayer.lfs = argv.lfs as LfsMode
  if (Object.keys(fetchLayer).length > 0)
    layer.fetchConfig = fetchLayer as FetchConfig

  // 日志落盘：每个键单独写入，所以 `--log-file x` 不会把配置文件里的 level/json 一起清掉。
  const logLayer: Partial<LogConfig> = {}
  if (argv['log-file'])
    logLayer.file = argv['log-file']
  if (argv['log-level'])
    logLayer.level = argv['log-level'] as LogFileLevel
  if (argv['log-json'] !== undefined)
    logLayer.json = argv['log-json'] === true
  if (argv['log-max'] !== undefined && argv['log-max'] !== '')
    logLayer.maxBytes = Number(argv['log-max'])
  if (argv['log-keep'] !== undefined && argv['log-keep'] !== '')
    logLayer.keep = Number(argv['log-keep'])
  if (Object.keys(logLayer).length > 0)
    layer.logConfig = logLayer as LogConfig

  // 投递审计与队列上限：daemon 运维的两把扳手，配置里已经 `-we` 时也能单独给。
  if (argv['webhook-log'] || argv['webhook-queue'] !== undefined) {
    layer.webhookConfig = {
      ...(layer.webhookConfig as object),
      ...(argv['webhook-log'] ? { deliveryLog: argv['webhook-log'] } : {}),
      ...(argv['webhook-queue'] !== undefined ? { maxQueue: Number(argv['webhook-queue']) } : {}),
    }
  }

  // PR mode: the run commits to a generated branch, pushes it, and leaves the target branch alone.
  // `--no-pr` reaches us as its own key (`pr` is not a declared boolean), and it must be able to
  // turn off a section the config file switched on.
  if (argv.pr === false || argv['no-pr'] === true)
    layer.prConfig = { enable: false }
  if (argv.pr) {
    layer.prConfig = {
      enable: true,
      ...(argv['pr-branch'] ? { branchPattern: argv['pr-branch'] } : {}),
      ...(argv['pr-remote'] ? { remote: argv['pr-remote'] } : {}),
      ...(argv['pr-title'] ? { title: argv['pr-title'] } : {}),
      ...(argv['pr-body'] ? { body: argv['pr-body'] } : {}),
      ...(argv['pr-draft'] ? { draft: true } : {}),
      ...(argv['pr-no-create'] ? { create: 'never' } : {}),
    }
  }
  return layer as RawSyncConfig
}

/**
 * CLI > config file > defaults, then interactive completion unless -y.
 *
 * `lenient` is what the read-only diagnostics ask for: they report on a repository whose
 * configuration is missing or broken, which is exactly the situation a strict resolve refuses to
 * produce a config for. The problems come back so the caller can show them; a real sync leaves the
 * option off and still refuses to run on an invalid config.
 */
export async function resolveRuntimeConfig(
  argv: minimist.ParsedArgs,
  options: ResolveConfigOptions = {},
): Promise<{ config: SyncConfig, source: string | null, problems: string[] }> {
  const loaded = await loadConfig({
    configPath: argv.config ? String(argv.config) : undefined,
    baseDir: process.cwd(),
  })
  for (const warning of loaded.warnings) logger.warn(warning)

  const layer = cliLayer(argv)
  if (argv['conflict-strategy']) {
    layer.conflictResolutionConfig = { defaultStrategy: argv['conflict-strategy'] as ConflictResolutionStrategy }
  }

  const { config, warnings, problems } = buildConfig([loaded.layer, layer], { lenient: options.lenient })
  for (const warning of warnings) logger.warn(warning)
  return { config, source: loaded.source, problems }
}

/**
 * Log level comes from the *merged* config, so `silent: true` in a config file works the
 * same as `-s`. `--debug` is CLI-only: it escalates past `-V` (verbose) without a file
 * ever turning on debug noise by accident.
 */
export function applyLogLevel(config: SyncConfig, argv: minimist.ParsedArgs): void {
  if (config.silent)
    logger.setLevel(LogLevel.ERROR)
  else if (argv.debug)
    logger.setLevel(LogLevel.DEBUG)
  else if (config.verbose)
    logger.setLevel(LogLevel.VERBOSE)
}

/** The completion script needs the same tables `parseArgs` and `unknownFlags` use. */
export function completionSource(): CompletionSource {
  const descriptions: Record<string, string> = {}
  for (const row of SUBCOMMAND_HELP)
    descriptions[row.name] = row.description
  descriptions.init = t('sc.init')
  descriptions.completion = t('sc.completion')
  return {
    stringFlags: STRING_FLAGS,
    booleanFlags: BOOLEAN_FLAGS,
    negatableFlags: NEGATABLE_FLAGS,
    aliases: ALIASES,
    subcommands: SUBCOMMANDS,
    verbs: CLI_VERBS,
    descriptions,
  }
}

/**
 * `sync-upstream completion <bash|zsh|fish>` — stdout is the script and nothing else, so it can be
 * redirected straight into a completions directory.
 */
export function runCompletion(positional: string[]): number {
  const shell = positional[0] ?? ''
  if (!isCompletionShell(shell)) {
    logger.error(t('cli.completionUnknown', { value: shell }))
    out(yellow(t('cli.completionUsage')))
    return 2
  }
  out(completionScript(shell, completionSource()))
  return 0
}

/**
 * `sync-upstream init` — the questionnaire.
 *
 * It refuses when there is nobody to answer: under `--json` or `-y`, or with no terminal attached,
 * the alternative is a process that hangs in CI until somebody kills it.
 */
export async function runInitCommand(args: minimist.ParsedArgs): Promise<number> {
  if (args.json || args['non-interactive'] || !process.stdin.isTTY) {
    logger.error(t('cli.initNeedsTerminal'))
    return 2
  }
  try {
    const result = await runInit(
      {
        cwd: process.cwd(),
        configPath: args.config ? String(args.config) : undefined,
        format: String(args['config-format'] ?? 'json') as ConfigFormat,
        force: Boolean(args.force),
      },
      askInitPrompts,
    )
    for (const warning of result.warnings)
      logger.warn(warning)
    logger.success(t('cli.initWritten', { path: result.path }))
    return 0
  }
  catch (error) {
    // 配置文件已存在 / Ctrl+C 都按类别给出退出码，而不是抛一段栈给刚说"取消"的用户。
    if (isSyncError(error)) {
      error.report()
      return exitCodeFor(error)
    }
    throw error
  }
}

/**
 * The locale has to be settled before the first message is printed, so this runs ahead of
 * everything else in `main`. A `--lang` we do not support is reported in the language the user
 * already had — the alternative is a tool that refuses to explain itself.
 */
export function applyLocale(args: minimist.ParsedArgs): string | undefined {
  // `--lang` is a declared string flag, so minimist hands back `''` when it was never given.
  const wanted = args.lang
  if (wanted === undefined || wanted === '') {
    initLocale(undefined)
    return undefined
  }
  if (!isLocale(String(wanted)))
    return t('cli.badLang', { value: String(wanted) })
  initLocale(String(wanted))
  return undefined
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)

  const langError = applyLocale(args)
  if (langError) {
    logger.error(langError)
    return 2
  }

  if (args.version) {
    logger.success(bold(cyan(`sync-upstream v${pkg.version}`)))
    return 0
  }
  if (args.help) {
    out(helpText())
    return 0
  }
  if (args['generate-config']) {
    const target = args.config || `./sync-upstream.config.${args['config-format'] ?? 'json'}`
    const written = await generateDefaultConfig(target, args['config-format'] as never)
    logger.success(t('cli.configGenerated', { path: written }))
    return 0
  }

  const sub = subcommandOf(args)
  // `init` and `completion` are handled here rather than as read-only subcommands: neither needs a
  // config file, and both must work in a directory that does not have one yet.
  if (sub && sub.name === 'completion')
    return runCompletion(sub.positional)
  if (sub && sub.name === 'init')
    return runInitCommand(args)

  if (sub && !isSubcommand(sub.name)) {
    logger.error(t('cli.unknownSubcommand', { name: sub.name }))
    out(yellow(t('cli.subcommandHint', { list: [...SUBCOMMANDS, ...CLI_VERBS].join(', ') })))
    return 2
  }

  const unknown = unknownFlags(args)
  if (unknown.length > 0) {
    logger.error(t('cli.unknownFlags', { list: unknown.join(', ') }))
    out(yellow(t('cli.helpHint')))
    return 2
  }

  // `status`, `doctor` and `history` — and `--undo`, which only reads the state file back — are the
  // commands somebody runs *because* the setup looks broken, so an unusable config is a finding to
  // report rather than a reason to stop. `why` is the exception: its answer is the plan a real sync
  // would build, and there is no such plan without a valid configuration.
  const readOnly = Boolean(args.undo) || Boolean(sub && isSubcommand(sub.name) && sub.name !== 'why')
  const { config, source, problems } = await resolveRuntimeConfig(args, { lenient: readOnly })
  const configWarnings = readOnly
    ? problems.map(problem => t('v.lenientProblem', { problem }))
    : []
  for (const warning of configWarnings) logger.warn(warning)
  applyLogLevel(config, args)
  // Even a one-shot run can write a file: a CI job log gets thrown away with the job, and
  // "when did the last sync fail" is a question somebody asks a day later.
  configureLogging(config.logConfig, {
    secrets: [config.authConfig?.token, config.authConfig?.password, config.webhookConfig?.secret],
    cwd: process.cwd(),
  })

  // Machine mode is for CI: stdout carries one JSON document and nothing else, so the
  // progress logging has to be silenced and an interactive conflict prompt is not an option.
  const jsonMode = Boolean(args.json)
  if (jsonMode)
    logger.setLevel(LogLevel.ERROR)

  if (sub && isSubcommand(sub.name)) {
    return runSubcommand(sub.name, {
      config,
      configSource: source,
      cwd: process.cwd(),
      json: jsonMode,
      positional: sub.positional,
      flags: {
        fetch: Boolean(args.fetch),
        ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
      },
      ...(problems.length > 0 ? { configProblems: problems } : {}),
    })
  }

  if (args.undo) {
    const result = await undoSync({ config, cwd: process.cwd() })
    for (const line of formatUndoResult(result)) logger.info(line)
    const report = toReport('undo', result, {
      ok: result.reverted,
      exitCode: result.reverted ? 0 : 1,
      ...(configWarnings.length > 0 ? { warnings: configWarnings } : {}),
    })
    if (jsonMode)
      emit(report, [], true)
    return report.exitCode
  }

  // Without a repo or sync dirs there is nothing to run, so the questionnaire still steps in
  // even under `-y`; `--json` forbids that — CI must fail fast rather than wait for input.
  const incomplete = !config.upstreamRepo || config.syncDirs.length === 0
  const interactive = !jsonMode && (!config.nonInteractive || incomplete)
  const finalConfig = interactive
    ? await collectMissingOptions(config)
    : jsonMode
      ? { ...config, nonInteractive: true }
      : config

  if (!jsonMode)
    displaySummary(finalConfig, source)
  if (finalConfig.webhookConfig?.enable) {
    const { serveWebhooks } = await import('./pipeline/webhook-mode')
    return serveWebhooks(finalConfig)
  }

  const result = await runSync({
    config: finalConfig,
    cwd: process.cwd(),
    prompt: !jsonMode && finalConfig.conflictResolutionConfig.defaultStrategy === ConflictResolutionStrategy.PROMPT_USER
      ? conflictPrompt
      : undefined,
    // Only actually consulted when deletePolicy is `ask`; `--json` never gets to ask.
    confirmDeletes: jsonMode ? undefined : confirmDeletesPrompt,
  })
  const code = result.applied ? (failedChanges(result.applied).length > 0 ? 1 : 0) : 0

  const report = buildSyncReport(result, { exitCode: code })
  const summaryWarning = await appendCiSummary(report.summary ?? '')
  if (summaryWarning)
    report.warnings.push(summaryWarning)
  if (jsonMode)
    emit(report, [], true)
  return code
}

/** Fail loudly with the mapped exit code instead of a stack trace. */
export function reportFatal(error: unknown): number {
  if (isSyncError(error)) {
    error.report()
    return exitCodeFor(error)
  }
  const detail = toError(error)
  logger.error(t('e.unexpected', { message: detail.message }), detail)
  return exitCodeFor(error)
}

if (/(?:^|[\\/])cli\.[cm]?[jt]sx?$/.test(process.argv[1] ?? '')) {
  main().then(code => process.exit(code)).catch((error) => {
    process.exit(reportFatal(error))
  })
}
