import type { ChangeEntry, ConflictDecision, RepoPath, SyncConfig, SyncPlan } from '../../src/domain'
import type { SyncStateIdentity } from '../../src/pipeline/sync-state'
import type { Fixture } from '../helpers/repo'
import path from 'node:path'
import { resolveConfig } from '../../src/config/resolve'
import { ChangeKind, ConflictResolutionStrategy, ConflictType } from '../../src/domain'
import { loadIgnoreMatcher } from '../../src/fsx/ignore-source'
import { applyChanges } from '../../src/pipeline/apply'
import { commitChanges } from '../../src/pipeline/commit'
import { buildPlan } from '../../src/pipeline/plan'
import { formatPlan } from '../../src/pipeline/preview'
import { SyncState } from '../../src/pipeline/sync-state'
import { createFixture } from '../helpers/repo'

/**
 * 上游改名的落地方式：一条 RENAME 计划 + 一次 `git mv`。
 * 计划层比较的是两棵树的 blob，看不见"搬家"；只有 `git diff -M` 看得见，所以改名识别是
 * 叠在树比较之上的一层。折叠不上时退回删除 + 新增，绝不能只搬半边。
 */
const SCOPE = 'src/config'
const LONG_BEFORE = [
  'first line',
  'second line',
  'third line',
  'fourth line',
  'fifth line',
  'sixth line',
  '',
].join('\n')
const LONG_AFTER = LONG_BEFORE.replace('third line', 'third line from upstream')

let fixture: Fixture

beforeEach(async () => {
  fixture = await createFixture('main')
  await fixture.write('src/config/plain.ts', 'plain\n')
  await fixture.write('src/config/long.ts', LONG_BEFORE)
  await fixture.write('src/config/keep.ts', 'keep\n')
  await fixture.write('src/config/nested/other.ts', 'other\n')
  await fixture.write('src/ui/outside.ts', 'outside\n')
  await fixture.commitAll('base')

  await fixture.branch('upstream')
  await fixture.branch('company')
  await fixture.gitRaw(['checkout', '-q', 'company'])
})

afterEach(async () => {
  await fixture?.cleanup()
})

/** 在上游分支上做一次改动，然后回到目标分支，如同真实仓库里的又一次推送。 */
async function onUpstream(change: () => unknown): Promise<void> {
  await fixture.gitRaw(['checkout', '-q', 'upstream'])
  await change()
  await fixture.commitAll('upstream work')
  await fixture.gitRaw(['checkout', '-q', 'company'])
}

/** 改名 + 改内容：先 mv 再改新路径，git 才会把它报成 R0xx 而不是 D + A。 */
async function moveAndEdit(from: string, to: string, content: string): Promise<void> {
  await onUpstream(async () => {
    await fixture.gitRaw(['mv', from, to])
    await fixture.write(to, content)
  })
}

function baseConfig(overrides: Record<string, unknown> = {}): SyncConfig {
  return resolveConfig({
    upstreamRepo: fixture.root,
    upstreamBranch: 'upstream',
    companyBranch: 'company',
    syncDirs: [SCOPE],
    nonInteractive: true,
    ...overrides,
  }).config
}

async function makePlan(overrides: Record<string, unknown> = {}, state?: SyncState): Promise<SyncPlan> {
  const config = baseConfig(overrides)
  const loaded = await loadIgnoreMatcher({
    repoRoot: fixture.root,
    scopes: config.syncDirs,
    configPatterns: config.ignorePatterns,
  })
  return buildPlan({
    git: fixture.git,
    config,
    upstreamRef: 'upstream',
    ignore: loaded.matcher,
    state,
  })
}

async function runSync(
  overrides: Record<string, unknown> = {},
  decisions: Map<RepoPath, ConflictDecision> = new Map(),
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
  const commit = await commitChanges({ git: fixture.git, plan, result, message: 'chore(sync): 同步上游' })
  return { plan, result, commit }
}

function entryOf(changes: ChangeEntry[], repoPath: RepoPath): ChangeEntry | undefined {
  return changes.find(entry => entry.path === repoPath || entry.fromPath === repoPath)
}

function nameStatus(hash: string): string[] {
  return fixture.gitRaw(['show', '--name-status', '--format=', hash]).split(/\r?\n/).filter(Boolean).sort()
}

function decision(path: RepoPath, type: ConflictType, strategy: ConflictResolutionStrategy, action: ConflictDecision['action']): ConflictDecision {
  return { path, conflictType: type, strategy, action }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
function plain(text: string): string {
  return text.replace(ANSI, '')
}

describe('上游改名：折叠成一条计划', () => {
  it('纯搬家在计划里是 RENAME，不再是"删除一个 + 新增一个"', async () => {
    await onUpstream(() => fixture.gitRaw(['mv', 'src/config/plain.ts', 'src/config/moved.ts']))

    const plan = await makePlan()

    expect(plan.changes.map(entry => entry.path)).toEqual(['src/config/moved.ts'])
    expect(entryOf(plan.changes, 'src/config/plain.ts')).toMatchObject({
      kind: ChangeKind.RENAME,
      fromPath: 'src/config/plain.ts',
      similarity: 100,
    })
    expect(plan.changes.filter(entry => entry.kind === ChangeKind.DELETE)).toEqual([])
    expect(plan.conflicts).toEqual([])
  })

  it('应用后旧路径消失、新路径是上游内容，提交本身就是一次改名', async () => {
    await onUpstream(() => fixture.gitRaw(['mv', 'src/config/plain.ts', 'src/config/moved.ts']))

    const { commit } = await runSync()

    expect(commit.created).toBe(true)
    expect(await fixture.exists('src/config/plain.ts')).toBe(false)
    expect(await fixture.read('src/config/moved.ts')).toBe('plain\n')
    expect(nameStatus('HEAD')).toEqual(['R100\tsrc/config/plain.ts\tsrc/config/moved.ts'])
    // 目录外与无差异的文件一个都不碰。
    expect(await fixture.read('src/config/keep.ts')).toBe('keep\n')
    expect(await fixture.read('src/ui/outside.ts')).toBe('outside\n')
  })

  it('改名跨进子目录同样按 mv 落地', async () => {
    await onUpstream(() => fixture.gitRaw(['mv', 'src/config/plain.ts', 'src/config/nested/plain.ts']))

    const { commit } = await runSync()

    expect(commit.created).toBe(true)
    expect(await fixture.exists('src/config/plain.ts')).toBe(false)
    expect(await fixture.read('src/config/nested/plain.ts')).toBe('plain\n')
    expect(await fixture.read('src/config/nested/other.ts')).toBe('other\n')
  })

  it('纯搬家把本地未提交的改动一起带到新路径，不报冲突', async () => {
    await onUpstream(() => fixture.gitRaw(['mv', 'src/config/plain.ts', 'src/config/moved.ts']))
    await fixture.write('src/config/plain.ts', 'plain\nlocal work in progress\n')

    const plan = await makePlan()
    expect(plan.conflicts).toEqual([])

    const { commit } = await runSync()

    expect(commit.created).toBe(true)
    expect(await fixture.exists('src/config/plain.ts')).toBe(false)
    expect(await fixture.read('src/config/moved.ts')).toContain('local work in progress')
  })

  it('改名同时改内容：新路径写入上游版本', async () => {
    await moveAndEdit('src/config/long.ts', 'src/config/story.ts', LONG_AFTER)

    const plan = await makePlan()
    const entry = entryOf(plan.changes, 'src/config/story.ts')
    expect(entry).toMatchObject({ kind: ChangeKind.RENAME, fromPath: 'src/config/long.ts' })
    expect(entry?.similarity).toBeLessThan(100)

    const { commit } = await runSync()

    expect(commit.created).toBe(true)
    expect(await fixture.read('src/config/story.ts')).toBe(LONG_AFTER)
    expect(await fixture.exists('src/config/long.ts')).toBe(false)
  })

  it('上游改了内容、本地也在改旧路径时给出 DELETE_MODIFY 冲突，保留本地即整个取消搬家', async () => {
    await moveAndEdit('src/config/long.ts', 'src/config/story.ts', LONG_AFTER)
    await fixture.write('src/config/long.ts', `${LONG_BEFORE.replace('fifth line', 'fifth line local')}\n`)

    const plan = await makePlan()
    expect(plan.conflicts.find(conflict => conflict.path === 'src/config/story.ts')?.conflictType)
      .toBe(ConflictType.DELETE_MODIFY)

    const { result } = await runSync({}, new Map([
      ['src/config/story.ts', decision('src/config/story.ts', ConflictType.DELETE_MODIFY, ConflictResolutionStrategy.KEEP_TARGET, 'keep-local')],
    ]))

    // 搬家是一个整体：不能只把新路径写上、把旧路径留着。
    expect(result.applied.find(item => item.entry.path === 'src/config/story.ts')?.status).toBe('kept-target')
    expect(await fixture.exists('src/config/story.ts')).toBe(false)
    expect(await fixture.read('src/config/long.ts')).toContain('fifth line local')
  })

  it('新路径被未跟踪文件占用时报 UNTRACKED_OVERWRITE，跳过后两边都在', async () => {
    await onUpstream(() => fixture.gitRaw(['mv', 'src/config/plain.ts', 'src/config/moved.ts']))
    await fixture.write('src/config/moved.ts', 'mine\n')

    const plan = await makePlan()
    expect(plan.conflicts.find(conflict => conflict.path === 'src/config/moved.ts')?.conflictType)
      .toBe(ConflictType.UNTRACKED_OVERWRITE)

    const { result } = await runSync({}, new Map([
      ['src/config/moved.ts', decision('src/config/moved.ts', ConflictType.UNTRACKED_OVERWRITE, ConflictResolutionStrategy.SKIP, 'skip')],
    ]))

    expect(result.applied.find(item => item.entry.path === 'src/config/moved.ts')?.status).toBe('kept-target')
    expect(await fixture.read('src/config/moved.ts')).toBe('mine\n')
    expect(await fixture.read('src/config/plain.ts')).toBe('plain\n')
    expect(fixture.gitRaw(['status', '--porcelain']).split(/\r?\n/).some(line => line.startsWith('??') && line.includes('moved.ts')))
      .toBe(true)
  })

  it('相似度低于阈值时不认作改名，退回删除 + 新增', async () => {
    await moveAndEdit('src/config/long.ts', 'src/config/story.ts', 'totally rewritten\nfrom scratch\n')

    const plan = await makePlan()

    expect(plan.changes.filter(entry => entry.kind === ChangeKind.RENAME)).toEqual([])
    expect(entryOf(plan.changes, 'src/config/long.ts')?.kind).toBe(ChangeKind.DELETE)
    expect(entryOf(plan.changes, 'src/config/story.ts')?.kind).toBe(ChangeKind.ADD)
  })

  it('--no-renames 关闭识别后，改名按删除加新增落地，本地改动保不住', async () => {
    await onUpstream(() => fixture.gitRaw(['mv', 'src/config/plain.ts', 'src/config/moved.ts']))

    const plan = await makePlan({ renameDetection: false })
    expect(entryOf(plan.changes, 'src/config/plain.ts')?.kind).toBe(ChangeKind.DELETE)
    expect(entryOf(plan.changes, 'src/config/moved.ts')?.kind).toBe(ChangeKind.ADD)

    // 这正是识别改名的理由：旧路径当删除处理，未提交的本地改动跟着一起没。
    await fixture.write('src/config/plain.ts', 'plain\nlocal work in progress\n')
    const { commit } = await runSync({ renameDetection: false })

    expect(commit.created).toBe(true)
    expect(await fixture.exists('src/config/plain.ts')).toBe(false)
    expect(await fixture.read('src/config/moved.ts')).toBe('plain\n')
  })

  it('阈值可以压低：更小的相似度也认作改名', async () => {
    await moveAndEdit('src/config/long.ts', 'src/config/story.ts', 'first line\nsecond line\nthird line\nx\ny\nz\n')

    const strict = await makePlan()
    expect(strict.changes.filter(entry => entry.kind === ChangeKind.RENAME)).toEqual([])

    const loose = await makePlan({ renameThreshold: 30 })
    expect(entryOf(loose.changes, 'src/config/story.ts')?.kind).toBe(ChangeKind.RENAME)
  })

  it('预览里改名是 "> 旧 → 新"，与实际落地一致', async () => {
    await onUpstream(() => fixture.gitRaw(['mv', 'src/config/plain.ts', 'src/config/moved.ts']))

    const plan = await makePlan()
    const formatted = formatPlan(plan, Number.POSITIVE_INFINITY).map(plain).join('\n')

    expect(plan.changes).toHaveLength(1)
    expect(formatted).toContain('> src/config/plain.ts → src/config/moved.ts')
    expect(formatted).toContain('100%')
  })
})

describe('上游改名：与增量状态、忽略规则相处', () => {
  it('第二次运行没有变更，改名不会被再搬一次', async () => {
    await onUpstream(() => fixture.gitRaw(['mv', 'src/config/plain.ts', 'src/config/moved.ts']))
    await runSync()

    const again = await runSync()

    expect(again.plan.changes).toHaveLength(0)
    expect(again.commit.created).toBe(false)
    expect(await fixture.exists('src/config/moved.ts')).toBe(true)
    expect(await fixture.exists('src/config/plain.ts')).toBe(false)
  })

  it('增量状态把旧路径的记录换成新路径，换回去的改名也不会漏掉', async () => {
    const identity: SyncStateIdentity = {
      upstreamRepo: fixture.root,
      upstreamBranch: 'upstream',
      companyBranch: 'company',
    }
    const state = await SyncState.load(path.join(fixture.root, '.sync-state.json'), identity)

    await onUpstream(() => fixture.gitRaw(['mv', 'src/config/plain.ts', 'src/config/moved.ts']))
    const first = await runSync({ forceOverwrite: false }, new Map(), state)
    expect(first.commit.created).toBe(true)
    state.record(first.result.applied)
    await state.save()

    const after = await SyncState.load(path.join(fixture.root, '.sync-state.json'), identity)
    expect(Object.keys(after.snapshot.entries)).toEqual(['src/config/moved.ts'])

    const second = await runSync({ forceOverwrite: false }, new Map(), after)
    expect(second.plan.changes).toHaveLength(0)
    expect(second.plan.skipped.every(item => item.reason === 'already-synced')).toBe(true)

    // 上游又把名字换回来：目标分支上 moved.ts 有记录、plain.ts 没有，配对仍然成立。
    await onUpstream(() => fixture.gitRaw(['mv', 'src/config/moved.ts', 'src/config/plain.ts']))
    const third = await runSync({ forceOverwrite: false }, new Map(), after)
    expect(entryOf(third.plan.changes, 'src/config/moved.ts')?.kind).toBe(ChangeKind.RENAME)
    expect(await fixture.read('src/config/plain.ts')).toBe('plain\n')
    expect(await fixture.exists('src/config/moved.ts')).toBe(false)
  })

  it('改名的一半被忽略规则排除时，另一半也不会被单独搬走', async () => {
    await moveAndEdit('src/config/plain.ts', 'src/config/moved.ts', 'plain\nextra\n')

    const plan = await makePlan({ ignorePatterns: ['src/config/moved.ts'] })

    expect(plan.skipped.map(item => item.path)).toContain('src/config/moved.ts')
    expect(plan.changes.filter(entry => entry.kind === ChangeKind.RENAME)).toEqual([])
    expect(entryOf(plan.changes, 'src/config/plain.ts')?.kind).toBe(ChangeKind.DELETE)
  })
})
