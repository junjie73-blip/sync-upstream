import type { CommandReport } from '../../src/commands/types'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { main, parseArgs, subcommandOf } from '../../src/cli'
import { exitCodeFor, GitError, ValidationError } from '../../src/errors'
import { logger, LogLevel } from '../../src/logger'
import { SYNC_STATE_FILE } from '../../src/pipeline/sync-state'
import { createSyncFixture } from '../helpers/sync-fixture'

let fixture: Awaited<ReturnType<typeof createSyncFixture>>
let configFile: string
let previousCwd: string
let written: string

beforeEach(async () => {
  fixture = await createSyncFixture()
  previousCwd = process.cwd()
  process.chdir(fixture.down.root)
  configFile = path.join(fixture.down.root, 'sync-upstream.config.json')
  await fs.writeJson(configFile, {
    upstreamRepo: fixture.up.root,
    upstreamBranch: 'main',
    companyBranch: 'company',
    syncDirs: ['src/config'],
    nonInteractive: true,
  })
  written = ''
  jest
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: any) => {
      written += String(chunk)
      return true
    }) as any)
})

afterEach(async () => {
  jest.restoreAllMocks()
  process.chdir(previousCwd)
  logger.setLevel(LogLevel.INFO)
  await fixture.cleanup()
})

function parseReport(): CommandReport<any> {
  return JSON.parse(written) as CommandReport<any>
}

describe('子命令参数解析', () => {
  it('第一个位置参数是子命令，其余是它的参数', () => {
    expect(subcommandOf(parseArgs(['why', 'src/config/a.ts']))).toEqual({ name: 'why', positional: ['src/config/a.ts'] })
    expect(subcommandOf(parseArgs(['status', '--fetch']))).toEqual({ name: 'status', positional: [] })
    expect(subcommandOf(parseArgs(['--json']))).toBeNull()
  })

  it('--json / --fetch / --limit / --undo 都是已注册参数', () => {
    const args = parseArgs(['history', '--json', '--limit', '3', '--undo', '-uo'])
    expect(args.json).toBe(true)
    expect(args.limit).toBe('3')
    expect(args.undo).toBe(true)
    expect(args._).toEqual(['history'])
  })
})

describe('main 的子命令分发', () => {
  it('status --json 只输出一个 JSON 文档', async () => {
    const code = await main(['status', '-C', configFile, '--json'])

    expect(code).toBe(0)
    const report = parseReport()
    expect(report.command).toBe('status')
    expect(report.ok).toBe(true)
    expect(report.data.sources[0].plan?.summary).toMatchObject({ add: 0, modify: 0 })
    // eslint-disable-next-line no-control-regex
    expect(written).not.toMatch(/\u001B\[\d+m/)
  })

  it('status --fetch 会真的拉取上游再报告', async () => {
    await fixture.drift()

    const code = await main(['status', '-C', configFile, '--fetch', '--json'])

    const report = parseReport()
    expect(code).toBe(0)
    expect(report.data.sources[0].plan?.summary).toMatchObject({ add: 1, modify: 2, delete: 1 })
    expect(report.data.sources[0].ref).toBe('refs/remotes/sync-upstream/main')
  })

  it('不带 --fetch 时不联网，也不会碰工作区', async () => {
    const before = fixture.down.gitRaw(['rev-parse', 'HEAD'])

    await main(['status', '-C', configFile])

    expect(fixture.down.gitRaw(['rev-parse', 'HEAD'])).toBe(before)
    // 同步目录内一个字节都没动（配置文件本身是未跟踪的，不参与这个判断）。
    expect(fixture.down.gitRaw(['status', '--porcelain', '--', 'src/config'])).toBe('')
    expect(written).toContain('sync-upstream status')
  })

  it('why 命中文件返回 0，路径不存在返回 1', async () => {
    await fixture.drift()

    expect(await main(['why', 'src/config/a.ts', '-C', configFile, '--fetch'])).toBe(0)
    expect(written).toContain('会同步')

    written = ''
    expect(await main(['why', 'src/config/nope.ts', '-C', configFile, '--fetch'])).toBe(1)
    expect(written).toContain('未找到该文件')
  })

  it('why 少了路径参数是参数错误（退出码 2）', async () => {
    await expect(main(['why', '-C', configFile])).rejects.toBeInstanceOf(ValidationError)
    expect(exitCodeFor(new ValidationError('x'))).toBe(2)
  })

  it('doctor 在无阻塞问题时返回 0', async () => {
    expect(await main(['doctor', '-C', configFile])).toBe(0)
    expect(written).toContain('没有阻塞问题')
  })

  it('history 在仓库不是 Git 工作区时不会静默成功', async () => {
    const plain = await fs.mkdtemp(path.join(path.dirname(fixture.down.root), 'sync-cli-plain-'))
    process.chdir(plain)
    try {
      await expect(main(['status', '-C', configFile])).rejects.toBeInstanceOf(GitError)
      // doctor 把同一件事降级成一条失败检查，这正是它存在的意义。
      expect(await main(['doctor', '-C', configFile])).toBe(1)
      expect(written).toContain('不是可用的 Git 工作区')
    }
    finally {
      // Windows refuses to delete the directory the process is sitting in (EBUSY).
      process.chdir(previousCwd)
      await fs.remove(plain)
    }
  })

  it('拼错的子命令给出可用列表', async () => {
    expect(await main(['statu'])).toBe(2)
    // 只断言子命令列表本身：这句话在两种语言下措辞不同，列表却都来自同一份数组。
    expect(written).toContain('status, why, doctor, history, init, completion')
  })

  it('子命令后面的未知参数仍然会被拒绝', async () => {
    expect(await main(['status', '--nonsense'])).toBe(2)
  })

  it('没有配置文件时只读子命令照样出报告，并把缺的东西说清楚', async () => {
    // 用户第一次进仓库跑的就是这几条：那时还没有配置，报错退出等于把诊断工具锁在门外。
    await fs.remove(configFile)

    expect(await main(['status', '--json'])).toBe(0)
    const status = parseReport()
    expect(status.ok).toBe(true)
    expect(status.warnings.join('\n')).toContain('upstreamRepo')

    written = ''
    expect(await main(['history', '--json'])).toBe(0)
    expect(parseReport().warnings.join('\n')).toContain('syncDirs')

    written = ''
    // doctor 把同一件事当成阻塞项：配置不可用时一次真正的同步必然失败。
    expect(await main(['doctor', '--json'])).toBe(1)
    const report = parseReport()
    expect(report.data.checks.find((check: any) => check.id === 'config').level).toBe('fail')
    expect(report.warnings.join('\n')).toContain('upstreamRepo')

    written = ''
    // --undo 只读状态文件，同样不该被配置拦住；这里没有记录，所以是"没什么可撤销"而不是参数错误。
    expect(await main(['--undo', '--json'])).toBe(1)
    expect(parseReport().warnings.join('\n')).toContain('upstreamRepo')

    written = ''
    // why 是唯一仍然严格的：它的答案就是"这次同步会不会动这个文件"，没有配置就无从回答。
    await expect(main(['why', 'src/config/a.ts'])).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('同步与撤销的命令行闭环', () => {
  it('--json 同步输出单个报告，--undo 撤销它', async () => {
    await fixture.drift()

    const syncCode = await main(['-C', configFile, '-y', '--json'])
    const syncReport = parseReport()
    expect(syncCode).toBe(0)
    expect(syncReport.command).toBe('sync')
    expect(syncReport.data.commit.created).toBe(true)
    expect(syncReport.data.plan.summary).toMatchObject({ add: 1, modify: 2, delete: 1 })

    written = ''
    expect(await main(['-C', configFile, '--undo', '--json'])).toBe(0)
    const undoReport = parseReport()
    expect(undoReport.command).toBe('undo')
    expect(undoReport.data.reverted).toBe(true)
    expect(undoReport.data.target).toBe(syncReport.data.commit.hash)
    expect(await fixture.down.read('src/config/a.ts')).toBe('line one\nline two\nline three\n')
    expect((await fs.readJson(path.join(fixture.down.root, SYNC_STATE_FILE))).history).toEqual([])

    written = ''
    expect(await main(['history', '-C', configFile, '--json'])).toBe(0)
    expect(parseReport().data.records).toEqual([])
  })

  it('--undo 没有记录时返回 1 并说明原因', async () => {
    written = ''
    const code = await main(['-C', configFile, '-uo'])

    expect(code).toBe(1)
    expect(written).toContain('未撤销')
  })
})
