import type { CommandOutput, DoctorCheck, DoctorReport } from '../../src/commands/types'
import net from 'node:net'
import path from 'node:path'
import fs from 'fs-extra'
import { doctorCommand, doctorMarkdown } from '../../src/commands/doctor'
import { resolveConfig } from '../../src/config/resolve'
import { REPO_LOCK_FILE, repoLockPath } from '../../src/pipeline/repo-lock'
import { SYNC_STATE_FILE } from '../../src/pipeline/sync-state'
import { DeliveryLog } from '../../src/webhook/delivery-log'
import { createSyncFixture } from '../helpers/sync-fixture'

let fixture: Awaited<ReturnType<typeof createSyncFixture>>

beforeEach(async () => {
  fixture = await createSyncFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

async function run(overrides: Record<string, unknown> = {}): Promise<CommandOutput<DoctorReport>> {
  return doctorCommand(fixture.context({ config: fixture.config(overrides) }))
}

function checkOf(output: CommandOutput<DoctorReport>, id: string): DoctorCheck[] {
  return output.report.data.checks.filter(check => check.id === id)
}

function levelOf(output: CommandOutput<DoctorReport>, id: string): string | undefined {
  return checkOf(output, id)[0]?.level
}

describe('doctor 子命令', () => {
  it('健康环境没有阻塞项，退出码 0', async () => {
    const out = await run()

    expect(out.report.data.checks.some(check => check.level === 'fail')).toBe(false)
    expect(out.report.data.blocking).toBe(0)
    expect(out.report.ok).toBe(true)
    expect(out.report.exitCode).toBe(0)
    expect(levelOf(out, 'git')).toBe('pass')
    expect(levelOf(out, 'target-branch')).toBe('pass')
    expect(levelOf(out, 'sync-dir')).toBe('pass')
    expect(levelOf(out, 'repo-lock')).toBe('pass')
    expect(levelOf(out, 'working-tree')).toBe('pass')
    expect(out.lines.join('\n')).toContain('没有阻塞问题')
  })

  it('目标分支缺失是阻塞项', async () => {
    const out = await run({ companyBranch: 'no-such-branch' })

    expect(levelOf(out, 'target-branch')).toBe('fail')
    expect(checkOf(out, 'target-branch')[0]?.message).toContain('no-such-branch')
    expect(out.report.data.blocking).toBeGreaterThan(0)
    expect(out.report.exitCode).toBe(1)
    expect(out.lines.join('\n')).toContain('有阻塞问题')
  })

  it('同步目录在两边都不存在时给出警告', async () => {
    const out = await run({ syncDirs: ['src/nowhere'] })

    expect(levelOf(out, 'sync-dir')).toBe('warn')
    expect(checkOf(out, 'sync-dir')[0]?.message).toContain('src/nowhere')
  })

  it('状态文件损坏是阻塞项，身份不匹配只是警告', async () => {
    await fs.writeFile(path.join(fixture.down.root, SYNC_STATE_FILE), '{ broken', 'utf8')
    const broken = await run()
    expect(levelOf(broken, 'state-file')).toBe('fail')
    expect(broken.report.data.blocking).toBeGreaterThan(0)

    await fs.writeJson(path.join(fixture.down.root, SYNC_STATE_FILE), {
      version: 2,
      upstreamRepo: fixture.up.root,
      upstreamBranch: 'main',
      companyBranch: 'other',
      entries: {},
      history: [],
    })
    const mismatch = await run()
    expect(levelOf(mismatch, 'state-file')).toBe('warn')
    expect(checkOf(mismatch, 'state-file')[0]?.hint).toContain('全量比对')
  })

  it('状态文件未被 .gitignore 忽略时提醒一次', async () => {
    await fs.writeJson(path.join(fixture.down.root, SYNC_STATE_FILE), {
      version: 2,
      upstreamRepo: fixture.up.root,
      upstreamBranch: 'main',
      companyBranch: 'company',
      entries: {},
      history: [],
    })

    const before = await run()
    expect(levelOf(before, 'state-ignore')).toBe('warn')

    await fs.writeFile(path.join(fixture.down.root, '.gitignore'), `${SYNC_STATE_FILE}\n`, 'utf8')
    const after = await run()
    expect(checkOf(after, 'state-ignore')).toEqual([])
  })

  it('锁的持有者活着就阻塞，失活只是警告', async () => {
    const gitDir = await fixture.down.git.gitDirectory()
    const file = repoLockPath(gitDir)

    await fs.outputFile(file, JSON.stringify({ pid: process.pid, token: 'other', label: '并行的流水线', createdAt: Date.now() }))
    const held = await run()
    expect(levelOf(held, 'repo-lock')).toBe('fail')
    expect(checkOf(held, 'repo-lock')[0]?.message).toContain('并行的流水线')

    await fs.outputFile(file, JSON.stringify({ pid: process.pid, token: 'other', label: '崩溃的进程', createdAt: Date.now() - 60 * 60 * 1000 }))
    const stale = await run()
    expect(levelOf(stale, 'repo-lock')).toBe('warn')
    expect(checkOf(stale, 'repo-lock')[0]?.hint).toContain(REPO_LOCK_FILE)

    await fs.remove(file)
    expect(levelOf(await run(), 'repo-lock')).toBe('pass')
  })

  it('缺失的认证参数与不存在的 SSH 密钥都算失败', async () => {
    const pat = await run({ authConfig: { type: 'pat' } })
    expect(levelOf(pat, 'auth')).toBe('fail')

    // `sshCommand` refuses to build the git environment for a missing key; doctor has to report
    // that as a credential problem instead of crashing on the way to the repository checks.
    const ssh = await run({ authConfig: { type: 'ssh', privateKeyPath: 'missing-key' } })
    expect(levelOf(ssh, 'auth')).toBe('fail')
    expect(checkOf(ssh, 'auth')[0]?.message).toContain('missing-key')
    expect(ssh.lines.join('\n')).toContain('sync-upstream doctor')

    await fs.writeFile(path.join(fixture.down.root, 'id_ed25519'), 'dummy\n', 'utf8')
    const good = await run({ authConfig: { type: 'ssh', privateKeyPath: 'id_ed25519' } })
    expect(levelOf(good, 'auth')).toBe('pass')
    expect(good.report.data.checks.filter(check => check.level === 'fail')).toEqual([])
  })

  it('webhook：端口被占、短密钥、对外裸奔各自报出来', async () => {
    const holder = net.createServer()
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject)
      holder.listen(0, '127.0.0.1', () => resolve())
    })
    const busy = (holder.address() as net.AddressInfo).port
    const base = { enable: true, path: '/hooks/sync', host: '127.0.0.1' }

    try {
      const taken = await run({ webhookConfig: { ...base, port: busy, secret: 'x'.repeat(32) } })
      expect(levelOf(taken, 'webhook-port')).toBe('fail')
      expect(taken.report.data.blocking).toBeGreaterThan(0)

      const exposed = await run({ webhookConfig: { ...base, port: busy + 1, secret: 'short', host: '0.0.0.0' } })
      expect(levelOf(exposed, 'webhook-port')).toBe('pass')
      expect(levelOf(exposed, 'webhook-secret')).toBe('warn')
      expect(levelOf(exposed, 'webhook-tls')).toBe('warn')
      expect(levelOf(exposed, 'webhook-allowlist')).toBe('warn')

      const missing = await run({ webhookConfig: { ...base, port: busy + 2, secret: 'x'.repeat(32), tlsCert: 'no.pem', tlsKey: 'no-key.pem' } })
      expect(checkOf(missing, 'webhook-tls')).toHaveLength(2)
      expect(checkOf(missing, 'webhook-tls').every(check => check.level === 'fail')).toBe(true)

      const behind = await run({ webhookConfig: { ...base, port: busy + 3, secret: 'x'.repeat(32), trustProxy: true } })
      expect(levelOf(behind, 'webhook-proxy')).toBe('info')
      expect(levelOf(behind, 'webhook-tls')).toBeUndefined()
    }
    finally {
      await new Promise<void>(resolve => holder.close(() => resolve()))
    }
  }, 180_000)

  it('日志落盘：能写就报清位置与轮转，写不进去算阻塞项', async () => {
    const logConfig = { file: 'logs/sync.log', maxBytes: 4096, keep: 2 }

    const fresh = await run({ logConfig })
    expect(levelOf(fresh, 'log-file')).toBe('info')
    // 报的是解析后的绝对路径：相对 cwd 的写法在 `--config` 指到别处时根本对不上。
    expect(checkOf(fresh, 'log-file')[0]?.message).toContain(path.resolve(fixture.down.root, 'logs/sync.log'))
    expect(checkOf(fresh, 'log-file')[0]?.message).toContain('保留 2 份')

    await fs.outputFile(path.join(fixture.down.root, 'logs/sync.log'), 'x'.repeat(5000), 'utf8')
    const oversized = await run({ logConfig })
    expect(levelOf(oversized, 'log-file')).toBe('warn')
    expect(checkOf(oversized, 'log-file')[0]?.hint).toContain('轮转')

    // 目录位置被一个普通文件占着：append 只会失败，而写不进去的日志等于没有日志。
    await fs.writeFile(path.join(fixture.down.root, 'blocker'), '占位\n', 'utf8')
    const broken = await run({ logConfig: { ...logConfig, file: 'blocker/deep/sync.log' } })
    expect(levelOf(broken, 'log-file')).toBe('fail')
    expect(checkOf(broken, 'log-file')[0]?.message).toContain('不可写')
    expect(broken.report.data.blocking).toBeGreaterThan(0)
  })

  it('投递审计与同步队列各自成一条检查', async () => {
    const base = { enable: true, port: 0, path: '/webhook', host: '127.0.0.1', secret: 'x'.repeat(32) }

    const noAudit = await run({ webhookConfig: base })
    expect(levelOf(noAudit, 'webhook-log')).toBe('warn')
    expect(levelOf(noAudit, 'webhook-queue')).toBe('info')
    expect(checkOf(noAudit, 'webhook-queue')[0]?.message).toContain('上限 8')

    const webhookConfig = { ...base, deliveryLog: 'logs/hooks.jsonl', maxQueue: 2 }
    const empty = await run({ webhookConfig })
    expect(levelOf(empty, 'webhook-log')).toBe('info')
    expect(checkOf(empty, 'webhook-log')[0]?.message).toContain('还没有记录')
    expect(checkOf(empty, 'webhook-queue')[0]?.message).toContain('上限 2')

    // 有记录时直接把最近一条的决定读出来，运维不必自己 cat 这个文件。
    const audit = new DeliveryLog(path.join(fixture.down.root, 'logs/hooks.jsonl'))
    audit.record({ platform: 'github', event: 'push', branch: 'dev', decision: 'ignored', reason: '非触发分支: dev', status: 200, ip: '127.0.0.1' })
    audit.record({ platform: 'github', event: 'push', branch: 'main', decision: 'accepted', status: 202, ip: '127.0.0.1' })
    const used = await run({ webhookConfig })
    expect(levelOf(used, 'webhook-log')).toBe('pass')
    expect(checkOf(used, 'webhook-log')[0]?.message).toContain('已有 2 条')
    expect(checkOf(used, 'webhook-log')[0]?.message).toContain('accepted')

    // 审计写到一半发现路径被文件挡住：这一条同样要算阻塞，daemon 起来才会当场崩。
    await fs.writeFile(path.join(fixture.down.root, 'blocker'), '占位\n', 'utf8')
    const blocked = await run({ webhookConfig: { ...webhookConfig, deliveryLog: 'blocker/hooks.jsonl' } })
    expect(levelOf(blocked, 'webhook-log')).toBe('fail')
    expect(blocked.report.data.blocking).toBeGreaterThan(0)
  })

  it('本地改动与暂存区都会被点名', async () => {
    await fixture.down.write('src/config/a.ts', 'dirty\n')
    await fixture.down.gitRaw(['add', '--', 'src/config/a.ts'])

    const out = await run()

    expect(checkOf(out, 'working-tree').map(check => check.level)).toEqual(['warn'])
    expect(levelOf(out, 'index')).toBe('warn')
    expect(checkOf(out, 'index')[0]?.message).toContain('1')
  })

  it('summary 只表格化非通过项', async () => {
    const broken = await run({ companyBranch: 'no-such-branch' })
    const table = doctorMarkdown(broken.report.data)
    expect(table).toContain('| 级别 | 检查项 | 说明 |')
    expect(table).toContain('`target-branch`')
    expect(table).not.toContain('`working-tree`')
    // 通过项不进表格，info/warn 都要能被 CI 看见。
    expect(table).not.toContain('`git`')
  })

  it('全部通过时 summary 只有一句话', () => {
    const allPass: DoctorReport = {
      repo: null,
      checks: [
        { id: 'git', level: 'pass', message: 'git 2.45.0' },
        { id: 'node', level: 'pass', message: 'Node v20' },
      ],
      counts: { pass: 2, warn: 0, fail: 0, info: 0 },
      blocking: 0,
    }
    expect(doctorMarkdown(allPass)).toBe('### sync-upstream doctor\n\n所有 2 项检查通过。')
  })

  it('summary 里的竖线被转义，不破坏表格', () => {
    const report: DoctorReport = {
      repo: null,
      checks: [{ id: 'x', level: 'warn', message: 'a | b', hint: 'c | d' }],
      counts: { pass: 0, warn: 1, fail: 0, info: 0 },
      blocking: 0,
    }
    expect(doctorMarkdown(report)).toContain('a \\| b · c \\| d')
  })

  it('非 Git 目录不会让 doctor 崩掉', async () => {
    const plain = await fs.mkdtemp(path.join(path.dirname(fixture.down.root), 'sync-doctor-plain-'))
    try {
      const out = await doctorCommand(fixture.context({ cwd: plain }))
      expect(levelOf(out, 'worktree')).toBe('fail')
      expect(out.report.data.repo).toBeNull()
      expect(out.report.exitCode).toBe(1)
    }
    finally {
      await fs.remove(plain)
    }
  })

  it('配置尚不可用是阻塞项，而不是被跳过', async () => {
    // 这正是 doctor 存在的意义：新克隆的仓库里还没有配置文件，体检必须说得出"缺了什么"。
    const { config, problems } = resolveConfig(
      { upstreamBranch: 'main', companyBranch: 'company' },
      { lenient: true },
    )
    expect(problems.length).toBeGreaterThan(0)

    const out = await doctorCommand(fixture.context({ config, configProblems: problems }))

    expect(levelOf(out, 'config')).toBe('fail')
    expect(checkOf(out, 'config')[0]?.message).toContain('upstreamRepo')
    expect(out.report.data.blocking).toBeGreaterThan(0)
    expect(out.report.exitCode).toBe(1)
  })

  it('配置合法时 config 检查不会被 problems 影响', async () => {
    const out = await doctorCommand(fixture.context({ configProblems: [] }))
    expect(levelOf(out, 'config')).toBe('pass')
  })
})
