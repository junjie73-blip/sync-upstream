import type { SyncConfig } from '../../src/domain'
import type { Fixture } from '../helpers/repo'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { resolveConfig } from '../../src/config/resolve'
import { SyncOrchestrator } from '../../src/pipeline/orchestrator'
import { prBranchName } from '../../src/pipeline/pr'
import { createFixture } from '../helpers/repo'

/**
 * GitOps PR 模式：同步的成果是一条待评审的分支，而不是目标分支上的提交。
 * 这条线要守住的承诺有两条——目标分支一个字节都不动，增量账本也不动（目标分支上并没有
 * 这批内容，把它记成"已同步"会让下一次运行漏掉真正还没落地的文件）。
 */
let up: Fixture
let down: Fixture
let bare = ''
let fork = ''

function createBare(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync('git', ['init', '--bare', '-q', '--initial-branch', 'company', dir], { encoding: 'utf8' })
  return dir
}

function bareRaw(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

beforeEach(async () => {
  up = await createFixture('main')
  await up.write('src/config/a.ts', 'a base\n')
  await up.write('src/config/gone.ts', 'gone\n')
  await up.commitAll('upstream base')

  bare = createBare('sync-pr-bare-')
  fork = createBare('sync-pr-fork-')

  down = await createFixture('seed')
  await down.git.ensureRemote('origin', up.root)
  await down.git.fetch('origin', 'main')
  down.gitRaw(['checkout', '-q', '--no-track', '-b', 'company', 'FETCH_HEAD'])
  // 真实仓库里 origin 是公司自己的远程，上游只是被抓取的对象。
  down.gitRaw(['remote', 'set-url', 'origin', bare])
  down.gitRaw(['remote', 'add', 'fork', fork])
})

afterEach(async () => {
  await Promise.all([up?.cleanup(), down?.cleanup()])
  for (const dir of [bare, fork])
    await fs.remove(dir).catch(() => undefined)
})

function config(overrides: Record<string, unknown> = {}): SyncConfig {
  return resolveConfig({
    upstreamRepo: up.root,
    upstreamBranch: 'main',
    companyBranch: 'company',
    syncDirs: ['src/config'],
    nonInteractive: true,
    ...overrides,
  }).config
}

/** 夹具跑在本地路径上，没有平台 CLI 可调用；创建 PR 那一步由单元测试覆盖。 */
function run(overrides: Record<string, unknown> = {}) {
  const prConfig = { enable: true, create: 'never', ...(overrides.prConfig as object) }
  return new SyncOrchestrator({
    config: config({ ...overrides, prConfig }),
    cwd: down.root,
  }).run()
}

/** 让上游既有修改又有删除，PR 分支必须原样带出这两类改动。 */
async function upstreamDrift(): Promise<void> {
  await up.gitRaw(['checkout', '-q', 'main'])
  await up.write('src/config/a.ts', 'a upstream\n')
  await up.write('src/config/new.ts', 'brand new\n')
  await up.gitRaw(['rm', '-q', '--', 'src/config/gone.ts'])
  await up.commitAll('upstream drift')
}

const stateFile = () => path.join(down.root, '.sync-state.json')

describe('PR 模式：改动进分支，目标分支不动', () => {
  it('提交落在自动分支上并推送到远程，company 与工作区保持原样', async () => {
    await upstreamDrift()
    const before = down.gitRaw(['rev-parse', 'company'])

    const result = await run()

    expect(result.commit?.created).toBe(true)
    const branch = result.pullRequest?.branch as string
    expect(branch).toMatch(/^sync-upstream\/company-\d{8}$/)
    expect(result.pullRequest).toMatchObject({ baseBranch: 'company', remote: 'origin', pushed: true })
    // 本地路径远程没有可拼的对比页；created 只在真的调用过平台 CLI 时出现。
    expect(result.pullRequest?.url).toBeNull()
    expect(result.pullRequest?.created).toBeUndefined()

    expect(bareRaw(bare, ['rev-parse', branch])).toBe(result.commit?.hash)
    expect(bareRaw(bare, ['show', `${branch}:src/config/a.ts`])).toBe('a upstream')
    expect(bareRaw(bare, ['ls-tree', '--name-only', `${branch}:src/config`]).split(/\r?\n/).sort())
      .toEqual(['a.ts', 'new.ts'])

    // 目标分支既没前进，也没被推出去。
    expect(down.gitRaw(['rev-parse', 'company'])).toBe(before)
    expect(bareRaw(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads/company'])).toBe('')
    expect(await down.read('src/config/a.ts')).toBe('a base\n')
    expect(await down.exists('src/config/gone.ts')).toBe(true)
  })

  it('运行结束回到开始时的分支，不会把人留在陌生分支里', async () => {
    await upstreamDrift()

    await run()

    expect(down.gitRaw(['branch', '--show-current'])).toBe('company')
  })

  it('不读也不写增量状态：上一次同步的账不会把这次变成空计划', async () => {
    await upstreamDrift()
    // 先按普通模式同步一次，把账记下来、分支也前进了。
    await new SyncOrchestrator({ config: config({ forceOverwrite: false }), cwd: down.root }).run()
    expect(await fs.pathExists(stateFile())).toBe(true)
    const ledger = await fs.readJson(stateFile())
    down.gitRaw(['reset', '-q', '--hard', 'HEAD~1'])

    const result = await run({ forceOverwrite: false })

    // 账本说"这些都同步过了"，可 company 上并没有——PR 模式必须按全量计划走。
    expect(result.plan.changes.length).toBeGreaterThan(0)
    expect(result.pullRequest?.pushed).toBe(true)
    expect(await fs.readJson(stateFile())).toEqual(ledger)
  })

  it('prConfig.remote 决定推送目标，origin 完全不参与', async () => {
    await upstreamDrift()

    const result = await run({ prConfig: { remote: 'fork' } })

    const branch = result.pullRequest?.branch as string
    expect(result.pullRequest?.remote).toBe('fork')
    expect(bareRaw(fork, ['rev-parse', branch])).toBe(result.commit?.hash)
    expect(bareRaw(bare, ['for-each-ref', '--format=%(refname)'])).toBe('')
  })

  it('分支名已被占用时改用 -2，绝不往可能在评审的旧分支上追加提交', async () => {
    await upstreamDrift()
    const wanted = prBranchName(config().prConfig, 'company')
    const stale = down.gitRaw(['rev-parse', 'company'])
    down.gitRaw(['branch', wanted, 'company'])

    const result = await run()

    expect(result.pullRequest?.branch).toBe(`${wanted}-2`)
    expect(down.gitRaw(['rev-parse', wanted])).toBe(stale)
    expect(bareRaw(bare, ['for-each-ref', '--format=%(refname:short)'])).toBe(`${wanted}-2`)
  })

  it('autoPush 在 PR 模式下不会把目标分支推出去', async () => {
    await upstreamDrift()

    const result = await run({ autoPush: true })

    expect(result.pullRequest?.pushed).toBe(true)
    expect(bareRaw(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads/company'])).toBe('')
  })

  it('推送失败不算同步失败：提交留在本地分支，note 说清发生了什么', async () => {
    await upstreamDrift()

    const result = await run({ prConfig: { remote: 'no-such-remote' } })

    expect(result.commit?.created).toBe(true)
    expect(result.pullRequest?.pushed).toBe(false)
    expect(result.pullRequest?.note).toContain('推送')
    expect(down.gitRaw(['rev-parse', result.pullRequest?.branch as string])).toBe(result.commit?.hash)
  })

  it('没有变更时不留下空分支，也不会反复堆出 -2、-3', async () => {
    const first = await run()
    const second = await run()

    expect(first.pullRequest).toBeUndefined()
    expect(second.pullRequest).toBeUndefined()
    expect(down.gitRaw(['for-each-ref', '--format=%(refname:short)', 'refs/heads/sync-upstream']).trim()).toBe('')
    expect(bareRaw(bare, ['for-each-ref', '--format=%(refname)'])).toBe('')
    expect(down.gitRaw(['branch', '--show-current'])).toBe('company')
  })
})
