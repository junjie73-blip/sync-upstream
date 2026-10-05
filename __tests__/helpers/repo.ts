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
  branch: (name: string, startPoint?: string) => Promise<void>
  cleanup: () => Promise<void>
}

function gitAt(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
  for (const [key, value] of Object.entries({
    'user.name': 'Sync Test',
    'user.email': 'sync-test@example.com',
    'core.autocrlf': 'false',
    'core.eol': 'lf',
    'core.fsmonitor': 'false',
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
    branch: async (name, startPoint) => {
      gitAt(root, startPoint ? ['branch', name, startPoint] : ['branch', name])
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
