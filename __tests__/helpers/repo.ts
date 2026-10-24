import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { GitRepository } from '../../src/git/repository'

export interface Fixture {
  root: string
  git: GitRepository
  /** Run git with the fixture as working directory; returns stdout. */
  gitRaw: (args: string[]) => string
  write: (repoPath: string, content: string) => Promise<string>
  remove: (repoPath: string) => Promise<void>
  read: (repoPath: string) => Promise<string>
  exists: (repoPath: string) => Promise<boolean>
  /** Stage everything and commit; used to build the fixture history. */
  commitAll: (message: string) => Promise<string>
  /** Commit the index as-is — `commitAll` would prune index-only entries (symlinks, gitlinks). */
  commitStaged: (message: string) => Promise<string>
  branch: (name: string, startPoint?: string) => Promise<void>
  /** Set the exec bit in the index. `chmod` is a no-op on Windows, this is not. */
  makeExecutable: (repoPath: string) => Promise<void>
  /** Store a symlink in the index without needing a symlink on disk (works unprivileged). */
  indexSymlink: (linkPath: string, target: string) => Promise<void>
  cleanup: () => Promise<void>
}

function gitAt(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    // 夹具搭历史时也走同样的规矩：本机装了 git-lfs 时 `.gitattributes` 里的 `filter=lfs`
    // 是全局生效的，`checkout`/`add` 会去要真实对象，夹具搭建于是变成一个下载失败。
    // 被测代码自己会关掉 smudge（见 GitRepository 构造器），夹具不能依赖它。
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
  }).trim()
}

/**
 * Temp repository with deterministic config, so a machine-level `core.autocrlf`
 * or a signing key can never change blob oids behind the tests.
 */
export async function createFixture(branch = 'main'): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-upstream-fixture-'))
  await fs.ensureDir(root)

  gitAt(root, ['init', '-q', '--initial-branch', branch, root])
  // A developer machine's `core.excludesFile` (people do put `.sync-state.json` in theirs)
  // would otherwise decide what git reports as ignored, and the tests would only pass here.
  const emptyExcludes = path.join(root, '.git', 'sync-upstream-empty-excludes').replace(/\\/g, '/')
  await fs.writeFile(emptyExcludes, '', 'utf8')
  for (const [key, value] of Object.entries({
    'user.name': 'Sync Test',
    'user.email': 'sync-test@example.com',
    'core.autocrlf': 'false',
    'core.eol': 'lf',
    'core.fsmonitor': 'false',
    'core.excludesFile': emptyExcludes,
    'commit.gpgsign': 'false',
    'gc.auto': '0',
  })) {
    gitAt(root, ['config', key, value])
  }

  const git = new GitRepository(root)
  const write: Fixture['write'] = async (repoPath, content) => {
    const target = path.join(root, ...repoPath.split('/'))
    await fs.ensureDir(path.dirname(target))
    await fs.writeFile(target, content, 'utf8')
    return repoPath
  }

  return {
    root,
    git,
    gitRaw: args => gitAt(root, args),
    write,
    read: async repoPath => fs.readFile(path.join(root, ...repoPath.split('/')), 'utf8'),
    exists: async repoPath => fs.pathExists(path.join(root, ...repoPath.split('/'))),
    remove: async (repoPath) => {
      await fs.remove(path.join(root, ...repoPath.split('/')))
    },
    commitAll: async (message) => {
      gitAt(root, ['add', '-A'])
      gitAt(root, ['commit', '-q', '-m', message])
      return gitAt(root, ['rev-parse', 'HEAD'])
    },
    commitStaged: async (message) => {
      gitAt(root, ['commit', '-q', '-m', message])
      return gitAt(root, ['rev-parse', 'HEAD'])
    },
    branch: async (name, startPoint) => {
      gitAt(root, startPoint ? ['branch', name, startPoint] : ['branch', name])
    },
    makeExecutable: async (repoPath) => {
      gitAt(root, ['add', '-A', '--', repoPath])
      gitAt(root, ['update-index', '--chmod=+x', '--', repoPath])
    },
    indexSymlink: async (linkPath, target) => {
      const oid = gitAt(root, ['hash-object', '-w', '--stdin', '-t', 'blob'], target)
      gitAt(root, ['update-index', '--add', '--cacheinfo', `120000,${oid},${linkPath}`])
    },
    cleanup: async () => {
      await fs.remove(root).catch(() => undefined)
    },
  }
}

/**
 * Two-branch fixture: `main` is the upstream source, `company` is the downstream
 * branch the tool rewrites. Both start from the same commit, like a fork.
 */
export async function createForkFixture(files: Record<string, string>): Promise<Fixture> {
  const fixture = await createFixture('main')
  for (const [repoPath, content] of Object.entries(files))
    await fixture.write(repoPath, content)
  await fixture.commitAll('initial')
  await fixture.branch('company')
  return fixture
}
