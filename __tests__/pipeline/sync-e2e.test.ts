import type { ConflictDecision, RepoPath, SyncConfig } from '../../src/domain'
import type { Fixture } from '../helpers/repo'
import path from 'node:path'
import fs from 'fs-extra'
import { resolveConfig } from '../../src/config/resolve'
import { ChangeKind, ConflictResolutionStrategy, ConflictType } from '../../src/domain'
import { compileIgnorePatterns, IgnoreMatcher } from '../../src/fsx/ignore-rules'
import { loadIgnoreMatcher } from '../../src/fsx/ignore-source'
import { applyChanges, failedChanges } from '../../src/pipeline/apply'
import { commitChanges } from '../../src/pipeline/commit'
import { buildPlan } from '../../src/pipeline/plan'
import { formatApplyResult, formatCommitResult, formatPlan } from '../../src/pipeline/preview'
import { SyncState } from '../../src/pipeline/sync-state'
import { createFixture } from '../helpers/repo'

const SYNC_DIRS = ['src/config']
/** b.ts(+), both.txt(~), notes.md(~), temp.tmp(~), gone.ts(-) */
const EXPECTED_PATHS = [
  'src/config/b.ts',
  'src/config/both.txt',
  'src/config/gone.ts',
  'src/config/notes.md',
  'src/config/temp.tmp',
]

let fixture: Fixture
let config: SyncConfig

beforeEach(async () => {
  fixture = await createBaseFixture()
  config = baseConfig()
})

afterEach(async () => {
  await fixture?.cleanup()
})

/**
 * base(main) ─┬─ upstream: 新增 b.ts、修改 both/notes/temp、删除 gone
 *             └─ company: 同步目标分支（工作区所在分支）
 */
async function createBaseFixture(): Promise<Fixture> {
  const repo = await createFixture('main')

  await repo.write('src/config/a.ts', 'a base\n')
  await repo.write('src/config/both.txt', 'shared\n')
  await repo.write('src/config/gone.ts', 'to be deleted\n')
  await repo.write('src/config/notes.md', '# doc\n')
  await repo.write('src/config/temp.tmp', 'scratch\n')
  await repo.write('src/ui/other.ts', 'outside scope\n')
  await repo.commitAll('base')

  await repo.gitRaw(['checkout', '-q', '-b', 'upstream'])
  await repo.write('src/config/b.ts', 'b from upstream\n')
  await repo.write('src/config/both.txt', 'shared from upstream\n')
  await repo.write('src/config/temp.tmp', 'scratch upstream\n')
  await repo.write('src/config/notes.md', '# doc upstream\n')
  await repo.write('src/ui/other.ts', 'changed outside scope\n')
  await repo.gitRaw(['rm', '-q', '--', 'src/config/gone.ts'])
  await repo.commitAll('upstream work')

  await repo.gitRaw(['checkout', '-q', 'main'])
  await repo.gitRaw(['branch', 'company'])
  await repo.gitRaw(['checkout', '-q', 'company'])
  return repo
}

function baseConfig(overrides: Record<string, unknown> = {}): SyncConfig {
  const { config: resolved } = resolveConfig({
    upstreamRepo: fixture.root,
    upstreamBranch: 'upstream',
    companyBranch: 'company',
    syncDirs: SYNC_DIRS,
    ...overrides,
  })
  return resolved
}

async function ignoreFor(cfg: SyncConfig): Promise<IgnoreMatcher> {
  const loaded = await loadIgnoreMatcher({
    repoRoot: fixture.root,
    scopes: cfg.syncDirs,
    configPatterns: cfg.ignorePatterns,
  })
  return loaded.matcher
}

async function makePlan(overrides: Record<string, unknown> = {}, state?: SyncState) {
  const cfg = Object.keys(overrides).length > 0 ? baseConfig(overrides) : config
  return buildPlan({
    git: fixture.git,
    config: cfg,
    upstreamRef: 'upstream',
    ignore: await ignoreFor(cfg),
    state,
  })
}

function decision(path: RepoPath, action: ConflictDecision['action'], mergedContent?: string): ConflictDecision {
  return { path, conflictType: ConflictType.CONTENT, strategy: ConflictResolutionStrategy.AUTO_MERGE, action, mergedContent }
}

async function runSync(
  decisions: Map<RepoPath, ConflictDecision> = new Map(),
  overrides: Record<string, unknown> = {},
  state?: SyncState,
) {
  const plan = await makePlan(overrides, state)
  const result = await applyChanges({
    git: fixture.git,
    upstreamRef: 'upstream',
    repoRoot: fixture.root,
    plan,
    decisions,
  })
  const commit = await commitChanges({ git: fixture.git, plan, result, message: 'chore: sync upstream' })
  return { plan, result, commit }
}

function nameStatus(hash: string): string[] {
  return fixture.gitRaw(['show', '--name-status', '--format=', hash]).split(/\r?\n/).filter(Boolean).sort()
}

/** picocolors keeps ANSI codes when the terminal supports colour; assertions read plain text. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function plain(text: string): string {
  return text.replace(ANSI, '')
}

describe('端到端同步：新增 / 修改 / 删除', () => {
  it('计划只包含同步目录内的真实差异', async () => {
    const kinds = new Map((await makePlan()).changes.map(entry => [entry.path, entry.kind]))

    expect(kinds.get('src/config/b.ts')).toBe(ChangeKind.ADD)
    expect(kinds.get('src/config/both.txt')).toBe(ChangeKind.MODIFY)
    expect(kinds.get('src/config/gone.ts')).toBe(ChangeKind.DELETE)
    expect(kinds.get('src/config/notes.md')).toBe(ChangeKind.MODIFY)
    expect(kinds.get('src/config/a.ts')).toBeUndefined()
    expect(kinds.has('src/ui/other.ts')).toBe(false)
  })

  it('应用并提交后，工作区、索引与目标分支都与上游一致', async () => {
    const { commit } = await runSync()

    expect(commit.created).toBe(true)
    expect(commit.stagedCount).toBe(5)
    expect(await fixture.read('src/config/b.ts')).toBe('b from upstream\n')
    expect(await fixture.exists('src/config/gone.ts')).toBe(false)
    expect(nameStatus('HEAD')).toEqual([
      'A\tsrc/config/b.ts',
      'D\tsrc/config/gone.ts',
      'M\tsrc/config/both.txt',
      'M\tsrc/config/notes.md',
      'M\tsrc/config/temp.tmp',
    ])

    expect(await fixture.git.stagedPaths()).toEqual([])
    expect(await fixture.git.currentBranch()).toBe('company')
    expect(await fixture.read('src/ui/other.ts')).toBe('outside scope\n')
  })

  it('同步一次后计划为空，重复执行不产生空提交', async () => {
    await runSync()
    const second = await runSync()

    expect(second.plan.changes).toHaveLength(0)
    expect(second.commit.created).toBe(false)
    expect(second.commit.reason).toContain('没有需要同步的变更')
  })
})

describe('端到端同步：忽略规则与文件类型白名单', () => {
  it('ignorePatterns 命中的文件只跳过不改动', async () => {
    const { plan, commit } = await runSync(new Map(), { ignorePatterns: ['*.tmp'] })

    expect(plan.skipped).toEqual([{ path: 'src/config/temp.tmp', reason: 'ignored' }])
    expect(plan.changes.map(entry => entry.path)).not.toContain('src/config/temp.tmp')
    expect(await fixture.read('src/config/temp.tmp')).toBe('scratch\n')
    expect(commit.stagedCount).toBe(4)
  })

  it('同步目录内的 .gitignore 按子树生效（问题③：路径解析基准统一）', async () => {
    await fixture.write('src/config/.gitignore', 'generated/\n*.bak\n')
    await fixture.commitAll('local gitignore')

    const loaded = await loadIgnoreMatcher({ repoRoot: fixture.root, scopes: config.syncDirs })
    expect(loaded.files).toContain('src/config/.gitignore')
    expect(loaded.matcher.isIgnored('src/config/generated/x.js')).toBe(true)
    expect(loaded.matcher.isIgnored('src/config/x.bak')).toBe(true)
    expect(loaded.matcher.isIgnored('docs/generated/x.js')).toBe(false)
  })

  it('includeFileTypes 只保留白名单扩展名', async () => {
    const plan = await makePlan({ includeFileTypes: ['ts'] })

    expect(plan.changes.map(entry => entry.path).sort()).toEqual(['src/config/b.ts', 'src/config/gone.ts'])
    expect(plan.skipped.filter(item => item.reason === 'file-type').map(item => item.path).sort())
      .toEqual(['src/config/both.txt', 'src/config/notes.md', 'src/config/temp.tmp'])
  })
})

describe('端到端同步：冲突处理', () => {
  it('本地与上游都改过的文件报 CONTENT 冲突，并带上 merge base 的 oid', async () => {
    await fixture.write('src/config/both.txt', 'local edit\n')

    const plan = await makePlan()
    const conflict = plan.conflicts.find(item => item.path === 'src/config/both.txt')
    expect(conflict?.conflictType).toBe(ConflictType.CONTENT)
    expect(conflict?.baseOid).toBeTruthy()
    expect(conflict?.upstreamOid).toBeTruthy()
    expect(plan.dirty).toContain('src/config/both.txt')
  })

  it('keep-local 保留本地内容，其余文件照常同步', async () => {
    await fixture.write('src/config/both.txt', 'local edit\n')
    const { result, commit } = await runSync(
      new Map([['src/config/both.txt', decision('src/config/both.txt', 'keep-local')]]),
    )

    expect(result.applied.find(item => item.entry.path === 'src/config/both.txt')?.status).toBe('kept-target')
    expect(await fixture.read('src/config/both.txt')).toBe('local edit\n')
    expect(commit.stagedCount).toBe(4)
  })

  it('take-upstream 覆盖本地改动', async () => {
    await fixture.write('src/config/both.txt', 'local edit\n')
    const { commit } = await runSync(
      new Map([['src/config/both.txt', decision('src/config/both.txt', 'take-upstream')]]),
    )

    expect(await fixture.read('src/config/both.txt')).toBe('shared from upstream\n')
    expect(commit.stagedCount).toBe(5)
  })

  it('write-merged 写入合并结果并暂存', async () => {
    await fixture.write('src/config/both.txt', 'local edit\n')

    const merged = 'local edit\nshared from upstream'
    const { commit } = await runSync(
      new Map([['src/config/both.txt', decision('src/config/both.txt', 'write-merged', `${merged}\n`)]]),
    )

    expect(await fixture.read('src/config/both.txt')).toBe(`${merged}\n`)
    expect(fixture.gitRaw(['show', 'HEAD:src/config/both.txt'])).toBe(merged)
    expect(commit.created).toBe(true)
  })

  it('本地同名目录会被上游文件替换（TYPE 冲突）', async () => {
    await fixture.write('src/config/clash/inside.ts', 'dir content\n')
    await fixture.commitAll('local directory')

    await fixture.gitRaw(['checkout', '-q', 'upstream'])
    await fixture.write('src/config/clash', 'upstream file\n')
    await fixture.commitAll('upstream: clash becomes a file')
    await fixture.gitRaw(['checkout', '-q', 'company'])

    const plan = await makePlan()
    expect(plan.conflicts.find(item => item.conflictType === ConflictType.TYPE)?.path).toBe('src/config/clash')

    const { commit } = await runSync()
    expect(commit.created).toBe(true)
    expect(await fixture.read('src/config/clash')).toBe('upstream file\n')
    expect(await fixture.exists('src/config/clash/inside.ts')).toBe(false)
  })

  it('未跟踪的本地文件与上游同名时给出 UNTRACKED_OVERWRITE', async () => {
    await fixture.write('src/config/b.ts', 'untracked local\n')

    const plan = await makePlan()
    expect(plan.conflicts.find(item => item.path === 'src/config/b.ts')?.conflictType)
      .toBe(ConflictType.UNTRACKED_OVERWRITE)
  })
})

describe('端到端同步：增量状态（问题④）', () => {
  it('forceOverwrite=false 时第二次运行按 blob oid 跳过已同步文件', async () => {
    const statePath = path.join(fixture.root, '.sync-state.json')
    const state = await SyncState.load(statePath, fixture.root, 'upstream')

    const first = await runSync(new Map(), { forceOverwrite: false }, state)
    expect(first.commit.created).toBe(true)
    state.record(first.result.applied)
    await state.save()

    const reloaded = await SyncState.load(statePath, fixture.root, 'upstream')
    expect(reloaded.size).toBeGreaterThan(0)

    const second = await makePlan({ forceOverwrite: false }, reloaded)
    expect(second.changes).toHaveLength(0)
    expect(second.skipped.every(item => item.reason === 'already-synced')).toBe(true)
  })

  it('上游新增提交后，增量同步只搬运新文件', async () => {
    const statePath = path.join(fixture.root, '.sync-state.json')
    const state = await SyncState.load(statePath, fixture.root, 'upstream')
    const first = await runSync(new Map(), { forceOverwrite: false }, state)
    state.record(first.result.applied)
    await state.save()

    await fixture.gitRaw(['checkout', '-q', 'upstream'])
    await fixture.write('src/config/c.ts', 'third\n')
    await fixture.commitAll('upstream adds c.ts')
    await fixture.gitRaw(['checkout', '-q', 'company'])

    const reloaded = await SyncState.load(statePath, fixture.root, 'upstream')
    const plan = await makePlan({ forceOverwrite: false }, reloaded)
    expect(plan.changes.map(entry => entry.path)).toEqual(['src/config/c.ts'])
  })

  it('换仓库或换分支时旧状态失效；损坏的状态文件报可定位错误', async () => {
    const statePath = path.join(fixture.root, '.sync-state.json')
    const state = await SyncState.load(statePath, fixture.root, 'upstream')
    const first = await runSync(new Map(), { forceOverwrite: false }, state)
    state.record(first.result.applied)
    await state.save()

    expect((await SyncState.load(statePath, 'https://example.com/other.git', 'upstream')).size).toBe(0)
    expect((await SyncState.load(statePath, fixture.root, 'release')).size).toBe(0)

    const corrupt = path.join(fixture.root, 'broken-state.json')
    await fs.writeFile(corrupt, '{ not json', 'utf8')
    await expect(SyncState.load(corrupt, fixture.root, 'upstream')).rejects.toThrow(/状态文件/)
  })
})

describe('提交判定回归：未跟踪的工具产物不算变更', () => {
  it('存在 .sync-cache 与配置文件时，空计划依然不提交', async () => {
    await fixture.write('.sync-cache/whatever.json', '{}\n')
    await fixture.write('sync-upstream.json', '{}\n')
    await fixture.write('src/config/brand-new.ts', 'untracked in scope\n')

    const plan = await makePlan({ syncDirs: ['docs'] })
    const result = await applyChanges({
      git: fixture.git,
      upstreamRef: 'upstream',
      repoRoot: fixture.root,
      plan,
      decisions: new Map(),
    })
    const commit = await commitChanges({ git: fixture.git, plan, result, message: 'noop' })

    expect(plan.changes).toHaveLength(0)
    expect(commit.created).toBe(false)
    expect(fixture.gitRaw(['status', '--porcelain'])).toContain('??')
  })

  it('别人已经暂存的文件不会被这次同步顺手提交', async () => {
    await fixture.write('src/config/a.ts', 'someone else staged\n')
    await fixture.git.addPaths(['src/config/a.ts'])

    const { commit } = await runSync()

    expect(fixture.gitRaw(['show', '--name-only', '--format=', 'HEAD'])).not.toContain('src/config/a.ts')
    expect(await fixture.git.stagedPaths()).toEqual(['src/config/a.ts'])
    expect(commit.created).toBe(true)
  })

  it('单个文件应用失败时逐路径重试，其他文件仍然完成', async () => {
    const plan = await makePlan()
    const brokenPath = 'src/config/missing-in-upstream.ts'
    plan.changes.push({ kind: ChangeKind.ADD, path: brokenPath, scope: 'src/config' })

    const result = await applyChanges({
      git: fixture.git,
      upstreamRef: 'upstream',
      repoRoot: fixture.root,
      plan,
      decisions: new Map(),
      concurrencyLimit: 2,
    })

    expect(failedChanges(result).map(item => item.entry.path)).toEqual([brokenPath])
    expect(result.applied.filter(item => item.status === 'applied').map(item => item.entry.path).sort())
      .toEqual([...EXPECTED_PATHS].sort())
  })
})

describe('预览输出与实际执行一致', () => {
  it('formatPlan 的 +/- 列表与最终提交的文件集合一致', async () => {
    const plan = await makePlan()
    const lines = formatPlan(plan).map(plain)

    expect(lines[0]).toContain('5 项变更')
    expect(lines.some(line => line.includes('+ src/config/b.ts'))).toBe(true)
    expect(lines.some(line => line.includes('- src/config/gone.ts'))).toBe(true)
    expect(lines.some(line => line.includes('~ src/config/both.txt'))).toBe(true)

    const { commit, result } = await runSync()
    expect(plain(formatApplyResult(result)[0])).toContain('5 个文件写入')
    expect(plain(formatCommitResult(commit)[0])).toContain(`已提交 ${commit.hash?.slice(0, 8)}`)
    expect(fixture.gitRaw(['diff', '--name-only', 'HEAD~1', 'HEAD']).split(/\r?\n/).sort())
      .toEqual(EXPECTED_PATHS.sort())
  })

  it('省略提示只在实际截断时出现（--verbose 传 Infinity 拿到完整列表）', async () => {
    const plan = await makePlan()

    expect(formatPlan(plan, 2).map(plain).some(line => line.includes('项省略'))).toBe(true)
    const full = formatPlan(plan, Number.POSITIVE_INFINITY).map(plain)
    expect(full.some(line => line.includes('项省略'))).toBe(false)
    expect(full.filter(line => /^[+~-] /.test(line))).toHaveLength(5)
  })

  it('忽略与冲突信息在预览里分组显示', async () => {
    await fixture.write('src/config/both.txt', 'local edit\n')
    const lines = formatPlan(await makePlan({ ignorePatterns: ['*.tmp'] })).map(plain)

    expect(lines.some(line => line.includes('冲突: 1 个文件'))).toBe(true)
    expect(lines.some(line => line.includes('跳过 1 个文件 — 被忽略规则排除'))).toBe(true)
    expect(lines.some(line => line.includes('本地已修改文件 1 个'))).toBe(true)
  })

  it('空忽略规则不影响计划', async () => {
    const plan = await buildPlan({
      git: fixture.git,
      config,
      upstreamRef: 'upstream',
      ignore: new IgnoreMatcher(compileIgnorePatterns([])),
    })

    expect(plan.changes).toHaveLength(EXPECTED_PATHS.length)
    expect(plan.skipped).toEqual([])
  })
})
