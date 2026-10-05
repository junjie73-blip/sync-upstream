import type { SimpleGit, SimpleGitProgressEvent } from 'simple-git'
import type { RepoPath } from '../domain'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import simpleGit from 'simple-git'
import { GitError, toError } from '../errors'
import { scopeOf } from '../fsx/paths'
import { wrapGitError } from './url'

/** Keep argv well below the Windows command-line limit when passing many paths. */
const PATH_CHUNK_SIZE = 50

export interface GitRepositoryOptions {
  /** Extra environment for every git subprocess (e.g. `GIT_SSH_COMMAND`). */
  env?: Record<string, string>
  onProgress?: (event: SimpleGitProgressEvent) => void
}

export interface TreeEntry {
  oid: string
  mode: string
}

function chunk<T>(items: T[], size = PATH_CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

export function parseLsTree(output: string): Map<RepoPath, TreeEntry> {
  const entries = new Map<RepoPath, TreeEntry>()
  for (const line of output.split('\n')) {
    if (line.trim() === '')
      continue
    // <mode> SP <type> SP <oid> TAB <path>
    const tab = line.indexOf('\t')
    if (tab === -1)
      continue
    const [mode, type, oid] = line.slice(0, tab).split(' ')
    const repoPath = line.slice(tab + 1).replace(/\\/g, '/')
    // Submodules cannot be synced file-by-file.
    if (type !== 'blob')
      continue
    entries.set(repoPath, { oid, mode })
  }
  return entries
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
      config: ['core.quotepath=false'],
    })
    if (options.env)
      this.git.env(options.env)
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

  async fetch(remote: string, ref: string): Promise<void> {
    await this.run(`拉取 ${remote}/${ref}`, () => this.git.fetch(remote, ref, ['--no-tags']))
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

  /** path → blob entry for a revision, restricted to the requested scopes. */
  async listTree(ref: string, scopes: RepoPath[] = []): Promise<Map<RepoPath, TreeEntry>> {
    const output = await this.run(`读取 ${ref} 的文件清单`, () => this.git.raw(['ls-tree', '-r', '--full-name', ref]))
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

  /** Tracked files whose working-tree content differs from HEAD inside the scopes. */
  async locallyModifiedPaths(scopes: RepoPath[]): Promise<RepoPath[]> {
    const output = await this.run('检测本地改动', () => this.git.raw(['diff', '--name-only', 'HEAD', '--']))
    return this.filterScopes(output, scopes)
  }

  async untrackedPaths(scopes: RepoPath[]): Promise<RepoPath[]> {
    const output = await this.run('检测未跟踪文件', () => this.git.raw(['ls-files', '--others', '--exclude-standard']))
    return this.filterScopes(output, scopes)
  }

  async stagedPaths(): Promise<RepoPath[]> {
    const output = await this.run('读取暂存区', () => this.git.raw(['diff', '--cached', '--name-only', 'HEAD']))
    return output.split('\n').map(line => line.replace(/\\/g, '/').trim()).filter(Boolean)
  }

  async readBlobText(ref: string, repoPath: RepoPath): Promise<string> {
    return this.run(`读取 ${ref}:${repoPath}`, () => this.git.show([`${ref}:${repoPath}`]))
  }

  /** Write revision content into the working tree *and* the index (git-native, binary safe). */
  async checkoutPathsFromRef(ref: string, paths: RepoPath[]): Promise<void> {
    await this.run(`应用 ${ref} 的文件`, async () => {
      for (const group of chunk(paths)) {
        await this.git.checkout(ref, ['--', ...group])
      }
    })
  }

  /** Drop pending changes for these paths, restoring the committed local version. */
  async restorePathsFromHead(paths: RepoPath[]): Promise<void> {
    await this.run('恢复本地文件', async () => {
      for (const group of chunk(paths)) {
        await this.git.checkout('HEAD', ['--', ...group])
      }
    })
  }

  async removePaths(paths: RepoPath[]): Promise<void> {
    await this.run('删除上游已移除的文件', async () => {
      for (const group of chunk(paths)) {
        await this.git.raw(['rm', '-q', '--ignore-unmatch', '--', ...group])
      }
    })
  }

  /** `-r` is what lets a path that is a local directory become an upstream file. */
  async removeRecursive(paths: RepoPath[]): Promise<void> {
    await this.run('删除本地同名目录', async () => {
      for (const group of chunk(paths)) {
        await this.git.raw(['rm', '-r', '-q', '--ignore-unmatch', '--', ...group])
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
      throw new GitError(`分支 ${branch} 没有上游分支，仓库也没有 origin 远程，无法推送`)
    }
    return { remote: 'origin', branch }
  }

  async addPaths(paths: RepoPath[]): Promise<void> {
    await this.run('暂存文件', async () => {
      for (const group of chunk(paths)) {
        await this.git.raw(['add', '--', ...group])
      }
    })
  }

  /**
   * Commit an explicit path list so one run never sweeps files somebody else had staged.
   * The list travels through a temp file to stay below the Windows command-line limit.
   */
  async commit(message: string, paths: RepoPath[] = []): Promise<string> {
    return this.run('提交变更', async () => {
      if (paths.length === 0) {
        await this.git.commit(message)
        return this.revHead()
      }

      const specFile = path.join(os.tmpdir(), `sync-upstream-pathspec-${process.pid}-${Date.now()}.txt`)
      await fs.writeFile(specFile, `${paths.join('\n')}\n`, 'utf8')
      try {
        await this.git.raw(['commit', '-m', message, `--pathspec-from-file=${specFile}`])
        return await this.revHead()
      }
      finally {
        await fs.remove(specFile).catch(() => undefined)
      }
    })
  }

  private async revHead(): Promise<string> {
    const out = await this.git.raw(['rev-parse', 'HEAD'])
    const hash = out.trim()
    if (!hash)
      throw new GitError('提交未生成新的 commit')
    return hash
  }

  async push(remote: string, branch: string): Promise<void> {
    await this.run(`推送到 ${remote}/${branch}`, () => this.git.push(remote, branch))
  }

  async head(): Promise<string> {
    return this.resolveRef('HEAD')
  }

  private filterScopes(output: string, scopes: RepoPath[]): RepoPath[] {
    const paths = output
      .split('\n')
      .map(line => line.replace(/\\/g, '/').trim())
      .filter(Boolean)
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
