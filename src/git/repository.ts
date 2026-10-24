import type { SimpleGit, SimpleGitProgressEvent } from 'simple-git'
import type { RenamePair, RepoPath } from '../domain'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import simpleGit from 'simple-git'
import { DEFAULT_RENAME_THRESHOLD } from '../domain'
import { GitError, toError } from '../errors'
import { scopeOf } from '../fsx/paths'
import { t } from '../i18n'
import { wrapGitError } from './url'

/** Keep argv well below the Windows command-line limit when passing many paths. */
const PATH_CHUNK_SIZE = 50

export interface GitRepositoryOptions {
  /** Extra environment for every git subprocess (e.g. `GIT_SSH_COMMAND`). */
  env?: Record<string, string>
  onProgress?: (event: SimpleGitProgressEvent) => void
}

/** The large-repository knobs a single fetch may ask the server for. */
export interface FetchOptions {
  /** git's `--filter` value, e.g. `blob:none`; falsy means no filtering. */
  filter?: string | null
  /** `--depth`; falsy means full history. */
  depth?: number
  /** Fetch tags too. Default false, which keeps `--no-tags`. */
  tags?: boolean
}

export interface TreeEntry {
  oid: string
  mode: string
  /** `blob` for files, `link` for symlinks, `commit` for gitlinks, `tree` for directories. */
  type: GitObjectType
}

export type GitObjectType = 'blob' | 'link' | 'commit' | 'tree'

/** Files vs symlinks: both are applied by `git checkout <ref> -- <path>`. */
export function isSyncableObject(entry: TreeEntry): entry is TreeEntry & { type: 'blob' | 'link' } {
  return entry.type === 'blob' || entry.type === 'link'
}

/**
 * Every path handed to git travels as a literal pathspec rooted at the repository top.
 * Without `:(literal)` a file named `a[1].md` or `foo*.ts` is glob-matched and silently
 * syncs the wrong set; without `:(top)` the same path breaks when git runs from a subdirectory.
 */
export function pathspec(repoPath: RepoPath): string {
  return `:(top,literal)${repoPath}`
}

function chunk<T>(items: T[], size = PATH_CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

/** Split NUL-separated git output (`-z`), which is the only form that cannot be quoted or escaped. */
export function parseNulList(output: string): string[] {
  return output.split('\0').filter(line => line !== '')
}

/**
 * `git ls-tree` prints the *object* type, and a symlink's object is a plain blob — only the
 * mode says it is a link. Classify from the mode so symlinks never get treated as regular
 * files (on Windows that would materialise them as text files containing the target path).
 */
export function objectKindOf(mode: string, reported: string): GitObjectType {
  if (mode === '120000')
    return 'link'
  if (mode === '160000')
    return 'commit'
  if (mode === '040000' || mode === '40000')
    return 'tree'
  return reported === 'tree' || reported === 'commit' || reported === 'link' ? reported : 'blob'
}

/**
 * Parse `git ls-tree -r -z` records: `<mode> SP <type> SP <oid> TAB <path> NUL`.
 * Non-file objects are kept so the pipeline can report them instead of dropping them
 * without a trace — a submodule or symlink that silently disappears is far worse than one
 * that is listed as skipped.
 */
export function parseLsTree(output: string): Map<RepoPath, TreeEntry> {
  const entries = new Map<RepoPath, TreeEntry>()
  for (const record of parseNulList(output)) {
    const tab = record.indexOf('\t')
    if (tab === -1)
      continue
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    if (!mode || !type || !oid)
      continue
    // ls-tree -z never quotes paths, so a backslash here is part of the file name.
    entries.set(record.slice(tab + 1), { oid, mode, type: objectKindOf(mode, type) })
  }
  return entries
}

/**
 * Parse `git diff --name-status -z` into the rename pairs it reported.
 *
 * With `-z` every field is its own NUL-terminated record: `M\0path\0`, and for a detected
 * rename `R100\0old\0new\0`. Copies (`C`) carry the same two-path shape and mean the same thing
 * for us — upstream now has the file at a second path — so they fold into the same plan entry.
 * Anything malformed is skipped rather than guessed at, because a wrong pair would move a file
 * the user never asked us to move.
 */
export function parseNameStatus(output: string): RenamePair[] {
  const tokens = parseNulList(output)
  const pairs: RenamePair[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index]
    if (!/^[A-Z][A-Z0-9,.%]{0,8}$/.test(status)) {
      // Mis-aligned stream: something consumed the wrong number of tokens. Stop instead of
      // reading a path like `README.md` as a status code.
      break
    }
    const kind = status.charAt(0)
    if (kind !== 'R' && kind !== 'C') {
      index += 1 // the single path this record owns
      continue
    }
    // `R100` for renames; copies can carry two scores (`C75,90`), and the last one is the
    // similarity git scored this pair with.
    const scores = status.slice(1).match(/\d+/g)
    const similarity = scores ? Number(scores[scores.length - 1]) : Number.NaN
    const from = tokens[index + 1]
    const to = tokens[index + 2]
    if (!from || !to || !Number.isFinite(similarity))
      break
    index += 2
    if (from !== to)
      pairs.push({ from, to, similarity })
  }
  return pairs
}

/** The single gateway to git: everything else goes through the object database, not the working tree. */
export class GitRepository {
  private git: SimpleGit

  constructor(private readonly cwd: string, options: GitRepositoryOptions = {}) {
    this.git = simpleGit({
      baseDir: cwd,
      maxConcurrentProcesses: 1,
      trimmed: false,
      progress: options.onProgress,
      // quotepath=false keeps non-ASCII paths readable; longpaths=true lets git for Windows
      // exceed MAX_PATH, which deep monorepo trees do routinely. Unknown keys are ignored
      // on other platforms, so this is safe to always pass.
      config: ['core.quotepath=false', 'core.longpaths=true'],
    })
    // Git LFS is a working-tree filter, and a filter that runs during our `checkout <ref> -- path`
    // would contact *this* repository's LFS server for objects that belong upstream — turning a
    // sync into a download, or into a failed sync. The pointer blob is what the tool handles, and
    // `fetchConfig.lfs` decides explicitly whether the real content gets fetched afterwards.
    // simple-git merges this onto `process.env`, so an explicit `env` above still wins.
    this.git.env({ GIT_LFS_SKIP_SMUDGE: '1', ...options.env })
  }

  get raw(): SimpleGit {
    return this.git
  }

  /** Escape hatch for the handful of commands with no dedicated wrapper. */
  async exec(args: string[]): Promise<string> {
    return this.run(`git ${args[0] ?? ''}`, () => this.git.raw(args))
  }

  get workingDir(): string {
    return this.cwd
  }

  private async run<T>(action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    }
    catch (error) {
      throw wrapGitError(action, error)
    }
  }

  async assertWorkTree(): Promise<void> {
    await this.run('检查 Git 仓库', async () => this.git.raw(['rev-parse', '--is-inside-work-tree']))
  }

  async repoRoot(): Promise<string> {
    const out = await this.run('读取仓库根目录', () => this.git.raw(['rev-parse', '--show-toplevel']))
    return out.trim()
  }

  /**
   * The `.git` directory (resolving `gitdir:` files so worktrees and submodules point at
   * their own metadata). The repository lock lives here, out of the user's working tree.
   */
  async gitDirectory(): Promise<string> {
    const root = await this.repoRoot()
    const out = await this.run('读取 .git 目录', () => this.git.raw(['rev-parse', '--absolute-git-dir']))
    const raw = out.trim()
    if (raw.startsWith('gitdir:'))
      return path.resolve(root, raw.slice('gitdir:'.length).trim())
    return path.resolve(raw || root)
  }

  /** Local branches fully merged into `into`, as short names. */
  async mergedBranches(into: string): Promise<string[]> {
    const output = await this.run('列出已合并分支', () => this.git.raw(['branch', '--merged', into, '--format=%(refname:short)']))
    return output.split('\n').map(line => line.trim()).filter(Boolean)
  }

  async ensureRemote(name: string, url: string): Promise<void> {
    await this.run(`配置远程仓库 ${name}`, async () => {
      const remotes = await this.git.getRemotes(false)
      if (!remotes.some(remote => remote.name === name)) {
        await this.git.addRemote(name, url)
        return
      }
      const current = (await this.git.raw(['remote', 'get-url', name])).trim()
      if (current !== url)
        await this.git.remote(['set-url', name, url])
    })
  }

  async removeRemote(name: string): Promise<boolean> {
    return this.run(`移除远程仓库 ${name}`, async () => {
      const remotes = await this.git.getRemotes(false)
      if (!remotes.some(remote => remote.name === name))
        return false
      await this.git.removeRemote(name)
      return true
    })
  }

  async hasRemote(name: string): Promise<boolean> {
    const remotes = await this.run('读取远程列表', () => this.git.getRemotes(false))
    return remotes.some(remote => remote.name === name)
  }

  /**
   * `git fetch <remote> <ref-or-refspec>`. The refspec form is what lets a tag or a bare commit
   * be fetched into our own `refs/remotes/<remote>/…` namespace instead of the user's tags.
   * `--no-tags` keeps an ordinary branch fetch from dragging the upstream's whole tag list in.
   *
   * `filter` and `depth` come from `fetchConfig`. They are only ever *added* to the command, so a
   * server that cannot do object filtering degrades the way git degrades: a warning on stderr and
   * a full fetch, not a failed sync.
   */
  async fetch(remote: string, ref: string, label?: string, options: FetchOptions = {}): Promise<void> {
    const args = [options.tags ? '--tags' : '--no-tags']
    if (options.filter)
      args.push(`--filter=${options.filter}`)
    if (options.depth)
      args.push(`--depth=${options.depth}`)
    await this.run(label ?? `拉取 ${remote}/${ref}`, () => this.git.fetch(remote, ref, args))
  }

  /**
   * True when `.git/shallow` exists, i.e. some history is deliberately missing.
   *
   * Asked before a shallow fetch is attempted, because the file appears as soon as one has ever
   * run — including one this tool ran weeks ago, and a `depth` that used to reach the last sync
   * may no longer reach it after the upstream moved.
   */
  async isShallow(): Promise<boolean> {
    return fs.pathExists(path.join(await this.gitDirectory(), 'shallow'))
  }

  async resolveRef(ref: string): Promise<string> {
    const out = await this.run(`解析引用 ${ref}`, () => this.git.raw(['rev-parse', '--verify', ref]))
    return out.trim()
  }

  async refExists(ref: string): Promise<boolean> {
    try {
      await this.git.raw(['rev-parse', '--verify', ref])
      return true
    }
    catch {
      return false
    }
  }

  async currentBranch(): Promise<string> {
    const out = await this.run('读取当前分支', () => this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD']))
    return out.trim()
  }

  async branchExists(name: string): Promise<boolean> {
    return this.refExists(`refs/heads/${name}`)
  }

  async checkout(branch: string): Promise<void> {
    await this.run(`切换到 ${branch}`, () => this.git.checkout(branch))
  }

  async createBranch(name: string, startPoint: string): Promise<void> {
    await this.run(`创建分支 ${name}`, () => this.git.checkoutBranch(name, startPoint))
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.run(`删除分支 ${name}`, () => this.git.deleteLocalBranch(name, force))
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    try {
      const out = await this.git.raw(['merge-base', a, b])
      return out.trim() || null
    }
    catch {
      return null
    }
  }

  /** path → object entry for a revision, restricted to the requested scopes. */
  async listTree(ref: string, scopes: RepoPath[] = []): Promise<Map<RepoPath, TreeEntry>> {
    const output = await this.run(
      `读取 ${ref} 的文件清单`,
      () => this.git.raw(['ls-tree', '-r', '-z', '--full-name', ref]),
    )
    const all = parseLsTree(output)
    if (scopes.length === 0)
      return all

    const filtered = new Map<RepoPath, TreeEntry>()
    for (const [repoPath, entry] of all) {
      if (scopeOf(repoPath, scopes) !== null)
        filtered.set(repoPath, entry)
    }
    return filtered
  }

  /**
   * Renames git detects between two revisions, restricted to the sync scopes.
   *
   * `git diff -M --name-status` is the only place rename information exists: the planner
   * compares two `ls-tree` listings, which sees a move as one delete plus one add. `-z` keeps
   * paths verbatim, so a name with a space or a quote cannot confuse the parser.
   */
  async renamedPaths(from: string, to: string, scopes: RepoPath[] = [], threshold = DEFAULT_RENAME_THRESHOLD): Promise<RenamePair[]> {
    const groups = scopes.length === 0 ? [[]] : chunk(scopes)
    const pairs: RenamePair[] = []
    for (const group of groups) {
      const args = ['diff', `-M${threshold}`, '--name-status', '-z', `${from}..${to}`]
      if (group.length > 0)
        args.push('--', ...group.map(pathspec))
      const output = await this.run('识别上游重命名', () => this.git.raw(args))
      pairs.push(...parseNameStatus(output))
    }
    return pairs
  }

  /**
   * Move paths the way git expects: `-f` because the destination may already hold an untracked
   * copy of nothing (a stale build artifact), and `--` so a path that starts with `-` stays a
   * path. Both halves land in the index, which is what makes the commit a real rename.
   */
  async renamePaths(pairs: RenamePair[]): Promise<void> {
    await this.run('移动上游重命名的文件', async () => {
      for (const group of chunk(pairs)) {
        for (const pair of group) {
          await this.git.raw(['mv', '-f', '--', pair.from, pair.to])
        }
      }
    })
  }

  /** Tracked files whose working-tree content differs from HEAD inside the scopes. */
  async locallyModifiedPaths(scopes: RepoPath[]): Promise<RepoPath[]> {
    const output = await this.run('检测本地改动', () => this.git.raw(['diff', '--name-only', '-z', 'HEAD', '--']))
    return this.filterScopes(output, scopes)
  }

  async untrackedPaths(scopes: RepoPath[]): Promise<RepoPath[]> {
    const output = await this.run('检测未跟踪文件', () => this.git.raw(['ls-files', '--others', '--exclude-standard', '-z']))
    return this.filterScopes(output, scopes)
  }

  async stagedPaths(): Promise<RepoPath[]> {
    const output = await this.run('读取暂存区', () => this.git.raw(['diff', '--cached', '--name-only', '-z', 'HEAD']))
    return parseNulList(output).map(line => line.trim()).filter(Boolean)
  }

  /** Whether git actually materialises symlinks here (false on Windows without developer mode). */
  async supportsSymlinks(): Promise<boolean> {
    const out = await this.run('读取 core.symlinks', async () => {
      try {
        return (await this.git.raw(['config', '--bool', '--get', 'core.symlinks'])).trim()
      }
      catch {
        // Absent key means git's own default, which is true everywhere but Windows.
        return process.platform === 'win32' ? '' : 'true'
      }
    })
    return out === 'true'
  }

  async readBlobText(ref: string, repoPath: RepoPath): Promise<string> {
    return this.run(`读取 ${ref}:${repoPath}`, () => this.git.show([`${ref}:${repoPath}`]))
  }

  /**
   * `readBlobText` where a missing blob is an answer instead of an accident.
   *
   * Used by inspections (LFS pointers, file-type sniffing) that must never turn a path they
   * could not look at into a failed run.
   */
  async readBlobTextSafe(ref: string, repoPath: RepoPath): Promise<string | null> {
    try {
      return await this.readBlobText(ref, repoPath)
    }
    catch {
      return null
    }
  }

  /** Write revision content into the working tree *and* the index (git-native, binary safe). */
  async checkoutPathsFromRef(ref: string, paths: RepoPath[]): Promise<void> {
    await this.run(`应用 ${ref} 的文件`, async () => {
      for (const group of chunk(paths)) {
        await this.git.checkout(ref, ['--', ...group.map(pathspec)])
      }
    })
  }

  /** Drop pending changes for these paths, restoring the committed local version. */
  async restorePathsFromHead(paths: RepoPath[]): Promise<void> {
    await this.run('恢复本地文件', async () => {
      for (const group of chunk(paths)) {
        await this.git.checkout('HEAD', ['--', ...group.map(pathspec)])
      }
    })
  }

  /**
   * `git rm` without `-f` on purpose: a file with uncommitted local edits refuses to go away,
   * so an accidental deletion stops here instead of eating somebody's work.
   */
  async removePaths(paths: RepoPath[], options: { force?: boolean } = {}): Promise<void> {
    await this.run('删除上游已移除的文件', async () => {
      for (const group of chunk(paths)) {
        await this.git.raw([
          'rm',
          '-q',
          '--ignore-unmatch',
          ...(options.force ? ['-f'] : []),
          '--',
          ...group.map(pathspec),
        ])
      }
    })
  }

  /** `-r` is what lets a path that is a local directory become an upstream file. */
  async removeRecursive(paths: RepoPath[]): Promise<void> {
    await this.run('删除本地同名目录', async () => {
      for (const group of chunk(paths)) {
        await this.git.raw(['rm', '-r', '-q', '--ignore-unmatch', '--', ...group.map(pathspec)])
      }
    })
  }

  /** Where a branch is pushed to: its tracked upstream, else `origin/<branch>`. */
  async pushTarget(branch: string): Promise<{ remote: string, branch: string }> {
    const tracked = await this.run(`读取 ${branch} 的上游分支`, async () => {
      try {
        return (await this.git.raw(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])).trim()
      }
      catch {
        return ''
      }
    })
    if (tracked.includes('/')) {
      const index = tracked.indexOf('/')
      return { remote: tracked.slice(0, index), branch: tracked.slice(index + 1) }
    }
    if (!(await this.hasRemote('origin'))) {
      throw new GitError(t('e.noPushTarget', { branch }))
    }
    return { remote: 'origin', branch }
  }

  async addPaths(paths: RepoPath[]): Promise<void> {
    await this.run('暂存文件', async () => {
      for (const group of chunk(paths)) {
        await this.git.raw(['add', '--', ...group.map(pathspec)])
      }
    })
  }

  /**
   * Commit the index as it stands (no `paths`), or restrict the commit to an explicit path
   * list so a run never sweeps up files somebody else had staged. The restricted form is an
   * `--only` commit — git re-reads those paths from the working tree, so prefer the plain
   * index commit whenever nothing foreign is staged. The list travels through a temp file to
   * stay below the Windows command-line limit.
   */
  async commit(message: string, paths: RepoPath[] = []): Promise<string> {
    return this.run('提交变更', async () => {
      if (paths.length === 0) {
        await this.git.commit(message)
        return this.revHead()
      }

      const specFile = path.join(os.tmpdir(), `sync-upstream-pathspec-${process.pid}-${Date.now()}.txt`)
      // One literal pathspec per line: newline-separated, so the same escaping rules as `-z`
      // output apply and glob characters in a file name stay inert.
      await fs.writeFile(specFile, `${paths.map(pathspec).join('\n')}\n`, 'utf8')
      try {
        await this.git.raw(['commit', '-m', message, `--pathspec-from-file=${specFile}`])
        return await this.revHead()
      }
      finally {
        await fs.remove(specFile).catch(() => undefined)
      }
    })
  }

  /**
   * Inverse of the current commit, with git's own message. Used by `--undo`: reverting is
   * additive, so a colleague who already pulled the sync commit is not left behind a reset.
   */
  async revertHead(): Promise<string> {
    await this.run('撤销最近一次提交', () => this.git.raw(['revert', '--no-edit', 'HEAD']))
    return this.revHead()
  }

  private async revHead(): Promise<string> {
    const out = await this.git.raw(['rev-parse', 'HEAD'])
    const hash = out.trim()
    if (!hash)
      throw new GitError(t('e.noNewCommit'))
    return hash
  }

  /**
   * Push one branch. `setUpstream` is what a PR branch needs: without `-u` the branch exists on
   * the remote but every later `pushTarget` still has to fall back to `origin/<same-name>`.
   */
  async push(remote: string, branch: string, options: { setUpstream?: boolean } = {}): Promise<void> {
    await this.run(`推送到 ${remote}/${branch}`, () => this.git.push(remote, branch, options.setUpstream ? ['--set-upstream'] : []))
  }

  async head(): Promise<string> {
    return this.resolveRef('HEAD')
  }

  /** `git --version` without the prefix — `doctor` reports it when a feature behaves oddly. */
  async version(): Promise<string> {
    const out = await this.run('读取 git 版本', () => this.git.raw(['--version']))
    return out.trim().replace(/^git version\s+/, '')
  }

  /** URL a remote points at, or undefined when the remote does not exist. */
  async remoteUrl(name: string): Promise<string | undefined> {
    return this.run(`读取远程 ${name} 地址`, async () => {
      try {
        return (await this.git.raw(['remote', 'get-url', name])).trim() || undefined
      }
      catch {
        return undefined
      }
    })
  }

  /** Effective value of a git config key (respects local/global/system layers). */
  async configValue(key: string): Promise<string | undefined> {
    return this.run(`读取配置 ${key}`, async () => {
      try {
        return (await this.git.raw(['config', '--get', key])).trim() || undefined
      }
      catch {
        return undefined
      }
    })
  }

  /**
   * Whether git itself would skip this path (`git check-ignore`). Authoritative for files
   * outside the sync scopes, where the pipeline's own matcher never looks.
   *
   * `-v` instead of `-q`: simple-git resolves a `check-ignore -q` that exits 1, so the silent
   * form cannot tell "not ignored" apart from "ignored" — every path looked ignored. The
   * verbose form prints the rule that matched and prints nothing when nothing matched.
   */
  async isIgnoredByGit(repoPath: RepoPath): Promise<boolean> {
    const matched = await this.git.raw(['check-ignore', '-v', '--', repoPath]).catch(() => '')
    return matched.trim().length > 0
  }

  /** Does this revision / object still exist locally (guards against garbage collection)? */
  async objectExists(rev: string): Promise<boolean> {
    try {
      const out = await this.git.raw(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
      return out.trim() !== ''
    }
    catch {
      return false
    }
  }

  /**
   * Commits `to` has that `from` lacks (`git rev-list --count from..to`).
   * Null for unrelated histories or missing refs — status shows "无法比较" instead of 0.
   */
  async countCommitsBetween(from: string, to: string): Promise<number | null> {
    try {
      const out = await this.git.raw(['rev-list', '--count', `${from}..${to}`])
      const count = Number(out.trim())
      return Number.isFinite(count) ? count : null
    }
    catch {
      return null
    }
  }

  private filterScopes(output: string, scopes: RepoPath[]): RepoPath[] {
    // `-z` records are exact repository paths; on POSIX a backslash is a legal file name,
    // so rewriting separators here would corrupt them instead of normalise them.
    const paths = parseNulList(output).map(line => line.trim()).filter(Boolean)
    if (scopes.length === 0)
      return paths
    return paths.filter(repoPath => scopeOf(repoPath, scopes) !== null)
  }

  /** Fail fast with an actionable message instead of a stack trace. */
  static rethrow(error: unknown, action: string): never {
    throw wrapGitError(action, error)
  }

  static cause(error: unknown): string {
    return toError(error).message
  }
}
