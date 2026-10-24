import type { PrConfig } from '../domain'
import { execFile } from 'node:child_process'
import process from 'node:process'
import { toError } from '../errors'

export type PrTool = 'gh' | 'glab'

export interface PullRequestRequest {
  cwd: string
  head: string
  base: string
  title: string
  body: string
  draft?: boolean
  /** Leave undefined to pick the tool from the remote host. */
  tool?: PrTool
  /**
   * Executable to call. Windows installs sometimes expose only `gh.cmd`, and `execFile('gh')`
   * cannot see a batch shim — `findPrTool` returns whichever spelling actually runs.
   */
  command?: string
  timeoutMs?: number
}

export interface PullRequestOutcome {
  /** False when the configuration or the platform said "do not try". */
  attempted: boolean
  tool?: PrTool
  created: boolean
  /** PR page the tool printed, when it printed one. */
  url?: string
  /** Why nothing was created. Never fatal: a missing CLI is an instruction, not a failed sync. */
  error?: string
}

const DEFAULT_TIMEOUT_MS = 60_000
/** Both CLIs take the body as one argument, and the Windows command line is finite. */
const BODY_LIMIT = 4000

/** `glab` talks to GitLab and only GitLab; everything else gets `gh`. */
export function toolForRemote(remoteUrl: string | undefined, override?: PrTool): PrTool {
  if (override)
    return override
  return /gitlab\./i.test(remoteUrl ?? '') ? 'glab' : 'gh'
}

/**
 * Open the pull/merge request with the platform CLI if one is installed.
 *
 * The sync itself never depends on this: the branch is already pushed, so a missing CLI, a
 * revoked token, or a machine with neither tool still leaves a reviewable PR branch and a
 * compare URL. That is why every failure here is returned as `error` instead of thrown.
 */
export async function createPullRequest(
  request: PullRequestRequest,
  config?: PrConfig,
): Promise<PullRequestOutcome> {
  if (config?.create === 'never' || process.env.SYNC_UPSTREAM_PR_CREATE === '0')
    return { attempted: false, created: false, error: '配置为不自动创建 PR' }

  const tool = request.tool ?? toolForRemote(undefined, config?.tool)
  const args = tool === 'glab'
    ? ['mr', 'create', '--source-branch', request.head, '--target-branch', request.base, '--title', request.title, '--description', clipped(request.body), ...(request.draft ? ['--draft'] : []), '--yes']
    : ['pr', 'create', '--head', request.head, '--base', request.base, '--title', request.title, '--body', clipped(request.body), ...(request.draft ? ['--draft'] : [])]

  try {
    const stdout = await run(request.command ?? tool, args, request.cwd, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    return { attempted: true, tool, created: true, url: firstUrl(stdout) }
  }
  catch (error) {
    const detail = toError(error)
    if (isMissingCli(detail))
      return { attempted: true, tool, created: false, error: `未检测到 ${tool}，请手动打开对比链接创建 PR` }
    return { attempted: true, tool, created: false, error: firstLine(detail.message) }
  }
}

/**
 * Which executable actually runs.
 *
 * Windows package managers install `gh` as a `.cmd` shim, and `execFile('gh')` cannot resolve a
 * batch file — `doctor` needs the difference because "gh is missing" and "gh is a shim we could
 * not call" lead to different fixes.
 */
export async function findPrTool(tool: PrTool, cwd?: string): Promise<string | null> {
  const candidates = process.platform === 'win32' ? [tool, `${tool}.cmd`, `${tool}.exe`] : [tool]
  for (const candidate of candidates) {
    try {
      await run(candidate, ['--version'], cwd ?? process.cwd(), 15_000)
      return candidate
    }
    catch {
      // try the next spelling
    }
  }
  return null
}

function clipped(body: string): string {
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}…` : body
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map(item => item.trim()).find(Boolean) ?? value
}

function isMissingCli(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' || /not recognized|不是内部或外部命令|command not found/i.test(error.message)
}

function firstUrl(stdout: string): string | undefined {
  return /https?:\/\/\S+/.exec(stdout)?.[0]
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          // Keep the errno: `isMissingCli` tells "gh is not installed" apart from "gh said no",
          // and re-wrapping as a plain Error is what used to throw that signal away.
          const wrapped = new Error(`${error.message}${stderr ? `\n${stderr.trim()}` : ''}`) as NodeJS.ErrnoException
          wrapped.code = (error as NodeJS.ErrnoException).code
          reject(wrapped)
        }
        else {
          resolve(`${stdout}\n${stderr}`)
        }
      },
    )
  })
}
