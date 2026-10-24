import type { SyncSource } from '../pipeline/sources'
import type { CommandContext, CommandOutput, HistoryEntryOut, HistoryFileFacts, HistoryReport } from './types'
import path from 'node:path'
import fs from 'fs-extra'
import { bold, cyan, dim, gray, green, red, yellow } from 'picocolors'
import { sourcesOf } from '../pipeline/sources'
import { openRepository } from './facts'
import { toReport } from './output'

/** Newest first, which is the order `--undo` consumes them. */
function toRecords(data: Record<string, any> | undefined, source: SyncSource, file: string): HistoryEntryOut[] {
  const history = Array.isArray(data?.history) ? data.history : []
  return history.map(record => ({
    commit: String(record.commit ?? ''),
    shortCommit: String(record.commit ?? '').slice(0, 8),
    source: String(record.source ?? ''),
    label: source.label,
    file,
    branch: String(record.branch ?? ''),
    syncedAt: String(record.syncedAt ?? ''),
    files: Number(record.files ?? 0),
    paths: Array.isArray(record.paths) ? record.paths : [],
    baseCommit: String(record.baseCommit ?? ''),
    exists: true,
    isLastSync: String(record.commit ?? '') === String(data?.lastSyncCommit ?? ''),
  }))
}

function identityOf(data: Record<string, any> | undefined, source: SyncSource): HistoryFileFacts['identity'] {
  return {
    upstreamRepo: String(data?.upstreamRepo ?? source.repo),
    upstreamBranch: String(data?.upstreamBranch ?? source.ref),
    companyBranch: String(data?.companyBranch ?? ''),
  }
}

export async function historyCommand(context: CommandContext): Promise<CommandOutput<HistoryReport>> {
  const { config, cwd, json } = context
  const git = openRepository(config, cwd)
  const root = await git.repoRoot().catch(() => cwd)
  const limit = Math.max(1, context.flags.limit ?? 10)
  const sources = sourcesOf(config)

  const files: HistoryFileFacts[] = []
  const all: HistoryEntryOut[] = []
  let entries = 0

  for (const source of sources) {
    const file = path.join(root, source.stateFile)
    const facts: HistoryFileFacts = {
      file: source.stateFile,
      label: source.label,
      exists: false,
      readable: true,
      identity: identityOf(undefined, source),
      entries: 0,
      total: 0,
    }
    files.push(facts)
    if (!(await fs.pathExists(file)))
      continue
    facts.exists = true

    let data: Record<string, any>
    try {
      data = await fs.readJson(file)
    }
    catch (error) {
      facts.readable = false
      facts.error = (error as Error).message
      continue
    }

    facts.identity = identityOf(data, source)
    facts.entries = Object.keys(data.entries ?? {}).length
    const records = toRecords(data, source, source.stateFile)
    facts.total = records.length
    entries += facts.entries
    all.push(...records)
  }

  const unreadable = files.find(file => !file.readable)
  if (all.length === 0 && files.every(file => !file.exists)) {
    const base: HistoryReport = { files, exists: false, entries: 0, total: 0, limit, records: [] }
    return {
      report: toReport('history', base, { ok: true }),
      lines: [
        bold(cyan('sync-upstream history')),
        gray(`状态文件尚未生成：${files.map(file => path.join(root, file.file)).join('、')}`),
        gray('完成一次同步后，这里会列出每次同步生成的 commit、来源与文件数。'),
      ],
    }
  }

  if (unreadable) {
    const base: HistoryReport = { files, exists: true, entries, total: all.length, limit, records: [], error: unreadable.error }
    return {
      report: toReport('history', base, { ok: false, exitCode: 1, warnings: [`状态文件无法解析: ${base.error}`] }),
      lines: [
        bold(cyan('sync-upstream history')),
        red(`状态文件无法解析：${unreadable.file}`),
        gray(unreadable.error ?? ''),
        yellow('确认没有正在运行的同步后删除该文件，下次同步会重新建立增量状态。'),
      ],
    }
  }

  // A commit can be garbage-collected or branch-rewritten; `--undo` must not promise a
  // restore of something git no longer has.
  await Promise.all(all.map(async (record) => {
    record.exists = record.commit === '' ? false : await git.objectExists(record.commit)
  }))

  const merged = all.sort((a, b) => b.syncedAt.localeCompare(a.syncedAt))
  const shown = merged.slice(0, limit)
  const head = await git.head().catch(() => '')
  const fanIn = sources.length > 1

  const data: HistoryReport = { files, exists: true, entries, total: merged.length, limit, records: shown }

  const lines = [bold(cyan(`sync-upstream history · ${files.map(file => file.file).join('、')}`))]
  if (fanIn) {
    for (const file of files) {
      lines.push(dim(`· ${file.label}：${file.file} · ${file.entries} 个增量记录 · 历史 ${file.total} 次`))
    }
  }
  else {
    lines.push(`共 ${merged.length} 条记录，显示最近 ${shown.length} 条 · 增量状态 ${entries} 个文件`)
    lines.push(dim(`身份：${files[0]?.identity.upstreamBranch || '(未知)'} → ${files[0]?.identity.companyBranch || '(未知)'} · ${files[0]?.identity.upstreamRepo || '(未知)'}`))
  }
  for (const record of shown) {
    const mark = record.isLastSync ? green('●') : dim('○')
    const undone = record.commit !== '' && record.commit === head.slice(0, record.commit.length) ? ' · 当前 HEAD' : ''
    lines.push(
      `${mark} ${bold(record.shortCommit)} ${dim(record.syncedAt)} ${fanIn ? `${record.label} · ` : ''}${record.source} · ${record.files} 个文件 · 分支 ${record.branch}`
      + `${record.exists ? '' : yellow('（commit 已不可用）')}${undone ? gray(undone) : ''}`,
    )
    if (json || config.verbose)
      lines.push(dim(`    base ${record.baseCommit.slice(0, 8)} · 文件 ${record.paths.slice(0, 8).join(', ')}${record.paths.length > 8 ? ` … +${record.paths.length - 8}` : ''}`))
  }
  if (merged.length > shown.length)
    lines.push(gray(`… 其余 ${merged.length - shown.length} 条（--limit ${merged.length} 查看全部）`))
  lines.push(dim('手工回退最近一次同步：git revert <commit>；或使用 sync-upstream --undo。'))

  return { report: toReport('history', data, { ok: true }), lines }
}
