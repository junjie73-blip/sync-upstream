import type { SyncConfig } from '../../src/domain'
import type { Fixture } from '../helpers/repo'
import { resolveConfig } from '../../src/config/resolve'
import { ConflictResolutionStrategy, GrayReleaseStrategy } from '../../src/domain'
import { GitError } from '../../src/errors'
import { SyncOrchestrator, UPSTREAM_REMOTE } from '../../src/pipeline/orchestrator'
import { createFixture } from '../helpers/repo'

let up: Fixture
let down: Fixture

const SHARED = {
  'src/config/a.ts': 'line one\nline two\nline three\n',
  'src/config/b.md': '# b\n',
  'src/ui/x.ts': 'ui\n',
  'README.md': '# readme\n',
}

beforeEach(async () => {
  up = await createFixture('main')
  for (const [repoPath, content] of Object.entries(SHARED))
    await up.write(repoPath, content)
  await up.commitAll('upstream base')

  down = await createFixture('seed')
  await down.git.ensureRemote('origin', up.root)
  await down.git.fetch('origin', 'main')
  down.gitRaw(['checkout', '-q', '--no-track', '-b', 'company', 'FETCH_HEAD'])
})

afterEach(async () => {
  await Promise.all([up?.cleanup(), down?.cleanup()])
})

function config(overrides: Record<string, unknown> = {}): SyncConfig {
  const { config: resolved } = resolveConfig({
    upstreamRepo: up.root,
    upstreamBranch: 'main',
    companyBranch: 'company',
    syncDirs: ['src/config'],
    nonInteractive: true,
    ...overrides,
  })
  return resolved
}

/** Let upstream drift the way a real fork does: add / modify / delete, plus out-of-scope noise. */
async function upstreamDrift(): Promise<void> {
  await up.gitRaw(['checkout', '-q', 'main'])
  await up.write('src/config/new.ts', 'brand new\n')
  await up.write('src/config/a.ts', 'line one\nline two\nline three upstream\n')
  await up.write('src/ui/x.ts', 'ui upstream\n')
  await up.write('docs/ignored.md', 'out of scope\n')
  await up.gitRaw(['rm', '-q', '--', 'src/config/b.md'])
  await up.commitAll('upstream drift')
}

const EXPECTED_SYNCED = ['src/config/a.ts', 'src/config/b.md', 'src/config/new.ts']

describe('SyncOrchestrator 预览', () => {
  it('previewOnly 只给出计划，不碰工作区、不建提交', async () => {
    await upstreamDrift()

    const result = await new SyncOrchestrator({ config: config({ previewOnly: true }), cwd: down.root }).run()

    expect(result.previewed).toBe(true)
    expect(result.applied).toBeUndefined()
    expect(result.plan.changes.map(entry => entry.path).sort()).toEqual(EXPECTED_SYNCED)
    expect(down.gitRaw(['rev-parse', 'HEAD'])).toBe(down.gitRaw(['rev-parse', 'company']))
    expect(await down.exists('src/config/new.ts')).toBe(false)
    expect(await down.read('src/config/a.ts')).toBe(SHARED['src/config/a.ts'])
    // 上游仓库只被读取过，没有多出一个提交。
    expect(up.gitRaw(['rev-list', '--count', 'main'])).toBe('2')
  })

  it('预览不切换分支，真实同步才落在目标分支上', async () => {
    await upstreamDrift()
    down.gitRaw(['checkout', '-q', '-b', 'side-branch'])

    const preview = await new SyncOrchestrator({ config: config({ previewOnly: true }), cwd: down.root }).run()

    expect(preview.previewed).toBe(true)
    expect(down.gitRaw(['branch', '--show-current'])).toBe('side-branch')
    // 计划比较的是 company 分支的对象库，与 HEAD 在哪无关。
    expect(preview.plan.changes.map(entry => entry.path).sort()).toEqual(EXPECTED_SYNCED)

    await new SyncOrchestrator({ config: config(), cwd: down.root }).run()
    expect(down.gitRaw(['branch', '--show-current'])).toBe('company')
  })

  it('会建立独立的上游 remote，绝不动用户的 origin', async () => {
    await upstreamDrift()
    await new SyncOrchestrator({ config: config({ previewOnly: true }), cwd: down.root }).run()

    expect(down.gitRaw(['remote', 'get-url', UPSTREAM_REMOTE])).toBe(up.root)
    expect(down.gitRaw(['remote', 'get-url', 'origin'])).toBe(up.root)
    expect(down.gitRaw(['branch', '--show-current'])).toBe('company')
  })

  it('上游分支不存在时报出可操作的错误', async () => {
    const run = () => new SyncOrchestrator({
      config: config({ upstreamBranch: 'no-such-branch', previewOnly: true }),
      cwd: down.root,
    }).run()

    await expect(run()).rejects.toBeInstanceOf(GitError)
    await expect(run()).rejects.toThrow(/no-such-branch[\s\S]*远端分支不存在/)
  })

  it('目标分支既不在本地也不在 origin 时提示先创建', async () => {
    await expect(
      new SyncOrchestrator({ config: config({ companyBranch: 'nope', previewOnly: true }), cwd: down.root }).run(),
    ).rejects.toThrow(/既不在本地也不在 origin/)
  })
})

describe('SyncOrchestrator 实际同步', () => {
  it('提交内容与上游一致，且第二次运行不再产生提交', async () => {
    await upstreamDrift()

    const first = await new SyncOrchestrator({ config: config(), cwd: down.root }).run()
    expect(first.commit?.created).toBe(true)
    expect(first.commit?.stagedCount).toBe(3)
    expect(await down.read('src/config/a.ts')).toBe('line one\nline two\nline three upstream\n')
    expect(await down.exists('src/config/b.md')).toBe(false)
    expect(await down.read('src/ui/x.ts')).toBe('ui\n')

    const second = await new SyncOrchestrator({ config: config(), cwd: down.root }).run()
    expect(second.commit?.created).toBe(false)
    expect(down.gitRaw(['rev-list', '--count', 'company'])).toBe('2')
  })

  it('上游同内容搬家（删除+新增配对成重命名）时，旧路径不会残留在分支上', async () => {
    const content = await up.read('src/config/a.ts')
    up.gitRaw(['mv', 'src/config/a.ts', 'src/config/moved.ts'])
    up.commitAll('upstream moves a file')

    const { commit } = await new SyncOrchestrator({ config: config(), cwd: down.root }).run()

    expect(commit?.created).toBe(true)
    expect(await down.exists('src/config/a.ts')).toBe(false)
    expect(await down.read('src/config/moved.ts')).toBe(content)
    // 提交后同步目录必须与上游一模一样，git 的重命名配对不能吞掉删除的一半。
    expect(down.gitRaw(['diff', '--name-only', `${UPSTREAM_REMOTE}/main`, 'HEAD', '--', 'src/config']).trim()).toBe('')
  })

  it('增量模式下状态文件落在仓库根，第二次运行只搬运新文件', async () => {
    await upstreamDrift()
    const incremental = config({ forceOverwrite: false })

    const first = await new SyncOrchestrator({ config: incremental, cwd: down.root }).run()
    expect(first.commit?.created).toBe(true)
    expect(await down.exists('.sync-state.json')).toBe(true)

    await up.gitRaw(['checkout', '-q', 'main'])
    await up.write('src/config/c.ts', 'third\n')
    await up.commitAll('upstream adds c.ts')

    const second = await new SyncOrchestrator({ config: incremental, cwd: down.root }).run()
    expect(second.plan.changes.map(entry => entry.path)).toEqual(['src/config/c.ts'])
  })

  it('autoPush 会把同步提交推到分支对应的远端', async () => {
    await upstreamDrift()
    const pushFixture = await createFixture('push-seed')
    try {
      await down.git.ensureRemote('origin', pushFixture.root)
      const result = await new SyncOrchestrator({ config: config({ autoPush: true }), cwd: down.root }).run()
      expect(result.commit?.created).toBe(true)
      expect(pushFixture.gitRaw(['rev-parse', 'company'])).toBe(result.commit?.hash)
    }
    finally {
      await pushFixture.cleanup()
    }
  })
})

describe('SyncOrchestrator 冲突决策', () => {
  async function diverge(): Promise<void> {
    await upstreamDrift()
    await down.write('src/config/a.ts', 'line one local\nline two\nline three\n')
  }

  it('非交互式 + PROMPT_USER 时按保留本地降级，并给出告警', async () => {
    await diverge()

    const result = await new SyncOrchestrator({ config: config(), cwd: down.root }).run()
    const decision = result.decisions.find(item => item.path === 'src/config/a.ts')

    expect(decision?.action).toBe('keep-local')
    expect(await down.read('src/config/a.ts')).toBe('line one local\nline two\nline three\n')
    expect(await down.read('src/config/new.ts')).toBe('brand new\n')
  })

  it('USE_SOURCE 采用上游版本', async () => {
    await diverge()

    await new SyncOrchestrator({
      config: config({ conflictResolutionConfig: { defaultStrategy: ConflictResolutionStrategy.USE_SOURCE } }),
      cwd: down.root,
    }).run()

    expect(await down.read('src/config/a.ts')).toBe('line one\nline two\nline three upstream\n')
  })

  it('AUTO_MERGE 合并互不冲突的两侧改动', async () => {
    await upstreamDrift()
    await down.write('src/config/a.ts', 'line one local\nline two\nline three\n')

    await new SyncOrchestrator({
      config: config({ conflictResolutionConfig: { defaultStrategy: ConflictResolutionStrategy.AUTO_MERGE } }),
      cwd: down.root,
    }).run()

    expect(await down.read('src/config/a.ts')).toBe('line one local\nline two\nline three upstream\n')
  })

  it('SKIP 保留本地并继续同步其他文件', async () => {
    await diverge()

    const result = await new SyncOrchestrator({
      config: config({ conflictResolutionConfig: { defaultStrategy: ConflictResolutionStrategy.SKIP } }),
      cwd: down.root,
    }).run()

    expect(result.decisions.find(item => item.path === 'src/config/a.ts')?.action).toBe('skip')
    expect(await down.read('src/config/a.ts')).toBe('line one local\nline two\nline three\n')
  })
})

describe('SyncOrchestrator 分支策略与回滚', () => {
  it('启用分支策略时在生成的分支上提交，目标分支保持不变', async () => {
    await upstreamDrift()
    const before = down.gitRaw(['rev-parse', 'company'])

    const result = await new SyncOrchestrator({
      config: config({
        branchStrategyConfig: {
          enable: true,
          strategy: 'feature',
          baseBranch: 'company',
          branchPattern: 'feature/sync-{strategy}',
        },
      }),
      cwd: down.root,
    }).run()

    expect(down.gitRaw(['branch', '--show-current'])).toBe('feature/sync-feature')
    expect(down.gitRaw(['rev-parse', 'company'])).toBe(before)
    expect(result.commit?.created).toBe(true)
  })

  it('灰度发布只先落金丝雀子集，fullRelease 再补齐其余文件', async () => {
    await upstreamDrift()
    const grayConfig = config({
      grayReleaseConfig: {
        enable: true,
        strategy: GrayReleaseStrategy.DIRECTORY,
        canaryDirs: ['src/config'],
      },
    })

    const canary = await new SyncOrchestrator({ config: grayConfig, cwd: down.root }).run()
    expect(canary.gray?.stage).toBe('completed')
    expect(canary.gray?.totalFiles).toBe(3)
    expect(await down.read('src/config/new.ts')).toBe('brand new\n')

    const full = await new SyncOrchestrator({
      config: { ...grayConfig, fullRelease: true },
      cwd: down.root,
    }).run()
    expect(full.plan.changes).toHaveLength(0)
    expect(full.commit?.created).toBe(false)
  })

  it('--rollback 未启用灰度时报错', async () => {
    await upstreamDrift()
    await expect(
      new SyncOrchestrator({ config: config({ rollback: true }), cwd: down.root }).run(),
    ).rejects.toBeInstanceOf(GitError)
  })
})
