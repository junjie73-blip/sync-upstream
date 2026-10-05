import type { ConflictContentSource, RepoPath } from '../domain'
import type { GitRepository } from '../git/repository'
import path from 'node:path'
import fs from 'fs-extra'

export interface ConflictSourceOptions {
  git: GitRepository
  repoRoot: string
  upstreamRef: string
  /** Merge-base revision; null when the branches have no common ancestor. */
  baseRef: string | null
}

async function readWorkingTree(repoRoot: string, repoPath: RepoPath): Promise<string | null> {
  const absolute = path.join(repoRoot, ...repoPath.split('/'))
  try {
    if (!(await fs.pathExists(absolute)))
      return null
    return await fs.readFile(absolute, 'utf8')
  }
  catch {
    // Unreadable (locked, symlink to elsewhere, binary device file) counts as "no local copy".
    return null
  }
}

async function readBlobOrEmpty(git: GitRepository, ref: string | null, repoPath: RepoPath): Promise<string | null> {
  if (!ref)
    return null
  try {
    return await git.readBlobText(ref, repoPath)
  }
  catch {
    return null
  }
}

/**
 * Adapter feeding the pure conflict resolver with content from git and the working tree.
 * `local` is the working-tree file so uncommitted edits participate in the merge.
 */
export function createConflictContentSource(options: ConflictSourceOptions): ConflictContentSource {
  const { git, repoRoot, upstreamRef, baseRef } = options
  return {
    base: repoPath => readBlobOrEmpty(git, baseRef, repoPath),
    local: repoPath => readWorkingTree(repoRoot, repoPath),
    upstream: repoPath => readBlobOrEmpty(git, upstreamRef, repoPath),
  }
}
