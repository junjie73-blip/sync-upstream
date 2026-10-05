import type { Fixture } from '../helpers/repo'
import { Buffer } from 'node:buffer'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { GitError } from '../../src/errors'
import { GitRepository, parseLsTree } from '../../src/git/repository'
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
  it('解析 <mode> <type> <oid> TAB <path>，并过滤非 blob 条目', () => {
    const entries = parseLsTree([
      '100644 blob 1111111\tsrc/a.ts',
      '100755 blob 2222222\tsrc/run.sh',
      '040000 tree 3333333\tsrc',
      '160000 commit 4444444\tvendor/sub',
      '100644 blob 5555555\tsrc\\windows\\b.ts',
      '',
    ].join('\n'))

    expect([...entries.keys()]).toEqual(['src/a.ts', 'src/run.sh', 'src/windows/b.ts'])
    expect(entries.get('src/run.sh')).toEqual({ oid: '2222222', mode: '100755' })
  })

  it('容忍没有 TAB 的异常行', () => {
    expect(parseLsTree('garbage line').size).toBe(0)
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
