import type { SyncReportData } from '../../src/commands/types'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { appendCiSummary, emit, stripAnsi, toReport } from '../../src/commands/output'
import { syncMarkdown } from '../../src/commands/sync-report'

/** 一行里两种写法都有：真实转义（终端）与字面 \u001b（JSON 序列化之后）。 */
const ANSI = '\u001B[32m彩色\u001B[39m'
const ESCAPED = '\\u001b[32m彩色\\u001b[39m'

let written = ''
let stdoutSpy: jest.SpyInstance

beforeEach(() => {
  written = ''
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    written += String(chunk)
    return true
  }) as any)
})

afterEach(() => {
  stdoutSpy.mockRestore()
})

describe('toReport', () => {
  it('ok 决定默认退出码，显式退出码优先', () => {
    expect(toReport('status', {}, {}).exitCode).toBe(0)
    expect(toReport('why', {}, { ok: false }).exitCode).toBe(1)
    expect(toReport('doctor', {}, { ok: false, exitCode: 3 }).exitCode).toBe(3)
  })

  it('空 summary 不占字段，warnings 总有数组', () => {
    const report = toReport('history', { a: 1 })
    expect(report.warnings).toEqual([])
    expect('summary' in report).toBe(false)
    expect(report.generatedAt).toMatch(/^\d{4}-/)
  })
})

describe('emit 与 stripAnsi', () => {
  it('人类模式逐行输出，机器模式只输出一个 JSON 文档', () => {
    const report = toReport('status', { text: ANSI })

    emit(report, ['第一行', '第二行'], false)
    expect(written).toBe('第一行\n第二行\n')

    written = ''
    emit(report, ['不该出现'], true)
    expect(written).not.toContain('不该出现')
    expect(() => JSON.parse(written)).not.toThrow()
    expect(JSON.parse(written).data.text).toBe('彩色')
  })

  it('JSON.stringify 产生的字面 \\u001b 转义也会被清掉', () => {
    const value = JSON.stringify({ text: ANSI })
    // 终端里存活的转义在 JSON 里是字面的 \u001b 文本，正则两种都要覆盖。
    expect(value).toContain('\\u001b[32m')
    expect(stripAnsi(value)).not.toMatch(/\\u001b\[\d+m/)
    expect(JSON.parse(stripAnsi(value)).text).toBe('彩色')
  })

  it('真实转义字符与字面写法都被清掉', () => {
    expect(stripAnsi(ANSI)).toBe('彩色')
    expect(stripAnsi(ESCAPED)).toBe('彩色')
  })

  it('普通文本原样保留', () => {
    expect(stripAnsi('a\nb "quoted"')).toBe('a\nb "quoted"')
  })
})

describe('appendCiSummary', () => {
  let dir: string
  const previous = process.env.GITHUB_STEP_SUMMARY

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-summary-'))
  })

  afterEach(async () => {
    process.env.GITHUB_STEP_SUMMARY = previous as string
    if (previous === undefined)
      delete process.env.GITHUB_STEP_SUMMARY
    await fs.remove(dir)
  })

  it('没有 GITHUB_STEP_SUMMARY 时什么都不做', async () => {
    delete process.env.GITHUB_STEP_SUMMARY

    expect(await appendCiSummary('### x')).toBeUndefined()
  })

  it('追加 markdown，目录不存在也会创建', async () => {
    const file = path.join(dir, 'nested', 'step.md')
    process.env.GITHUB_STEP_SUMMARY = file

    expect(await appendCiSummary('### 第一段')).toBeUndefined()
    await appendCiSummary('### 第二段')

    const content = await fs.readFile(file, 'utf8')
    expect(content).toBe('### 第一段\n### 第二段\n')
  })

  it('写不进去时返回警告而不是抛错', async () => {
    // 指向一个目录：appendFile 必然失败，但诊断命令不该因此崩掉。
    process.env.GITHUB_STEP_SUMMARY = dir

    const warning = await appendCiSummary('### x')
    expect(warning).toContain('GITHUB_STEP_SUMMARY 写入失败')
  })
})

describe('syncMarkdown', () => {
  const base: SyncReportData = {
    previewed: false,
    startedOn: 'company',
    endedOn: 'company',
    plan: {
      summary: { add: 1, modify: 2, delete: 0, rename: 1, conflict: 1, skipped: 3 },
      changes: [],
      conflicts: [{ path: 'src/a.ts', conflictType: 'content' }],
      skipped: [],
      dirty: [],
      upstreamCommitsAhead: null,
      targetCommitsAhead: null,
    },
    applied: { applied: 3, keptTarget: 1, failed: 1, list: [] },
    commit: { created: true, hash: 'c0ffee00deadbeef', files: 4 },
    failed: [{ path: 'src/b.ts', error: '权限不足' }],
    sources: [],
  }

  it('提交、失败与冲突都写进步骤摘要', () => {
    const text = syncMarkdown(base, 'refs/remotes/sync-upstream/main', 'company')

    expect(text).toContain('已同步')
    expect(text).toContain('新增 1、修改 2、重命名 1、删除 0、冲突 1、跳过 3')
    expect(text).toContain('成功 3、保留本地 1、失败 1')
    expect(text).toContain('`c0ffee00`（4 个文件）')
    expect(text).toContain('#### 失败文件')
    expect(text).toContain('`src/b.ts`：权限不足')
    expect(text).toContain('#### 冲突文件')
    expect(text).not.toContain('未提交原因')
  })

  it('没有提交时说明原因，分支没变则不写分支行', () => {
    const text = syncMarkdown({
      ...base,
      commit: { created: false, files: 0, reason: '没有需要提交的变化' },
      endedOn: 'sync/company-2026',
    }, 'FETCH_HEAD', 'company')

    expect(text).toContain('未产生提交')
    expect(text).toContain('没有需要提交的变化')
    expect(text).toContain('运行前 `company`，结束时 `sync/company-2026`')
  })

  it('PR 模式写清分支、推送结果与可点的对比链接', () => {
    const pushed = syncMarkdown({
      ...base,
      pullRequest: { branch: 'sync-upstream/company-20261022', baseBranch: 'company', remote: 'origin', pushed: true, url: 'https://github.com/org/repo/compare/company...sync-upstream/company-20261022', created: true },
    }, 'refs/remotes/sync-upstream/main', 'company')

    expect(pushed).toContain('PR 模式：分支 `sync-upstream/company-20261022`（已推送 origin/sync-upstream/company-20261022）')
    expect(pushed).toContain('目标分支 `company` 未改动')
    expect(pushed).toContain('已创建 PR：https://github.com/org/repo/compare/company...sync-upstream/company-20261022')

    // 推送被拒时摘要要说"未推送"，并把原因原样带出来，否则 CI 里只剩一句成功。
    const rejected = syncMarkdown({
      ...base,
      pullRequest: { branch: 'sync-upstream/company-20261022', baseBranch: 'company', remote: 'origin', pushed: false, url: null, note: '推送 origin/sync-upstream/company-20261022 失败：保护分支' },
    }, 'refs/remotes/sync-upstream/main', 'company')

    expect(rejected).toContain('（未推送）')
    expect(rejected).toContain('提示：推送 origin/sync-upstream/company-20261022 失败：保护分支')
    expect(rejected).not.toContain('已创建 PR')
  })

  it('Git LFS 一行说清策略，取回失败时把原因挂在下面', () => {
    const kept = syncMarkdown({
      ...base,
      lfs: { mode: 'pointer', pointers: ['src/a.png', 'src/b.png'], materialized: [] },
    }, 'FETCH_HEAD', 'company')
    expect(kept).toContain('Git LFS：2 个文件同步的是指针文本（策略 `pointer`）')

    const back = syncMarkdown({
      ...base,
      lfs: { mode: 'materialize', pointers: ['src/a.png'], materialized: ['src/a.png'] },
    }, 'FETCH_HEAD', 'company')
    expect(back).toContain('Git LFS：1 个指针文件，已取回 1 个的真实内容')

    const failed = syncMarkdown({
      ...base,
      lfs: { mode: 'materialize', pointers: ['src/a.png'], materialized: [], note: '本机没有安装 git-lfs' },
    }, 'FETCH_HEAD', 'company')
    expect(failed).toContain('提示：本机没有安装 git-lfs')

    // 没有 LFS 文件的运行不该出现这一行。
    expect(syncMarkdown(base, 'FETCH_HEAD', 'company')).not.toContain('Git LFS')
  })
})
