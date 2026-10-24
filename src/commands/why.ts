import type { SourceFacts } from './facts'
import type { CommandContext, CommandOutput, WhyReport } from './types'
import fs from 'fs-extra'
import { bold, cyan, gray, green, magenta, red, yellow } from 'picocolors'
import { ChangeKind } from '../domain'
import { ValidationError } from '../errors'
import { extensionOf, joinRepoPath, normalizeRepoPath, scopeOf } from '../fsx/paths'
import { t } from '../i18n'
import { collectFacts } from './facts'
import { toReport } from './output'
import { shortHash } from './status'

const VERDICT_LABEL: Record<WhyReport['verdict'], { text: string, color: (value: string) => string }> = {
  'will-sync': { text: '会同步', color: green },
  'conflict': { text: '需要冲突处理', color: yellow },
  'skipped': { text: '不会同步', color: magenta },
  'unchanged': { text: '已与上游一致', color: gray },
  'unknown-path': { text: '未找到该文件', color: red },
}

/** Entries whose path is the target, or lives under it when a directory prefix was given. */
function under<T extends { path: string }>(items: T[], target: string): T[] {
  const prefix = `${target}/`
  return items.filter(item => item.path === target || item.path.startsWith(prefix))
}

function oids(values: Array<string | undefined>): string {
  const shown = values.filter(Boolean).map(value => shortHash(value))
  return shown.length > 0 ? shown.join(' → ') : '—'
}

/**
 * Which upstream answers for this path. The plan is the strongest signal (that source actually
 * has the file and compares it); a source whose sync dirs cover the path comes next, so a
 * skipped or ignored file still gets its own scope, rules and state quoted back.
 */
function pickSource(sources: SourceFacts[], target: string): SourceFacts {
  const planned = sources.find(source => source.plan
    && (under(source.plan.changes, target).length > 0
      || under(source.plan.conflicts, target).length > 0
      || under(source.plan.skipped, target).length > 0))
  return planned
    ?? sources.find(source => scopeOf(target, source.source.dirs) !== null)
    ?? sources[0]
}

/**
 * Explain one path by asking the questions the planner asked: is it in scope, is it ignored,
 * is its blob already recorded as synced, do both sides touch it? The answers come from the
 * same plan a real run would build, so `why` cannot drift from the pipeline.
 */
export async function whyCommand(context: CommandContext): Promise<CommandOutput<WhyReport>> {
  const { config, cwd, flags } = context
  const target = normalizeRepoPath(context.positional[0] ?? '')
  if (target === '')
    throw new ValidationError(t('e.whyNeedsPath'))

  const facts = await collectFacts(config, cwd, { fetch: flags.fetch })
  const { git, repo } = facts
  const chosen = pickSource(facts.sources, target)
  const source = chosen.source
  const allDirs = [...new Set(facts.sources.flatMap(item => item.source.dirs))]
  const fanIn = facts.sources.length > 1
  const covering = facts.sources.filter(item => scopeOf(target, item.source.dirs) !== null)
  const scope = scopeOf(target, source.dirs)
  const reasons: string[] = []

  const [upstreamTree, targetTree] = await Promise.all([
    chosen.upstreamRef ? git.listTree(chosen.upstreamRef, [target]) : Promise.resolve(new Map()),
    await git.branchExists(config.companyBranch)
      ? git.listTree(config.companyBranch, [target])
      : Promise.resolve(new Map()),
  ])

  const upstreamEntry = upstreamTree.get(target)
  const targetEntry = targetTree.get(target)
  const inUpstream = upstreamEntry !== undefined || upstreamTree.size > 0
  const inTarget = targetEntry !== undefined || targetTree.size > 0

  const [exists, modified, untracked, staged] = await Promise.all([
    fs.pathExists(joinRepoPath(repo.root, target)),
    git.locallyModifiedPaths([target]),
    git.untrackedPaths([target]),
    git.stagedPaths(),
  ])
  const workingTree = {
    exists,
    modified: modified.includes(target),
    untracked: untracked.includes(target),
    staged: staged.includes(target),
  }

  const plan = chosen.plan
  const planChange = plan ? under(plan.changes, target)[0] : undefined
  const planSkipped = plan ? under(plan.skipped, target)[0] : undefined
  const planConflict = plan ? under(plan.conflicts, target)[0] : undefined
  const stateEntry = chosen.syncState.snapshot.entries[target]
  const ignoreRule = chosen.ignore.ruleFor(target)

  if (fanIn)
    reasons.push(cyan(`按上游 \`${source.label}\` 回答（其同步目录：${source.dirs.join(', ') || '(空)'}）`))

  if (scope === null) {
    reasons.push(`不在任何同步目录内。当前 syncDirs: ${allDirs.join(', ') || '(空)'}`)
    reasons.push('把该目录加进 syncDirs（配置文件或 -d）后才会参与同步')
  }
  else {
    reasons.push(`属于同步目录 \`${scope}\``)
  }
  if (covering.length > 1)
    reasons.push(yellow(`${covering.length} 个上游的同步目录都覆盖该路径：${covering.map(item => item.source.label).join('、')}，按配置顺序后一个上游的内容会覆盖前一个`))

  if (!chosen.upstreamRef)
    reasons.push(`本地还没有上游数据${fanIn ? `（${source.label}）` : ''}，以下判断只看目标分支；加 --fetch 拉取上游后重试`)

  if (planChange) {
    reasons.push(`上游与目标分支的对象不同，计划动作: ${planChange.kind.toUpperCase()}（${oids([planChange.targetOid, planChange.upstreamOid])}）`)
    if (planChange.kind === ChangeKind.RENAME && planChange.fromPath)
      reasons.push(`这是上游的改名：\`${planChange.fromPath}\` → \`${planChange.path}\`（相似度 ${planChange.similarity ?? 100}%），同步方式是 git mv 而不是删掉再新增`)
    if (planChange.upstreamMode && planChange.targetMode && planChange.upstreamMode !== planChange.targetMode)
      reasons.push(`权限位也不同: ${planChange.targetMode} → ${planChange.upstreamMode}`)
    if (planChange.objectType === 'link')
      reasons.push('这是符号链接：core.symlinks=false 的仓库不会写入它（见 doctor）')
  }
  else if (planSkipped) {
    reasons.push(`计划里被跳过，原因: ${planSkipped.reason}`)
    if (planSkipped.detail)
      reasons.push(gray(planSkipped.detail))
  }
  else if (upstreamEntry && targetEntry && upstreamEntry.oid === targetEntry.oid && upstreamEntry.mode === targetEntry.mode) {
    reasons.push(`两侧一致（oid ${shortHash(upstreamEntry.oid)}，mode ${upstreamEntry.mode}），无需同步`)
    if (stateEntry)
      reasons.push(`状态文件记录: oid ${shortHash(stateEntry.upstreamOid)}${stateEntry.mode ? `，mode ${stateEntry.mode}` : ''}，同步于 ${stateEntry.syncedAt}`)
  }
  else if (!inUpstream && !inTarget) {
    reasons.push(red('上游和目标分支都不存在该路径'))
    if (exists)
      reasons.push(gray('工作区里有同名文件，但它未被跟踪，不需要同步'))
  }
  else if (!inUpstream && inTarget) {
    const movedInto = plan?.changes.find(entry => entry.kind === ChangeKind.RENAME && entry.fromPath === target)
    if (movedInto)
      reasons.push(`上游把它改名成了 \`${movedInto.path}\`：同步方式是 git mv，本地文件（含未提交改动）会跟着搬过去`)
    else
      reasons.push('目标分支有、上游没有：只有上游确实删除过它时才会生成删除动作')
  }

  if (ignoreRule)
    reasons.push(`被忽略规则命中: \`${ignoreRule.pattern}\`（来源 ${ignoreRule.source}${ignoreRule.base ? `，基准目录 ${ignoreRule.base}` : ''}）`)
  if (config.includeFileTypes.length > 0 && !config.includeFileTypes.includes(extensionOf(target)))
    reasons.push(`扩展名 ${extensionOf(target) || '(无)'} 不在 includeFileTypes: ${config.includeFileTypes.join(', ')}`)
  if (scope !== null && !config.forceOverwrite && stateEntry && !planChange)
    reasons.push(gray('增量模式生效：该 oid 已记录为同步过，除非上游内容再次变化'))
  if (planConflict)
    reasons.push(yellow(`冲突类型 ${planConflict.conflictType}：本地与上游都有改动，按策略 \`${config.conflictResolutionConfig.defaultStrategy}\` 处理`))
  if (workingTree.staged)
    reasons.push(yellow('该文件已在暂存区'))
  if (workingTree.modified && !planConflict)
    reasons.push(gray('工作区内容与 HEAD 不同（本地已修改）'))
  if (!upstreamEntry && !targetEntry && (upstreamTree.size + targetTree.size) > 0)
    reasons.push(gray(`这是个目录，其下 ${upstreamTree.size + targetTree.size} 个对象参与了比较`))

  const verdict: WhyReport['verdict'] = scope === null
    ? 'skipped'
    : planConflict
      ? 'conflict'
      : planChange
        ? 'will-sync'
        : planSkipped
          ? 'skipped'
          : inUpstream || inTarget
            ? 'unchanged'
            : 'unknown-path'

  const data: WhyReport = {
    path: target,
    verdict,
    reasons,
    scope,
    inUpstream,
    inTarget,
    basis: { label: source.label, ref: chosen.upstreamRef, revision: chosen.upstreamRevision, lastFetchAt: chosen.lastFetchAt },
    workingTree,
    ignoreRule: ignoreRule
      ? { pattern: ignoreRule.pattern, source: ignoreRule.source, base: ignoreRule.base, negated: ignoreRule.negated }
      : null,
    state: stateEntry ?? null,
    ...(planChange ? { change: planChange } : {}),
    ...(planConflict ? { conflictType: planConflict.conflictType, action: config.conflictResolutionConfig.defaultStrategy } : {}),
  }

  const lines = [
    bold(cyan(`sync-upstream why ${target}`)),
    `${VERDICT_LABEL[verdict].color(bold(VERDICT_LABEL[verdict].text))} · 依据 ${data.basis.ref ?? '（无上游快照）'} ${shortHash(data.basis.revision)}`,
    ...data.reasons.map(reason => `  ${reason}`),
    gray('提示：sync-upstream -P 查看整份计划，sync-upstream doctor 检查环境。'),
  ]

  return {
    report: toReport('why', data, {
      ok: verdict !== 'unknown-path',
      exitCode: verdict === 'unknown-path' ? 1 : 0,
    }),
    lines,
  }
}
