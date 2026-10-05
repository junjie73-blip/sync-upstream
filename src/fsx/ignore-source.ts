import type { RepoPath } from '../domain'
import type { IgnoreRule } from './ignore-rules'
import path from 'node:path'
import fs from 'fs-extra'
import { compileIgnorePattern, IgnoreMatcher, parseIgnoreFile } from './ignore-rules'
import { normalizeRepoPath } from './paths'

/** Tool-owned artefacts. Deliberately excludes `dist`/`build`: those are real project output. */
export const BUILTIN_IGNORE_PATTERNS = [
  '.git/',
  'node_modules/',
  '.sync-cache/',
  '.sync-temp/',
  '.sync-hashes.json',
  '.sync-state.json',
  '.DS_Store',
]

export interface IgnoreSource {
  file: RepoPath
  base: RepoPath
  source: string
}

export interface LoadIgnoreOptions {
  repoRoot: string
  /** Extra patterns from `syncDirs`-level `.gitignore` files. */
  scopes?: RepoPath[]
  configPatterns?: string[]
}

export interface LoadedIgnore {
  matcher: IgnoreMatcher
  rules: IgnoreRule[]
  files: RepoPath[]
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    if (!(await fs.pathExists(filePath)))
      return null
    return await fs.readFile(filePath, 'utf8')
  }
  catch {
    return null
  }
}

/**
 * Collect ignore rules the way git does: built-ins first, then the repository
 * `.gitignore`, then `.syncignore`, then config patterns, then per-directory
 * `.gitignore` files inside each sync scope (deeper files win).
 */
export async function loadIgnoreMatcher(options: LoadIgnoreOptions): Promise<LoadedIgnore> {
  const { repoRoot, scopes = [], configPatterns = [] } = options
  const rules: IgnoreRule[] = []
  const files: RepoPath[] = []

  for (const pattern of BUILTIN_IGNORE_PATTERNS) {
    const rule = compileIgnorePattern(pattern, { source: 'builtin' })
    if (rule)
      rules.push(rule)
  }

  const rootGitignore = await readIfExists(path.join(repoRoot, '.gitignore'))
  if (rootGitignore !== null) {
    rules.push(...parseIgnoreFile(rootGitignore, { source: '.gitignore' }))
    files.push('.gitignore')
  }

  const syncignore = await readIfExists(path.join(repoRoot, '.syncignore'))
  if (syncignore !== null) {
    rules.push(...parseIgnoreFile(syncignore, { source: '.syncignore' }))
    files.push('.syncignore')
  }

  for (const pattern of configPatterns) {
    const rule = compileIgnorePattern(normalizeRepoPath(pattern), { source: 'config' })
    if (rule)
      rules.push(rule)
  }

  for (const scope of scopes) {
    const nested = await collectNestedIgnoreFiles(repoRoot, scope)
    for (const entry of nested) {
      const content = await readIfExists(path.join(repoRoot, ...entry.file.split('/')))
      if (content === null)
        continue
      rules.push(...parseIgnoreFile(content, { base: entry.base, source: entry.file }))
      files.push(entry.file)
    }
  }

  return { matcher: new IgnoreMatcher(rules), rules, files }
}

interface NestedIgnoreEntry {
  file: RepoPath
  base: RepoPath
}

async function collectNestedIgnoreFiles(repoRoot: string, scope: RepoPath): Promise<NestedIgnoreEntry[]> {
  const found: NestedIgnoreEntry[] = []
  const stack: RepoPath[] = [normalizeRepoPath(scope)]
  let visited = 0

  while (stack.length > 0) {
    const current = stack.pop() as RepoPath
    // Guard against symlink loops and pathological trees on huge repositories.
    if (++visited > 20000)
      break

    let entries: Array<import('node:fs').Dirent>
    try {
      entries = await fs.readdir(path.join(repoRoot, ...current.split('/')), { withFileTypes: true })
    }
    catch {
      continue
    }

    for (const entry of entries) {
      const childPath = `${current}/${entry.name}`
      if (entry.isFile() && entry.name === '.gitignore') {
        found.push({ file: childPath, base: current })
        continue
      }
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'node_modules') {
        stack.push(childPath)
      }
    }
  }

  // Shallowest first so deeper .gitignore rules are evaluated last and therefore win.
  return found.sort((a, b) => a.file.split('/').length - b.file.split('/').length)
}
