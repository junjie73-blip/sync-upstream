import type { SyncConfig } from '../domain'
import type { SourceFacts } from './facts'
import type { CommandContext, CommandOutput, ConfigFacts, PlanFacts, StatusReport, StatusSource } from './types'
import { bold, cyan, dim, gray, green, magenta, red, yellow } from 'picocolors'
import { redacted } from '../git/url'
import { resolvedKind } from '../pipeline/upstream-ref'
import { collectFacts } from './facts'
import { stripAnsi, toReport } from './output'

/** What the user actually asked for, minus the parts that only matter for a real run. */
export function configFacts(config: SyncConfig, source: string | null): ConfigFacts {
  return {
    source,
    syncDirs: config.syncDirs,
    forceOverwrite: config.forceOverwrite,
    previewOnly: config.previewOnly,
    dryRun: config.dryRun,
    autoPush: config.autoPush,
    nonInteractive: config.nonInteractive,
    verbose: config.verbose,
    silent: config.silent,
    lockWaitMs: config.lockWaitMs,
    concurrencyLimit: config.concurrencyLimit,
    ignorePatterns: config.ignorePatterns,
    includeFileTypes: config.includeFileTypes,
    conflictStrategy: config.conflictResolutionConfig.defaultStrategy,
    deletePolicy: config.deletePolicy,
    renameDetection: config.renameDetection,
    renameThreshold: config.renameThreshold,
    fetch: {
      filter: config.fetchConfig?.filter ?? 'none',
      depth: config.fetchConfig?.depth ?? null,
      tags: config.fetchConfig?.tags ?? false,
      lfs: config.fetchConfig?.lfs ?? 'pointer',
    },
    ...(config.prConfig?.enable
      ? { prMode: `分支 ${config.prConfig.branchPattern ?? 'sync-upstream/{target}-{date}'} · PR 创建 ${config.prConfig.create === 'never' ? '不自动' : '自动'}` }
      : {}),
    ...(config.conflictResolutionConfig.resolutionLogFile
      ? { resolutionLogFile: config.conflictResolutionConfig.resolutionLogFile }
      : {}),
    ...(config.branchStrategyConfig?.enable
      ? { branchStrategy: `${config.branchStrategyConfig.strategy} ← ${config.branchStrategyConfig.baseBranch}` }
      : {}),
    ...(config.grayReleaseConfig?.enable
      ? { grayRelease: `${config.grayReleaseConfig.strategy} ${config.grayReleaseConfig.percentage ?? 100}%` }
      : {}),
    ...(config.webhookConfig?.enable
      ? { webhook: `${config.webhookConfig.host ?? '127.0.0.1'}:${config.webhookConfig.port}${config.webhookConfig.path}` }
      : {}),
    ...(config.notifyConfig?.enable
      ? { notify: `${config.notifyConfig.channels.join(',')} · ${config.notifyConfig.events.join(',')}` }
      : {}),
    ...(config.upstreams?.length
      ? { upstreams: config.upstreams.filter(Boolean).length }
      : {}),
    ...(config.authConfig?.type ? { authType: config.authConfig.type } : {}),
  }
}

export function groupSkipped(plan: PlanFacts): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of plan.skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1)
  return counts
}

export function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 8) : '—'
}

const KIND_WORD: Record<StatusSource['kind'], string> = { branch: '分支', tag: '标签', revision: '提交' }

function row(label: string, value: string): string {
  return `${dim(label.padEnd(10))} ${value}`
}

const KIND_MARK: Record<string, (value: string) => string> = {
  add: value => green(`+ ${value}`),
  modify: value => yellow(`~ ${value}`),
  delete: value => red(`- ${value}`),
  rename: value => cyan(`> ${value}`),
}

/** A rename is only readable when both halves are on the line. */
function changeLabel(change: PlanFacts['changes'][number]): string {
  const marker = KIND_MARK[change.kind] ?? (value => gray(`? ${value}`))
  return marker(change.fromPath ? `${change.fromPath} → ${change.path}` : change.path)
}

/** One line for the large-repository knobs, phrased as what the operator will notice. */
function fetchRow(fetch: StatusReport['config']['fetch']): string {
  const parts: string[] = []
  if (fetch.filter === 'blob')
    parts.push('部分抓取 blob:none（不下载文件内容对象）')
  else if (fetch.filter === 'tree')
    parts.push(red('部分抓取 tree:0（逐个回源取对象，可能更慢）'))
  if (fetch.depth !== null)
    parts.push(yellow(`浅抓取 depth=${fetch.depth}（本地历史变浅，改名识别已关闭）`))
  if (fetch.tags)
    parts.push('带标签')
  if (fetch.lfs === 'materialize')
    parts.push('LFS 取回真实内容')
  else if (fetch.lfs === 'off')
    parts.push(gray('LFS 不检测'))
  return parts.length > 0 ? parts.join(' · ') : '完整抓取'
}

function snapshotRow(source: StatusSource): string {
  return source.ref
    ? `${source.ref} · ${shortHash(source.revision)}${source.lastFetchAt ? ` · 抓取于 ${source.lastFetchAt}` : ''}`
    : yellow('尚未拉取（运行 sync-upstream status --fetch 或 sync-upstream -P）')
}

function stateRow(source: StatusSource): string {
  const state = source.state
  if (!state.exists)
    return gray('尚未生成（首次同步后出现）')
  return `${state.file} · ${state.entries} 条记录 · 历史 ${state.history} 次 · 最近同步 ${state.lastSyncedAt ?? '未知'} · commit ${shortHash(state.lastSyncCommit)}`
    + `${state.identityMatches ? '' : magenta(' · 身份不匹配，本次将被忽略')}`
    + `${state.readable ? '' : red(` · 无法解析：${state.error}`)}`
}

/** Everything a single upstream contributes to the human report. */
function sourceLines(source: StatusSource, verbose: boolean): string[] {
  const lines = [
    row('上游', `${redacted(source.repo)} @ ${source.branch}${source.kind === 'branch' ? '' : gray(`（${KIND_WORD[source.kind]}）`)}`),
    row('本地快照', snapshotRow(source)),
    row('同步目录', source.dirs.join(', ') || red('(未配置)')),
  ]

  const plan = source.plan
  if (plan) {
    const { add, modify, delete: removed, rename, conflict, skipped } = plan.summary
    lines.push(row('待同步', `${green(`+${add}`)} ${yellow(`~${modify}`)} ${red(`-${removed}`)} ${cyan(`>${rename}`)} · 冲突 ${conflict} · 跳过 ${skipped}`))
    const behind = plan.upstreamCommitsAhead === null ? '无法比较' : `${plan.upstreamCommitsAhead} 个提交`
    const ahead = plan.targetCommitsAhead === null ? '无法比较' : `${plan.targetCommitsAhead} 个提交`
    lines.push(row('提交差距', `上游领先 ${behind} · 本地领先 ${ahead}`))
    if (plan.dirty.length > 0)
      lines.push(row('本地改动', yellow(`${plan.dirty.length} 个同步目录内文件已被本地修改`)))
    const groups = groupSkipped(plan)
    if (groups.size > 0)
      lines.push(row('跳过原因', [...groups].map(([reason, count]) => `${reason}=${count}`).join(' · ')))
    if (plan.conflicts.length > 0) {
      const shown = plan.conflicts.slice(0, verbose ? plan.conflicts.length : 10)
      lines.push(row('冲突文件', shown.map(item => `${item.path} [${item.conflictType}]`).join(', ') + (shown.length < plan.conflicts.length ? gray(' …') : '')))
    }
    const changes = verbose ? plan.changes : plan.changes.slice(0, 10)
    for (const change of changes) lines.push(`  ${changeLabel(change)}`)
    if (!verbose && plan.changes.length > changes.length)
      lines.push(`  ${gray(`… 其余 ${plan.changes.length - changes.length} 项（--verbose 查看完整列表）`)}`)
  }
  else if (source.note) {
    lines.push(row('计划', yellow(source.note)))
  }

  lines.push(row('状态文件', stateRow(source)))
  return lines
}

/** Human rendering; `--json` users get the same facts as a document instead. */
export function renderStatus(data: StatusReport, verbose: boolean): string[] {
  const lines: string[] = []
  const { repo, lock } = data
  lines.push(bold(cyan('sync-upstream status')))
  lines.push(row('仓库', repo.root))
  lines.push(row('当前分支', `${repo.currentBranch} · HEAD ${shortHash(repo.head)}`))
  lines.push(row('目标分支', data.targetBranch))
  if (data.sources.length > 1)
    lines.push(row('上游数量', `${data.sources.length} 个（多上游 fan-in，每个上游各一个提交）`))

  data.sources.forEach((source, index) => {
    if (data.sources.length > 1)
      lines.push('', bold(cyan(`源 ${index + 1}/${data.sources.length} · ${source.label}`)))
    lines.push(...sourceLines(source, verbose))
  })

  lines.push(row(
    '仓库锁',
    lock.held
      ? `${red('被占用')} pid ${lock.holder?.pid} · ${lock.holder?.label} · 开始于 ${lock.holder?.createdAt}${lock.holder?.stale ? yellow('（持有者已退出，可被接管）') : ''}`
      : green('空闲'),
  ))
  lines.push(row('配置', `${data.config.source ?? '（无配置文件）'} · ${data.config.forceOverwrite ? '强制覆盖' : '增量'} · 自动推送 ${data.config.autoPush ? '开' : '关'} · 冲突策略 ${data.config.conflictStrategy}`))
  lines.push(row('删除/改名', `删除 ${data.config.deletePolicy} · 改名识别 ${data.config.renameDetection ? `开（${data.config.renameThreshold}%）` : '关'}`))
  // Only worth a line when it differs from "fetch everything", which is the default.
  if (data.config.fetch.filter !== 'none' || data.config.fetch.depth !== null || data.config.fetch.tags || data.config.fetch.lfs !== 'pointer')
    lines.push(row('抓取', fetchRow(data.config.fetch)))
  lines.push(dim('下一步：sync-upstream -P 看完整计划；sync-upstream why <文件> 问某个文件为什么同步/不同步。'))
  return lines
}

/** Markdown for `$GITHUB_STEP_SUMMARY` — the numbers CI people want to glance at. */
export function statusMarkdown(data: StatusReport, warnings: string[] = []): string {
  const lines = ['### sync-upstream status', '', `- 目标分支：\`${data.targetBranch}\``]
  // The two policy rows the terminal shows: a CI reviewer has to be able to tell "nothing to do"
  // from "nothing to do *because deletions are being kept and the fetch was shallow*".
  lines.push(`- 删除策略：\`${data.config.deletePolicy}\` · 改名识别 ${data.config.renameDetection ? `开（${data.config.renameThreshold}%）` : '关'}`)
  if (data.config.fetch.filter !== 'none' || data.config.fetch.depth !== null || data.config.fetch.tags || data.config.fetch.lfs !== 'pointer')
    lines.push(`- 抓取：${stripAnsi(fetchRow(data.config.fetch))}`)
  for (const source of data.sources) {
    lines.push(
      `- 上游：\`${redacted(source.repo)}\` @ \`${source.branch}\`（${KIND_WORD[source.kind]}，本地快照 \`${shortHash(source.revision)}\`）`
      + ` · 同步目录：${source.dirs.map(dir => `\`${dir}\``).join(', ')}`,
    )
    const plan = source.plan
    if (plan) {
      lines.push(`  - 待同步：新增 ${plan.summary.add}、修改 ${plan.summary.modify}、重命名 ${plan.summary.rename}、删除 ${plan.summary.delete}、冲突 ${plan.summary.conflict}、跳过 ${plan.summary.skipped}`)
      if (plan.upstreamCommitsAhead !== null)
        lines.push(`  - 上游领先 ${plan.upstreamCommitsAhead} 个提交`)
      const changed = plan.changes.slice(0, 20).map(change => `  - \`${change.path}\`（${change.kind}）`).join('\n')
      if (changed)
        lines.push(changed)
    }
    else {
      lines.push(`  - 计划不可用：${source.note ?? '尚未拉取上游'}`)
    }
  }
  if (warnings.length > 0)
    lines.push(`- 提醒：${warnings.join('；')}`)
  return lines.join('\n')
}

function noteFor(source: SourceFacts, targetBranch: string): string {
  return source.upstreamRef
    ? `目标分支 ${targetBranch} 尚不存在，无法计算计划`
    : '本地还没有上游数据，加 --fetch 拉取后重试'
}

/** Report view of one source. `remoteUrl` is the only field that costs a git call. */
async function statusSource(
  facts: SourceFacts,
  remoteUrl: string | undefined,
  targetBranch: string,
): Promise<StatusSource> {
  const { source } = facts
  return {
    label: source.label,
    repo: source.repo,
    branch: source.ref,
    kind: resolvedKind(source.source, facts.upstreamRef),
    remote: source.remote,
    ...(remoteUrl ? { remoteUrl: redacted(remoteUrl) } : {}),
    dirs: source.dirs,
    ref: facts.upstreamRef,
    revision: facts.upstreamRevision,
    lastFetchAt: facts.lastFetchAt,
    state: facts.state,
    plan: facts.plan,
    ...(facts.plan ? {} : { note: noteFor(facts, targetBranch) }),
  }
}

export async function statusCommand(context: CommandContext): Promise<CommandOutput<StatusReport>> {
  const { config, cwd, configSource, flags } = context
  const facts = await collectFacts(config, cwd, { fetch: flags.fetch })

  const sources: StatusSource[] = []
  for (const item of facts.sources) {
    // Each source owns its remote name, so the URL shown next to it is the one it fetches from.
    const remoteUrl = await facts.git.remoteUrl(item.source.remote).catch(() => undefined)
    sources.push(await statusSource(item, remoteUrl, config.companyBranch))
  }

  const data: StatusReport = {
    repo: facts.repo,
    targetBranch: config.companyBranch,
    config: configFacts(config, configSource),
    syncDirs: config.syncDirs,
    lock: facts.lock,
    sources,
  }

  return {
    report: toReport('status', data, {
      ok: true,
      warnings: facts.warnings,
      summary: statusMarkdown(data, facts.warnings),
    }),
    lines: renderStatus(data, config.verbose),
  }
}
