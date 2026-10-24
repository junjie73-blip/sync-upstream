import type { SyncStateData } from '../../src/pipeline/sync-state'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { ChangeKind } from '../../src/domain'
import { SYNC_STATE_FILE, SyncState } from '../../src/pipeline/sync-state'

let tmpDir: string
const REPO = 'https://example.com/upstream.git'
const BRANCH = 'main'
const TARGET = 'company'
const IDENTITY = { upstreamRepo: REPO, upstreamBranch: BRANCH, companyBranch: TARGET }

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-state-'))
})

afterEach(async () => {
  await fs.remove(tmpDir).catch(() => undefined)
})

function statePath(name = SYNC_STATE_FILE): string {
  return path.join(tmpDir, name)
}

describe('SyncState', () => {
  it('首次使用时写入的自身份必须能被下一次读取复用', async () => {
    const filePath = statePath()
    const fresh = await SyncState.load(filePath, IDENTITY)
    expect(fresh.size).toBe(0)

    fresh.record([
      { entry: { kind: ChangeKind.ADD, path: 'src/a.ts', scope: 'src', upstreamOid: 'aaa' }, status: 'applied' },
      { entry: { kind: ChangeKind.MODIFY, path: 'src/b.ts', scope: 'src', upstreamOid: 'bbb' }, status: 'applied' },
    ])
    await fresh.save()

    const reloaded = await SyncState.load(filePath, IDENTITY)
    expect(reloaded.size).toBe(2)
    expect(reloaded.isSynced('src/a.ts', 'aaa')).toBe(true)
    expect(reloaded.isSynced('src/a.ts', 'changed')).toBe(false)
  })

  it('kept-target 与 failed 都不写入状态，删除则移除记录', async () => {
    const filePath = statePath()
    const state = await SyncState.load(filePath, IDENTITY)
    state.record([
      { entry: { kind: ChangeKind.ADD, path: 'src/kept.ts', scope: 'src', upstreamOid: 'k' }, status: 'kept-target' },
      { entry: { kind: ChangeKind.ADD, path: 'src/failed.ts', scope: 'src', upstreamOid: 'f' }, status: 'failed', error: 'boom' },
      { entry: { kind: ChangeKind.ADD, path: 'src/ok.ts', scope: 'src', upstreamOid: 'o' }, status: 'applied' },
    ])
    state.record([
      { entry: { kind: ChangeKind.DELETE, path: 'src/ok.ts', scope: 'src', targetOid: 'o' }, status: 'applied' },
    ])
    await state.save()

    const persisted = await fs.readJson(filePath) as SyncStateData
    expect(Object.keys(persisted.entries)).toEqual([])
    expect(persisted.version).toBe(2)
    expect(persisted.companyBranch).toBe(TARGET)
  })

  it('没有 upstreamOid 的条目不会被记录（否则永远无法判定已同步）', async () => {
    const state = await SyncState.load(statePath(), IDENTITY)
    state.record([{ entry: { kind: ChangeKind.MODIFY, path: 'src/x.ts', scope: 'src' }, status: 'applied' }])
    expect(state.size).toBe(0)
  })

  it('换仓库、换上游分支、换目标分支、版本不符时状态作废', async () => {
    const filePath = statePath()
    const state = await SyncState.load(filePath, IDENTITY)
    state.record([{ entry: { kind: ChangeKind.ADD, path: 'src/a.ts', scope: 'src', upstreamOid: 'a' }, status: 'applied' }])
    await state.save()

    expect((await SyncState.load(filePath, { ...IDENTITY, upstreamRepo: 'https://other.git' })).size).toBe(0)
    expect((await SyncState.load(filePath, { ...IDENTITY, upstreamBranch: 'release' })).size).toBe(0)
    // 同一个 checkout 里两条目标分支必须各自记账，否则会互相冒领"已同步"
    expect((await SyncState.load(filePath, { ...IDENTITY, companyBranch: 'company-beta' })).size).toBe(0)

    await fs.writeJson(filePath, { version: 3, upstreamRepo: REPO, upstreamBranch: BRANCH, companyBranch: TARGET, entries: { 'src/a.ts': { upstreamOid: 'a', syncedAt: '' } } })
    expect((await SyncState.load(filePath, IDENTITY)).size).toBe(0)
  })

  it('v1 旧格式（无 mode、无目标分支）自动迁移并保留已同步记录', async () => {
    const filePath = statePath('v1.json')
    await fs.writeJson(filePath, {
      version: 1,
      upstreamRepo: REPO,
      upstreamBranch: BRANCH,
      entries: { 'src/legacy.ts': { upstreamOid: 'legacy', syncedAt: '2020-01-01T00:00:00.000Z' } },
    })

    const state = await SyncState.load(filePath, IDENTITY)
    expect(state.size).toBe(1)
    // 旧记录没有 mode，只能按 oid 匹配，不能因为缺 mode 就判未同步
    expect(state.isSynced('src/legacy.ts', 'legacy', '100755')).toBe(true)
    expect(state.snapshot.version).toBe(2)

    await state.save()
    expect((await fs.readJson(filePath)).version).toBe(2)
  })

  it('mode 参与判定：内容没变但可执行位变了必须重新同步', async () => {
    const state = await SyncState.load(statePath(), IDENTITY)
    state.record([
      { entry: { kind: ChangeKind.ADD, path: 'src/run.sh', scope: 'src', upstreamOid: 'x', upstreamMode: '100755' }, status: 'applied' },
    ])

    expect(state.isSynced('src/run.sh', 'x', '100755')).toBe(true)
    expect(state.isSynced('src/run.sh', 'x', '100644')).toBe(false)
    // 计划里没带 mode（例如迁移数据）时退回 oid 判定，不做无理由的全量重放
    expect(state.isSynced('src/run.sh', 'x')).toBe(true)
  })

  it('损坏的状态文件报可定位错误，而不是当作空状态继续跑', async () => {
    const filePath = statePath('broken.json')
    await fs.writeFile(filePath, '{ oops', 'utf8')
    await expect(SyncState.load(filePath, IDENTITY)).rejects.toThrow(/同步状态文件无法读取/)
  })

  it('save 走临时文件改名，读者永远看不到半截文件', async () => {
    const filePath = statePath('atomic.json')
    const state = await SyncState.load(filePath, IDENTITY)
    state.record([{ entry: { kind: ChangeKind.ADD, path: 'src/a.ts', scope: 'src', upstreamOid: 'a' }, status: 'applied' }])
    await state.save()

    expect(await fs.pathExists(filePath)).toBe(true)
    expect((await fs.readdir(tmpDir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('forget 批量清除记录（回滚时使用）', async () => {
    const state = await SyncState.load(statePath(), IDENTITY)
    state.record([
      { entry: { kind: ChangeKind.ADD, path: 'src/a.ts', scope: 'src', upstreamOid: 'a' }, status: 'applied' },
      { entry: { kind: ChangeKind.ADD, path: 'src/b.ts', scope: 'src', upstreamOid: 'b' }, status: 'applied' },
    ])
    state.forget(['src/a.ts'])
    expect(state.size).toBe(1)
    expect(state.isSynced('src/b.ts', 'b')).toBe(true)
  })

  it('empty() 也携带仓库身份，写入后可被同参数读取', async () => {
    const filePath = statePath('from-empty.json')
    const state = SyncState.empty(filePath, IDENTITY)
    state.record([{ entry: { kind: ChangeKind.ADD, path: 'src/z.ts', scope: 'src', upstreamOid: 'z' }, status: 'applied' }])
    await state.save()

    expect((await SyncState.load(filePath, IDENTITY)).size).toBe(1)
  })

  it('两个实例各自持有 entries/history，不共享模块级容器', () => {
    const first = SyncState.empty(statePath('first.json'), IDENTITY)
    const second = SyncState.empty(statePath('second.json'), IDENTITY)

    first.record([{ entry: { kind: ChangeKind.ADD, path: 'src/a.ts', scope: 'src', upstreamOid: 'a' }, status: 'applied' }])
    first.recordSyncCommit({ commit: 'aaa', source: BRANCH, files: 1, paths: ['src/a.ts'], baseCommit: 'base', branch: TARGET })

    expect(second.size).toBe(0)
    expect(second.history).toEqual([])
    expect(second.lastSyncCommit).toBeUndefined()
  })

  it('同步历史追加即成为最新记录，pop 后回退到上一条', () => {
    const state = SyncState.empty(statePath(), IDENTITY)
    expect(state.lastSyncCommit).toBeUndefined()

    const record = (commit: string, paths: string[]) => ({
      commit,
      source: BRANCH,
      upstreamOid: `${commit}-oid`,
      files: paths.length,
      paths,
      baseCommit: 'base-commit',
      branch: TARGET,
    })
    state.recordSyncCommit(record('aaa', ['src/a.ts']))
    state.recordSyncCommit(record('bbb', ['src/b.ts']))
    expect(state.lastSyncCommit).toBe('bbb')
    expect(state.history.map(item => item.commit)).toEqual(['bbb', 'aaa'])
    expect(state.history[0].paths).toEqual(['src/b.ts'])

    expect(state.popSyncCommit()?.commit).toBe('bbb')
    expect(state.lastSyncCommit).toBe('aaa')
    expect(state.history.map(item => item.commit)).toEqual(['aaa'])
    expect(state.popSyncCommit()?.commit).toBe('aaa')
    expect(state.lastSyncCommit).toBeUndefined()
    expect(state.popSyncCommit()).toBeUndefined()
  })

  it('历史按 HISTORY_LIMIT 截断，文件不会无限增长', () => {
    const state = SyncState.empty(statePath(), IDENTITY)
    for (let index = 0; index < 60; index++) {
      state.recordSyncCommit({
        commit: `c${index}`,
        source: BRANCH,
        files: 0,
        paths: [],
        baseCommit: 'base',
        branch: TARGET,
      })
    }
    expect(state.history.length).toBe(50)
    expect(state.history[0].commit).toBe('c59')
  })
})
