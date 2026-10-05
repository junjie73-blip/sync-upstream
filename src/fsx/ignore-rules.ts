import type { RepoPath } from '../domain'
import { ancestorsOf, normalizeRepoPath } from './paths'

export interface IgnoreRule {
  /** Original pattern text, kept for diagnostics. */
  pattern: string
  base: RepoPath
  negated: boolean
  dirOnly: boolean
  anchored: boolean
  regexp: RegExp
  source: string
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g

function escapeLiteral(value: string): string {
  return value.replace(REGEX_SPECIAL, '\\$&')
}

/** Strip unescaped trailing whitespace the way gitignore does. */
function trimTrailingSpaces(line: string): string {
  let end = line.length
  while (end > 0 && line[end - 1] === ' ') {
    let backslashes = 0
    let cursor = end - 2
    while (cursor >= 0 && line[cursor] === '\\') {
      backslashes++
      cursor--
    }
    if (backslashes % 2 === 1)
      break
    end--
  }
  return line.slice(0, end)
}

/** Translate one glob segment (never contains `/`) into regex source. */
function translateGlobSegment(segment: string): string {
  let out = ''
  let index = 0

  while (index < segment.length) {
    const char = segment[index]

    if (char === '*') {
      const isDouble = segment[index + 1] === '*'
      out += isDouble ? '.*' : '[^/]*'
      index += isDouble ? 2 : 1
      continue
    }

    if (char === '?') {
      out += '[^/]'
      index++
      continue
    }

    if (char === '[') {
      const close = segment.indexOf(']', index + 1)
      if (close === -1) {
        out += '\\['
        index++
        continue
      }
      let body = segment.slice(index + 1, close)
      if (body.startsWith('!'))
        body = `^${body.slice(1)}`
      out += `[${body}]`
      index = close + 1
      continue
    }

    if (char === '\\') {
      const next = segment[index + 1]
      if (next !== undefined) {
        out += escapeLiteral(next)
        index += 2
        continue
      }
      out += '\\\\'
      index++
      continue
    }

    out += escapeLiteral(char)
    index++
  }

  return out
}

function translateGlobPath(text: string): string {
  const segments = text.split('/').filter(segment => segment !== '')
  let body = ''

  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1
    if (segment === '**') {
      // A trailing `**` means "everything below"; a middle `**/` also matches zero directories.
      body += isLast ? '.*' : '(?:[^/]+/)*'
      continue
    }
    body += translateGlobSegment(segment)
    if (!isLast)
      body += '/'
  }

  return body
}

/**
 * Compile one gitignore-style pattern into an anchored regular expression.
 * Returns null for blank lines and comments.
 */
export function compileIgnorePattern(
  rawPattern: string,
  options: { base?: RepoPath, source?: string } = {},
): IgnoreRule | null {
  const base = normalizeRepoPath(options.base ?? '')
  const source = options.source ?? 'config'
  let text = trimTrailingSpaces(rawPattern.trim())
  if (text === '' || text.startsWith('#'))
    return null

  let negated = false
  if (text.startsWith('!')) {
    negated = true
    text = text.slice(1).trim()
  }
  if (text === '')
    return null

  let dirOnly = false
  if (text.endsWith('/')) {
    dirOnly = true
    text = text.slice(0, -1)
  }
  if (text === '')
    return null

  // A pattern is anchored to its base directory when it contains a slash anywhere
  // but the trailing position (`node_modules/` still matches at any level).
  const anchored = text.includes('/')
  if (text.startsWith('/'))
    text = text.slice(1)

  const prefix = base === '' ? '' : `${translateGlobPath(base)}/`
  const unanchored = anchored ? '' : '(?:[^/]+/)*'
  const suffix = dirOnly ? '(?:/.*)?' : ''

  return {
    pattern: rawPattern,
    base,
    negated,
    dirOnly,
    anchored,
    source,
    regexp: new RegExp(`^${prefix}${unanchored}${translateGlobPath(text)}${suffix}$`),
  }
}

export function compileIgnorePatterns(
  patterns: string[],
  options: { base?: RepoPath, source?: string } = {},
): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const pattern of patterns) {
    const rule = compileIgnorePattern(pattern, options)
    if (rule)
      rules.push(rule)
  }
  return rules
}

export function parseIgnoreFile(text: string, options: { base?: RepoPath, source?: string } = {}): IgnoreRule[] {
  return compileIgnorePatterns(text.split(/\r?\n/), options)
}

/**
 * Ignore matcher with gitignore semantics: rules apply in order (last match wins,
 * `!` re-includes) and nothing inside an excluded directory can be re-included.
 */
export class IgnoreMatcher {
  constructor(private readonly rules: IgnoreRule[] = []) {}

  get size(): number {
    return this.rules.length
  }

  extend(rules: IgnoreRule[]): IgnoreMatcher {
    return new IgnoreMatcher([...this.rules, ...rules])
  }

  private decide(segment: RepoPath, isDir: boolean): IgnoreRule | null {
    let decider: IgnoreRule | null = null
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir)
        continue
      if (rule.regexp.test(segment))
        decider = rule
    }
    return decider
  }

  /** Rule that excludes this path, or null when it is kept. */
  ruleFor(repoPath: RepoPath, isDir = false): IgnoreRule | null {
    const normalized = normalizeRepoPath(repoPath)
    if (normalized === '')
      return null

    for (const ancestor of ancestorsOf(normalized).reverse()) {
      const decider = this.decide(ancestor, true)
      // An excluded directory cannot be re-included from below, so stop at the first one.
      if (decider && !decider.negated)
        return decider
    }

    const decider = this.decide(normalized, isDir)
    return decider && !decider.negated ? decider : null
  }

  isIgnored(repoPath: RepoPath, isDir = false): boolean {
    return this.ruleFor(repoPath, isDir) !== null
  }
}
