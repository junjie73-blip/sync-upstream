import type { Fixture } from '../helpers/repo'
import { Buffer } from 'node:buffer'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { GitError } from '../../src/errors'
import { GitRepository, isSyncableObject, objectKindOf, parseLsTree, pathspec } from '../../src/git/repository'
import { createFixture } from '../helpers/repo'

let fixture: Fixture

beforeEach(async () => {
  fixture = await createFixture('main')
  await fixture.write('src/config/a.ts', 'a\n')
  await fixture.write('src/config/nested/b.md', 'b\n')
  await fixture.write('src/ui/c.ts', 'c\n')
  await fixture.write('docs/说明.md', '中文路径\n')
  await fixture.commitAll('initial')
})

afterEach(async () => {
  await fixture?.cleanup()
})

describe('parseLsTree', () => {
  it('解析 -z 记录的 <mode> <type> <oid> TAB <path>，并保留非文件对象', () => {
    const entries = parseLsTree([
      '100644 blob 1111111\tsrc/a.ts',
      '100755 blob 2222222\tsrc/run.sh',
      // git 对符号链接打印的对象类型就是 blob，只能靠 mode 识别
      '120000 blob 3333333\tsrc/alias',
      '160000 commit 4444444\tvendor/sub',
      '100644 blob 5555555\tsrc\\windows\\b.ts',
      '',
    ].join('\0'))

    // 反斜杠是文件名的一部分：-z 输出不做引号转义，不能"顺手"改写它
    expect([...entries.keys()]).toEqual(['src/a.ts', 'src/run.sh', 'src/alias', 'vendor/sub', 'src\\windows\\b.ts'])
    expect(entries.get('src/run.sh')).toEqual({ oid: '2222222', mode: '100755', type: 'blob' })
    expect(entries.get('src/alias')).toEqual({ oid: '3333333', mode: '120000', type: 'link' })
    // 子模块必须可见，否则它会被静默丢弃而不是上报为跳过
    expect(entries.get('vendor/sub')).toEqual({ oid: '4444444', mode: '160000', type: 'commit' })
  })

  it('objectKindOf 以 mode 为准，reported 类型只作补充', () => {
    expect(objectKindOf('100644', 'blob')).toBe('blob')
    expect(objectKindOf('100755', 'blob')).toBe('blob')
    expect(objectKindOf('120000', 'blob')).toBe('link')
    expect(objectKindOf('160000', 'commit')).toBe('commit')
    expect(objectKindOf('040000', 'tree')).toBe('tree')
    expect(objectKindOf('100644', 'weird')).toBe('blob')
  })

  it('isSyncableObject 只放行文件与符号链接', () => {
    expect(isSyncableObject({ oid: '1', mode: '100644', type: 'blob' })).toBe(true)
    expect(isSyncableObject({ oid: '1', mode: '120000', type: 'link' })).toBe(true)
    expect(isSyncableObject({ oid: '1', mode: '160000', type: 'commit' })).toBe(false)
    expect(isSyncableObject({ oid: '1', mode: '040000', type: 'tree' })).toBe(false)
  })

  it('pathspec 固定为顶层字面量，通配符文件名不会被扩大匹配', () => {
    expect(pathspec('src/a[1].md')).toBe(':(top,literal)src/a[1].md')
    expect(pathspec('../escape.ts')).toBe(':(top,literal)../escape.ts')
  })

  it('容忍没有 TAB 或字段缺失的异常记录', () => {
    expect(parseLsTree('garbage line').size).toBe(0)
    expect(parseLsTree('100644 blob\tbroken').size).toBe(0)
    expect(parseLsTree('').size).toBe(0)
  })
})

describe('仓库基本能力', () => {
  it('非工作目录时 assertWorkTree 抛 GitError', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-plain-'))
    try {
      await expect(new GitRepository(plain).assertWorkTree()).rejects.toBeInstanceOf(GitError)
    }
    finally {
      await fs.remove(plain).catch(() => undefined)
    }
  })

  it('repoRoot / currentBranch / head 一致', async () => {
    expect(await fs.pathExists(await fixture.git.repoRoot())).toBe(true)
    expect(await fixture.git.currentBranch()).toBe('main')
    expect(await fixture.git.head()).toBe(fixture.gitRaw(['rev-parse', 'HEAD']))
  })

  it('分支存在性与创建/删除/切换', async () => {
    expect(await fixture.git.branchExists('company')).toBe(false)
    await fixture.git.createBranch('company', 'main')
    expect(await fixture.git.branchExists('company')).toBe(true)
    expect(await fixture.git.currentBranch()).toBe('company')

    await fixture.git.checkout('main')
    await fixture.git.deleteBranch('company')
    expect(await fixture.git.branchExists('company')).toBe(false)
  })

  it('refExists / resolveRef 对无效引用不抛错', async () => {
    expect(await fixture.git.refExists('refs/heads/nope')).toBe(false)
    expect(await fixture.git.resolveRef('HEAD')).toMatch(/^[0-9a-f]{40}$/)
    await expect(fixture.git.resolveRef('refs/heads/nope')).rejects.toBeInstanceOf(GitError)
  })

  it('mergeBase 找到共同祖先，无公共历史时返回 null', async () => {
    await fixture.branch('upstream', 'main')
    expect(await fixture.git.mergeBase('main', 'upstream')).toBe(fixture.gitRaw(['rev-parse', 'main']))

    await fixture.gitRaw(['checkout', '-q', '--orphan', 'orphan'])
    await fixture.write('only.txt', 'x\n')
    await fixture.commitAll('orphan commit')
    expect(await fixture.git.mergeBase('main', 'orphan')).toBeNull()
  })
})

describe('远端配置', () => {
  it('ensureRemote 幂等，并且 URL 变化时更新', async () => {
    await fixture.git.ensureRemote('sync-upstream', 'https://example.com/a.git')
    expect(fixture.gitRaw(['remote', 'get-url', 'sync-upstream'])).toBe('https://example.com/a.git')

    await fixture.git.ensureRemote('sync-upstream', 'https://example.com/a.git')
    expect(fixture.gitRaw(['remote', 'get-url', 'sync-upstream'])).toBe('https://example.com/a.git')

    await fixture.git.ensureRemote('sync-upstream', 'https://example.com/b.git')
    expect(fixture.gitRaw(['remote', 'get-url', 'sync-upstream'])).toBe('https://example.com/b.git')
    expect(await fixture.git.hasRemote('sync-upstream')).toBe(true)

    expect(await fixture.git.removeRemote('sync-upstream')).toBe(true)
    expect(await fixture.git.removeRemote('sync-upstream')).toBe(false)
    expect(await fixture.git.hasRemote('sync-upstream')).toBe(false)
  })

  it('pushTarget 优先使用跟踪的上游分支', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-bare-'))
    try {
      fixture.gitRaw(['init', '-q', '--bare', bare])
      await fixture.git.ensureRemote('origin', bare)
      await fixture.git.push('origin', 'main')
      fixture.gitRaw(['branch', '--set-upstream-to', 'origin/main', 'main'])

      expect(await fixture.git.pushTarget('main')).toEqual({ remote: 'origin', branch: 'main' })
    }
    finally {
      await fs.remove(bare).catch(() => undefined)
    }
  })

  it('既没有上游分支也没有 origin 时报出可操作的错误', async () => {
    await expect(fixture.git.pushTarget('main')).rejects.toBeInstanceOf(GitError)
  })
})

describe('树与暂存区读取', () => {
  it('listTree 默认返回全部 blob，带 scope 时只返回 scope 内文件', async () => {
    const all = await fixture.git.listTree('main')
    expect([...all.keys()].sort()).toEqual(['docs/说明.md', 'src/config/a.ts', 'src/config/nested/b.md', 'src/ui/c.ts'])

    const scoped = await fixture.git.listTree('main', ['src/config'])
    expect([...scoped.keys()].sort()).toEqual(['src/config/a.ts', 'src/config/nested/b.md'])

    const multi = await fixture.git.listTree('main', ['src', 'docs'])
    expect(multi.size).toBe(4)
  })

  it('listTree 保留 mode 与对象类型：可执行位、符号链接、子模块都看得见', async () => {
    await fixture.write('src/config/tool.sh', 'echo hi\n')
    await fixture.makeExecutable('src/config/tool.sh')
    await fixture.indexSymlink('src/config/link-to-a', 'a.ts')
    await fixture.commitStaged('mode + symlink')

    const tree = await fixture.git.listTree('main')
    expect(tree.get('src/config/tool.sh')).toEqual({
      oid: expect.stringMatching(/^[0-9a-f]{40}$/),
      mode: '100755',
      type: 'blob',
    })
    expect(tree.get('src/config/link-to-a')?.mode).toBe('120000')
    expect(tree.get('src/config/link-to-a')?.type).toBe('link')
    // 普通文件不受影响
    expect(tree.get('src/config/a.ts')?.mode).toBe('100644')
  })

  it('listTree 不丢掉子模块 gitlink，由计划层决定如何上报', async () => {
    // 直接写索引，避免真的去 clone 一个子模块
    fixture.gitRaw(['update-index', '--add', '--cacheinfo', `160000,${fixture.gitRaw(['rev-parse', 'HEAD'])},vendor/pkg`])
    await fixture.commitStaged('add gitlink')

    const tree = await fixture.git.listTree('HEAD')
    expect(tree.get('vendor/pkg')).toEqual({
      oid: expect.stringMatching(/^[0-9a-f]{40}$/),
      mode: '160000',
      type: 'commit',
    })
    expect(isSyncableObject(tree.get('vendor/pkg')!)).toBe(false)
  })

  it('gitDirectory 指向 .git，锁文件才不会污染工作区', async () => {
    expect(path.resolve(await fixture.git.gitDirectory())).toBe(path.resolve(fixture.root, '.git'))
  })

  it('mergedBranches 只列出完全并入的分支', async () => {
    await fixture.branch('done', 'main')
    await fixture.gitRaw(['checkout', '-q', 'main'])
    expect(await fixture.git.mergedBranches('main')).toEqual(expect.arrayContaining(['main', 'done']))

    await fixture.gitRaw(['checkout', '-q', 'done'])
    await fixture.write('extra.ts', 'ahead\n')
    await fixture.commitAll('ahead')
    await fixture.gitRaw(['checkout', '-q', 'main'])
    expect(await fixture.git.mergedBranches('main')).not.toContain('done')
  })

  it('supportsSymlinks 跟随 core.symlinks，未配置时给出平台默认值', async () => {
    fixture.gitRaw(['config', 'core.symlinks', 'false'])
    expect(await fixture.git.supportsSymlinks()).toBe(false)
    fixture.gitRaw(['config', 'core.symlinks', 'true'])
    expect(await fixture.git.supportsSymlinks()).toBe(true)
    fixture.gitRaw(['config', '--unset', 'core.symlinks'])
    expect(await fixture.git.supportsSymlinks()).toEqual(expect.any(Boolean))
  })

  it('路径里的通配符按字面处理，不会顺手同步同名模式的其它文件', async () => {
    await fixture.write('src/config/a[1].md', 'target\n')
    await fixture.write('src/config/a1.md', 'collateral\n')
    await fixture.commitAll('glob-ish names')

    await fixture.gitRaw(['checkout', '-q', 'HEAD~1'])
    await fixture.git.checkoutPathsFromRef('main', ['src/config/a[1].md'])
    expect(await fixture.exists('src/config/a[1].md')).toBe(true)
    expect(await fixture.git.stagedPaths()).toEqual(['src/config/a[1].md'])
  })

  it('工作区改动与未跟踪文件都能被识别，并按 scope 过滤', async () => {
    await fixture.write('src/config/a.ts', 'a modified\n')
    await fixture.write('src/ui/new.ts', 'new\n')

    expect(await fixture.git.locallyModifiedPaths(['src'])).toEqual(['src/config/a.ts'])
    expect(await fixture.git.untrackedPaths(['src'])).toEqual(['src/ui/new.ts'])
    expect(await fixture.git.locallyModifiedPaths(['docs'])).toEqual([])
    expect(await fixture.git.untrackedPaths(['docs'])).toEqual([])
  })

  it('stagedPaths 只看索引，不受未跟踪文件干扰', async () => {
    await fixture.write('.sync-cache/junk.log', 'junk\n')
    await fixture.write('sync-upstream.json', '{}\n')
    expect(await fixture.git.stagedPaths()).toEqual([])

    await fixture.write('src/config/a.ts', 'a modified\n')
    await fixture.git.addPaths(['src/config/a.ts'])
    expect(await fixture.git.stagedPaths()).toEqual(['src/config/a.ts'])
  })

  it('readBlobText 读取指定修订的内容，工作区后续改动不影响', async () => {
    expect(await fixture.git.readBlobText('main', 'src/config/a.ts')).toBe('a\n')
    await fixture.write('src/config/a.ts', 'local edit\n')
    expect(await fixture.git.readBlobText('main', 'src/config/a.ts')).toBe('a\n')
  })
})

describe('写入型操作', () => {
  it('checkoutPathsFromRef 用指定修订覆盖文件并自动暂存，包括二进制', async () => {
    await fixture.write('src/config/a.ts', 'upstream version\n')
    await fixture.commitAll('upstream change')

    const binary = Buffer.from([0x00, 0x01, 0xFF, 0x80, 0x42])
    await fs.writeFile(path.join(fixture.root, 'src/config/blob.bin'), binary)
    await fixture.commitAll('add binary')

    await fixture.gitRaw(['checkout', '-q', 'HEAD~2'])
    expect(await fixture.read('src/config/a.ts')).toBe('a\n')

    await fixture.git.checkoutPathsFromRef('main', ['src/config/a.ts', 'src/config/blob.bin'])
    expect(await fixture.read('src/config/a.ts')).toBe('upstream version\n')
    expect(await fs.readFile(path.join(fixture.root, 'src/config/blob.bin'))).toEqual(binary)
    expect((await fixture.git.stagedPaths()).sort()).toEqual(['src/config/a.ts', 'src/config/blob.bin'])
  })

  it('restorePathsFromHead 丢弃这些路径的本地改动', async () => {
    await fixture.write('src/config/a.ts', 'dirty\n')
    await fixture.git.restorePathsFromHead(['src/config/a.ts'])
    expect(await fixture.read('src/config/a.ts')).toBe('a\n')
  })

  it('removePaths 删除文件并暂存', async () => {
    await fixture.git.removePaths(['src/config/nested/b.md', 'missing.txt'])
    expect(await fixture.exists('src/config/nested/b.md')).toBe(false)
    expect(await fixture.git.stagedPaths()).toEqual(['src/config/nested/b.md'])
  })

  it('removeRecursive 允许上游文件顶掉本地同名目录', async () => {
    await fixture.write('src/config/conflict/inside.ts', 'dir content\n')
    await fixture.commitAll('local directory')

    await fixture.branch('upstream', 'HEAD')
    await fixture.gitRaw(['checkout', '-q', 'upstream'])
    await fixture.gitRaw(['rm', '-r', '-q', '--', 'src/config/conflict'])
    await fixture.write('src/config/conflict', 'now a file\n')
    await fixture.commitAll('upstream file')

    await fixture.gitRaw(['checkout', '-q', 'main'])
    expect((await fixture.git.listTree('main')).has('src/config/conflict')).toBe(false)

    await fixture.git.removeRecursive(['src/config/conflict'])
    await fixture.git.checkoutPathsFromRef('upstream', ['src/config/conflict'])
    expect(await fixture.read('src/config/conflict')).toBe('now a file\n')
  })

  it('commit(message, paths) 只提交列出的路径，别人暂存的文件不受影响', async () => {
    await fixture.write('src/config/a.ts', 'mine\n')
    await fixture.git.addPaths(['src/config/a.ts'])
    await fixture.write('src/ui/c.ts', 'someone else staged this\n')
    await fixture.git.addPaths(['src/ui/c.ts'])

    const hash = await fixture.git.commit('sync: one file', ['src/config/a.ts'])
    expect(hash).toBe(fixture.gitRaw(['rev-parse', 'HEAD']))
    expect(fixture.gitRaw(['show', '--name-only', '--format=', 'HEAD'])).toBe('src/config/a.ts')
    expect(await fixture.git.stagedPaths()).toEqual(['src/ui/c.ts'])
  })

  it('exec 暴露原始命令输出', async () => {
    expect(await fixture.git.exec(['rev-parse', '--is-inside-work-tree'])).toBe('true\n')
    expect((await fixture.git.exec(['rev-parse', 'HEAD'])).trim()).toBe(fixture.gitRaw(['rev-parse', 'HEAD']))
  })
})

describe('GitRepository 只读与撤销原语', () => {
  it('version 去掉 "git version " 前缀', async () => {
    const version = await fixture.git.version()
    expect(version).toMatch(/^\d+\.\d+/)
    expect(version).not.toMatch(/^git version/)
  })

  it('remoteUrl 给出地址，不存在的远程返回 undefined', async () => {
    expect(await fixture.git.remoteUrl('origin')).toBeUndefined()
    await fixture.git.ensureRemote('origin', fixture.root)
    expect(await fixture.git.remoteUrl('origin')).toBe(fixture.root)
  })

  it('configValue 读取仓库级配置，未设置时为 undefined', async () => {
    expect(await fixture.git.configValue('core.autocrlf')).toBe('false')
    expect(await fixture.git.configValue('core.no-such-key')).toBeUndefined()
  })

  it('isIgnoredByGit 只把真的被忽略的路径算作忽略', async () => {
    expect(await fixture.git.isIgnoredByGit('src/config/a.ts')).toBe(false)
    await fixture.write('.gitignore', 'a.tmp\nlogs/\n')
    expect(await fixture.git.isIgnoredByGit('a.tmp')).toBe(true)
    expect(await fixture.git.isIgnoredByGit('logs/x.txt')).toBe(true)
    expect(await fixture.git.isIgnoredByGit('src/config/a.ts')).toBe(false)
  })

  it('objectExists 认提交，不认对象库里没有的东西', async () => {
    const head = await fixture.git.head()
    expect(await fixture.git.objectExists(head)).toBe(true)
    expect(await fixture.git.objectExists('main')).toBe(true)
    expect(await fixture.git.objectExists('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false)
    expect(await fixture.git.objectExists('no-such-branch')).toBe(false)
    // 指向 blob 的 rev 不算提交，`^{commit}` 会把它筛掉。
    const blob = fixture.gitRaw(['rev-parse', 'main:src/config/a.ts'])
    expect(await fixture.git.objectExists(blob)).toBe(false)
  })

  it('countCommitsBetween 数出领先提交，无关历史返回 null', async () => {
    expect(await fixture.git.countCommitsBetween('main', 'main')).toBe(0)
    await fixture.write('src/config/a.ts', 'second\n')
    await fixture.commitAll('second')
    expect(await fixture.git.countCommitsBetween('main~1', 'main')).toBe(1)
    expect(await fixture.git.countCommitsBetween('main', 'main~1')).toBe(0)
    expect(await fixture.git.countCommitsBetween('no-such-ref', 'main')).toBeNull()
  })

  it('revertHead 生成新的撤销提交而不是改写历史', async () => {
    const first = await fixture.git.head()
    await fixture.write('src/config/a.ts', 'second\n')
    const second = await fixture.commitAll('second')

    const reverted = await fixture.git.revertHead()

    expect(reverted).not.toBe(second)
    expect(await fixture.git.head()).toBe(reverted)
    expect(await fixture.git.objectExists(second)).toBe(true)
    expect(fixture.gitRaw(['log', '--format=%s', 'HEAD~2..HEAD'])).toContain('Revert')
    expect(await fixture.read('src/config/a.ts')).toBe('a\n')
    expect(first).not.toBe(reverted)
  })

  it('revertHead 在本地未提交改动前止步，抛 GitError', async () => {
    await fixture.write('src/config/a.ts', 'second\n')
    const second = await fixture.commitAll('second')
    await fixture.write('src/config/a.ts', 'local edit\n')

    await expect(fixture.git.revertHead()).rejects.toBeInstanceOf(GitError)

    // git 在动手之前就拒绝了：既没有新提交，本地改动也还在（且仍未暂存）。
    expect(fixture.gitRaw(['rev-parse', 'HEAD'])).toBe(second)
    expect(await fixture.read('src/config/a.ts')).toBe('local edit\n')
    expect(fixture.gitRaw(['diff', '--name-only', '--', 'src/config/a.ts'])).toBe('src/config/a.ts')
    expect(fixture.gitRaw(['diff', '--cached', '--name-only', '--', 'src/config/a.ts'])).toBe('')
  })
})
