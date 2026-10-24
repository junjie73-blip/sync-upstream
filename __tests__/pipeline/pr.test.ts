import type { PrTool } from '../../src/pipeline/pr-cli'
import { compareUrl, prBranchName, slug, uniqueBranchName, webRepoUrl } from '../../src/pipeline/pr'
import { createPullRequest, findPrTool, toolForRemote } from '../../src/pipeline/pr-cli'
import { createFixture } from '../helpers/repo'

const TODAY = new Date(2026, 9, 22)

describe('prBranchName：分支名要自己说明来路', () => {
  it('默认是 sync-upstream/{目标分支}-{日期}', () => {
    expect(prBranchName(undefined, 'company', TODAY)).toBe('sync-upstream/company-20261022')
  })

  it('自定义模板里的占位符按全局替换，斜杠归一', () => {
    expect(prBranchName({ enable: true, branchPattern: 'chore/{target}/sync-{date}' }, 'company', TODAY))
      .toBe('chore/company/sync-20261022')
    expect(prBranchName({ enable: true, branchPattern: 'a//b/{target}' }, 'main', TODAY)).toBe('a/b/main')
  })

  it('目标分支与模板里的怪字符都换成合法字符', () => {
    expect(prBranchName({ enable: true, branchPattern: 'sync {target}!' }, 'release/2.0', TODAY))
      .toBe('sync-release-2.0!')
    // 分支名不能以 `.` 或 `/` 结尾，git 会直接拒绝这种 ref。
    expect(prBranchName({ enable: true, branchPattern: '{target}.' }, 'main', TODAY)).toBe('main')
    expect(prBranchName({ enable: true, branchPattern: 'sync/{target}/' }, 'main', TODAY)).toBe('sync/main')
  })

  it('空白模板等于没写，日期永远补上', () => {
    expect(prBranchName({ enable: true, branchPattern: '   ' }, 'main', TODAY)).toBe('sync-upstream/main-20261022')
  })

  it('slug 把 git 不接受的字符全部换成连字符', () => {
    expect(slug('release/2.0')).toBe('release-2.0')
    expect(slug('a~b^c:d?e*f[g]h')).toBe('a-b-c-d-e-f-g-h')
    expect(slug('two..dots')).toBe('two-dots')
    expect(slug('  spaced  ')).toBe('spaced')
    expect(slug('trailing.')).toBe('trailing')
    expect(slug('')).toBe('sync')
  })
})

describe('uniqueBranchName：不往可能在评审的分支上追加提交', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>

  beforeEach(async () => {
    fixture = await createFixture('main')
    await fixture.write('a.ts', 'a\n')
    await fixture.commitAll('base')
  })

  afterEach(async () => {
    await fixture?.cleanup()
  })

  it('名字没被占用时原样使用', async () => {
    expect(await uniqueBranchName(fixture.git, 'sync-upstream/company-20261022')).toEqual({
      branch: 'sync-upstream/company-20261022',
      reusedSuffix: false,
    })
  })

  it('占用时依次加 -2、-3，并说明发生过退让', async () => {
    await fixture.branch('sync-upstream/company-20261022')

    expect(await uniqueBranchName(fixture.git, 'sync-upstream/company-20261022')).toEqual({
      branch: 'sync-upstream/company-20261022-2',
      reusedSuffix: true,
    })

    await fixture.branch('sync-upstream/company-20261022-2')
    expect(await uniqueBranchName(fixture.git, 'sync-upstream/company-20261022')).toEqual({
      branch: 'sync-upstream/company-20261022-3',
      reusedSuffix: true,
    })
  })

  it('只认本地分支名，不看同名远程分支', async () => {
    const { branch, reusedSuffix } = await uniqueBranchName(fixture.git, 'main')
    expect(branch).toBe('main-2')
    expect(reusedSuffix).toBe(true)
  })
})

describe('compareUrl / webRepoUrl：把远程地址翻译成评审链接', () => {
  it('GitHub 与 Gitee 用 /compare/base...head', () => {
    expect(compareUrl('https://github.com/org/repo.git', 'main', 'sync/x'))
      .toBe('https://github.com/org/repo/compare/main...sync%2Fx')
    expect(compareUrl('git@gitee.com:org/repo.git', 'main', 'sync/x'))
      .toBe('https://gitee.com/org/repo/compare/main...sync%2Fx')
  })

  it('GitLab 用 /-/compare/，Bitbucket 用创建 PR 的表单', () => {
    expect(compareUrl('git@gitlab.com:org/repo.git', 'main', 'sync/x'))
      .toBe('https://gitlab.com/org/repo/-/compare/main...sync%2Fx')
    expect(compareUrl('https://bitbucket.org/org/repo', 'main', 'sync/x'))
      .toBe('https://bitbucket.org/org/repo/pull-requests/new?source=sync%2Fx&dest=main%3E%3Esync%2Fx')
  })

  it('自建主机与本地路径给不出链接，交由调用方打印分支名', () => {
    expect(compareUrl('https://git.example.com/org/repo.git', 'main', 'sync/x')).toBeNull()
    expect(compareUrl('/srv/git/repo.git', 'main', 'sync/x')).toBeNull()
    expect(compareUrl('C:\\repos\\repo', 'main', 'sync/x')).toBeNull()
    expect(compareUrl(undefined, 'main', 'sync/x')).toBeNull()
  })

  it('scp 形式、ssh:// 与带尾斜杠的 https 都归一成仓库网页地址', () => {
    expect(webRepoUrl('git@github.com:org/repo.git')).toBe('https://github.com/org/repo')
    expect(webRepoUrl('ssh://git@github.com/org/repo.git')).toBe('https://github.com/org/repo')
    expect(webRepoUrl('https://github.com/org/repo/')).toBe('https://github.com/org/repo')
    expect(webRepoUrl('https://github.com:8443/org/repo.git')).toBe('https://github.com:8443/org/repo')
    expect(webRepoUrl('/srv/git/repo.git')).toBeNull()
    expect(webRepoUrl('C:\\repos\\repo')).toBeNull()
    expect(webRepoUrl('')).toBeNull()
  })
})

describe('toolForRemote / createPullRequest / findPrTool', () => {
  it('只有 GitLab 走 glab，其余按 gh，配置可以覆盖', () => {
    expect(toolForRemote('https://gitlab.com/org/repo.git')).toBe('glab')
    expect(toolForRemote('https://gitlab.example-inc.com/org/repo.git')).toBe('glab')
    expect(toolForRemote('https://github.com/org/repo')).toBe('gh')
    expect(toolForRemote(undefined)).toBe('gh')
    expect(toolForRemote('https://gitlab.com/org/repo.git', 'gh')).toBe('gh')
  })

  it('create: never 时一次都不调用外部命令', async () => {
    const outcome = await createPullRequest(
      { cwd: process.cwd(), head: 'sync/x', base: 'main', title: 't', body: 'b', tool: 'gh' },
      { enable: true, create: 'never' },
    )
    expect(outcome).toEqual({ attempted: false, created: false, error: '配置为不自动创建 PR' })
  })

  it('环境变量是紧急开关，优先级高于配置', async () => {
    process.env.SYNC_UPSTREAM_PR_CREATE = '0'
    try {
      const outcome = await createPullRequest(
        { cwd: process.cwd(), head: 'sync/x', base: 'main', title: 't', body: 'b', tool: 'gh' },
        { enable: true, create: 'auto' },
      )
      expect(outcome.attempted).toBe(false)
    }
    finally {
      delete process.env.SYNC_UPSTREAM_PR_CREATE
    }
  })

  it('平台 CLI 不存在时给出可操作提示，而不是把同步判定为失败', async () => {
    const outcome = await createPullRequest({
      cwd: process.cwd(),
      head: 'sync/x',
      base: 'main',
      title: 't',
      body: 'b',
      tool: 'gh',
      command: 'sync-upstream-no-such-cli',
    })

    expect(outcome).toEqual({
      attempted: true,
      tool: 'gh',
      created: false,
      error: expect.stringContaining('未检测到 gh'),
    })
  })

  it('findPrTool 只返回真能执行的命令名（Windows 上 gh 常常只是 gh.cmd）', async () => {
    // 用当前跑测试的 node 可执行文件当"确实存在的命令"，换台机器也成立。
    const found = await findPrTool(process.execPath as unknown as PrTool)
    expect([process.execPath, `${process.execPath}.exe`, `${process.execPath}.cmd`]).toContain(found)
    expect(await findPrTool('sync-upstream-no-such-cli' as unknown as PrTool)).toBeNull()
  })
})
