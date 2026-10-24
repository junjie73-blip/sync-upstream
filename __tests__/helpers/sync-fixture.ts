import type { CommandContext } from '../../src/commands/types'
import type { SyncConfig } from '../../src/domain'
import type { Fixture } from './repo'
import { resolveConfig } from '../../src/config/resolve'
import { createFixture } from './repo'

/**
 * Upstream/downstream pair shared by the read-only commands tests: `main` is the upstream,
 * `company` is the target branch, both start from the same commit like a fork would.
 */
export interface SyncFixture {
  up: Fixture
  down: Fixture
  config: (overrides?: Record<string, unknown>) => SyncConfig
  /** Let upstream drift the way a real fork does: add / modify / delete, plus out-of-scope noise. */
  drift: () => Promise<void>
  context: (overrides?: Partial<CommandContext>) => CommandContext
  cleanup: () => Promise<void>
}

export const SHARED: Record<string, string> = {
  'src/config/a.ts': 'line one\nline two\nline three\n',
  'src/config/b.md': '# b\n',
  'src/config/keep.txt': 'keep\n',
  'src/ui/x.ts': 'ui\n',
  'README.md': '# readme\n',
}

export async function createSyncFixture(): Promise<SyncFixture> {
  const up = await createFixture('main')
  for (const [repoPath, content] of Object.entries(SHARED))
    await up.write(repoPath, content)
  await up.commitAll('upstream base')

  const down = await createFixture('seed')
  await down.git.ensureRemote('origin', up.root)
  await down.git.fetch('origin', 'main')
  down.gitRaw(['checkout', '-q', '--no-track', '-b', 'company', 'FETCH_HEAD'])

  const config = (overrides: Record<string, unknown> = {}): SyncConfig => {
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

  const drift = async (): Promise<void> => {
    await up.gitRaw(['checkout', '-q', 'main'])
    await up.write('src/config/new.ts', 'brand new\n')
    await up.write('src/config/a.ts', 'line one\nline two\nline three upstream\n')
    await up.write('src/config/keep.txt', 'keep upstream\n')
    await up.write('src/ui/x.ts', 'ui upstream\n')
    await up.write('docs/ignored.md', 'out of scope\n')
    await up.gitRaw(['rm', '-q', '--', 'src/config/b.md'])
    await up.commitAll('upstream drift')
  }

  return {
    up,
    down,
    config,
    drift,
    context: (overrides = {}) => ({
      config: config(),
      configSource: null,
      cwd: down.root,
      json: false,
      positional: [],
      flags: { fetch: false },
      ...overrides,
    }),
    cleanup: () => Promise.all([up.cleanup(), down.cleanup()]).then(() => undefined),
  }
}

/** HEAD + tree + worktree cleanliness — the three things a read-only command must never touch. */
export function captureState(fixture: Fixture): string {
  return [
    fixture.gitRaw(['rev-parse', 'HEAD']),
    fixture.gitRaw(['write-tree']),
    fixture.gitRaw(['status', '--porcelain']),
  ].join('\n')
}
