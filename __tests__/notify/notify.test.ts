import type { AddressInfo } from 'node:net'
import type net from 'node:net'
import type { ChangeEntry, NotifyConfig, NotifyEvent, SyncConfig } from '../../src/domain'
import type { SyncRunResult } from '../../src/pipeline/orchestrator'
import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import http from 'node:http'
import { ChangeKind, ConflictType, NotifyChannel } from '../../src/domain'
import { eventFromFailure, eventFromRun, eventFromUndo, formatNotifyResults, notifyEnabled, notifyEvent, renderEvent } from '../../src/notify'

function event(overrides: Partial<NotifyEvent> = {}): NotifyEvent {
  return {
    outcome: 'success',
    upstreamRepo: 'https://git.example.com/org/upstream.git',
    upstreamBranch: 'main',
    companyBranch: 'company/main',
    syncDirs: ['src/config'],
    startedAt: new Date('2026-10-22T02:00:00.000Z').toISOString(),
    durationMs: 4200,
    commit: 'abc1234def',
    applied: 3,
    keptLocal: 1,
    conflicts: 0,
    skipped: 2,
    sample: ['~ src/config/a.ts', '+ src/config/new.ts'],
    cwd: '/repo/down',
    ...overrides,
  }
}

function config(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
  return {
    enable: true,
    channels: [NotifyChannel.HTTP],
    url: 'http://127.0.0.1:1/hooks',
    events: ['success', 'conflict', 'failure', 'undo'],
    timeoutMs: 2000,
    retries: 1,
    ...overrides,
  }
}

/** A run that wrote three files, kept one local, and skipped two. */
function runResult(overrides: Partial<SyncRunResult> = {}): SyncRunResult {
  const entry = (path: string, kind: ChangeKind): ChangeEntry => ({ path, kind, scope: 'src/config', upstreamOid: '1', targetOid: '2' })
  return {
    plan: {
      upstreamRef: 'refs/remotes/sync-upstream/main',
      targetBranch: 'company/main',
      changes: [
        entry('src/config/a.ts', ChangeKind.MODIFY),
        entry('src/config/new.ts', ChangeKind.ADD),
        entry('src/config/old.ts', ChangeKind.DELETE),
        entry('src/config/keep.ts', ChangeKind.MODIFY),
      ],
      conflicts: [],
      skipped: [{ path: 'src/config/x.tmp', reason: 'ignored' }],
      dirty: [],
    },
    decisions: [],
    applied: {
      applied: [
        { entry: entry('src/config/a.ts', ChangeKind.MODIFY), status: 'applied' },
        { entry: entry('src/config/new.ts', ChangeKind.ADD), status: 'applied' },
        { entry: entry('src/config/old.ts', ChangeKind.DELETE), status: 'applied' },
        { entry: entry('src/config/keep.ts', ChangeKind.MODIFY), status: 'kept-target' },
      ],
      stagedPaths: ['src/config/a.ts', 'src/config/new.ts', 'src/config/old.ts'] as never,
    },
    commit: { created: true, hash: 'abc1234def', stagedCount: 3 },
    previewed: false,
    ...overrides,
  } as SyncRunResult
}

const syncConfig = {
  upstreamRepo: 'https://token123@git.example.com/org/upstream.git',
  upstreamBranch: 'main',
  companyBranch: 'company/main',
  syncDirs: ['src/config'],
} as SyncConfig

describe('通知文案', () => {
  it('默认文案带结果、分支、计数与提交', () => {
    const text = renderEvent(event())
    expect(text).toContain('[sync-upstream] 同步成功')
    expect(text).toContain('main → company/main')
    expect(text).toContain('变更 3 个文件 · 保留本地 1 · 冲突 0 · 跳过 2')
    expect(text).toContain('提交: abc1234')
    expect(text).toContain('耗时 4.2s')
    expect(text).toContain('~ src/config/a.ts')
  })

  it('失败文案给出原因，includeDetails=false 时不带文件示例', () => {
    const text = renderEvent(event({ outcome: 'failure', error: '认证失败', commit: undefined }), undefined, false)
    expect(text).toContain('同步失败')
    expect(text).toContain('原因: 认证失败')
    expect(text).not.toContain('示例:')
  })

  it('模板里的占位符逐个替换，未知占位符原样保留', () => {
    const text = renderEvent(event(), '{outcome}|{companyBranch}|{files}|{duration}|{nope}')
    expect(text).toBe('同步成功|company/main|3|4.2s|{nope}')
  })

  it('上游地址里的令牌不会进入文案', () => {
    const text = renderEvent(event({ upstreamRepo: 'https://token123@git.example.com/org/upstream.git' }))
    expect(text).not.toContain('token123')
    expect(text).toContain('***@git.example.com')
  })
})

describe('事件构建', () => {
  it('写入成功 → success，提交号与计数来自本次运行', () => {
    const built = eventFromRun(syncConfig, runResult(), Date.now() - 10)
    expect(built.outcome).toBe('success')
    expect(built.commit).toBe('abc1234def')
    expect(built.applied).toBe(3)
    expect(built.keptLocal).toBe(1)
    expect(built.upstreamRepo).not.toContain('token123')
  })

  it('空计划 → noop，有冲突 → conflict，写入失败 → failure', () => {
    const empty = runResult({ applied: undefined, commit: undefined, plan: { ...runResult().plan, changes: [], skipped: [] } })
    expect(eventFromRun(syncConfig, empty, Date.now()).outcome).toBe('noop')

    const conflicted = runResult({ plan: { ...runResult().plan, conflicts: [{ path: 'src/config/a.ts', conflictType: ConflictType.CONTENT, baseOid: '0', localOid: '2', upstreamOid: '1' }] } })
    expect(eventFromRun(syncConfig, conflicted, Date.now()).outcome).toBe('conflict')

    const failed = runResult({ applied: { applied: [{ entry: { path: 'src/config/a.ts', kind: ChangeKind.MODIFY } as never, status: 'failed', error: '符号链接不可写' }], stagedPaths: [] as never } })
    const built = eventFromRun(syncConfig, failed, Date.now())
    expect(built.outcome).toBe('failure')
    expect(built.error).toContain('符号链接不可写')
  })

  it('预览运行不通知，默认事件列表里没有 noop', () => {
    expect(notifyEnabled(config({ events: [] }), 'noop', false)).toBe(false)
    expect(notifyEnabled(config({ events: [] }), 'success', false)).toBe(true)
    expect(notifyEnabled(config(), 'noop', false)).toBe(false)
    expect(notifyEnabled(config(), 'success', true)).toBe(false)
    expect(notifyEnabled(config(), 'success', false)).toBe(true)
    expect(notifyEnabled(config({ events: ['failure'] }), 'success', false)).toBe(false)
    expect(notifyEnabled(config({ enable: false }), 'failure', false)).toBe(false)
    expect(notifyEnabled(undefined, 'failure', false)).toBe(false)
  })

  it('撤销与异常各自成事件', () => {
    const undone = eventFromUndo(syncConfig, { reverted: true, commit: 'deadbeef', files: 4, branch: 'company/main' }, Date.now() - 5)
    expect(undone.outcome).toBe('undo')
    expect(undone.commit).toBe('deadbeef')
    expect(undone.applied).toBe(4)

    const skipped = eventFromUndo(syncConfig, { reverted: false, files: 0, reason: '最近一次同步的提交已不是 HEAD' }, Date.now())
    expect(skipped.outcome).toBe('noop')
    expect(skipped.error).toContain('HEAD')

    const crashed = eventFromFailure(syncConfig, new Error('网络不可达'), Date.now() - 7)
    expect(crashed.outcome).toBe('failure')
    expect(crashed.error).toBe('网络不可达')
  })
})

describe('通知渠道投递', () => {
  let server: http.Server
  let port = 0
  let received: Array<{ url: string, headers: http.IncomingHttpHeaders, body: string }> = []
  let reply: (res: http.ServerResponse) => void = res => res.end('{"ok":true}')
  let hang = false
  /** A hung handler keeps the socket open, which would keep `server.close()` waiting. */
  const sockets = new Set<net.Socket>()

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.socket)
        sockets.add(req.socket)
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
        if (hang)
          return
        reply(res)
      })
    })
    server.on('connection', socket => sockets.add(socket))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })

  beforeEach(() => {
    received = []
    reply = res => res.end('{"ok":true}')
    hang = false
  })

  afterAll(async () => {
    for (const socket of sockets)
      socket.destroy()
    sockets.clear()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const target = (path = '/hooks') => `http://127.0.0.1:${port}${path}`

  it('http 渠道：JSON 里同时有文案与结构化事件，自定义 header 生效', async () => {
    const results = await notifyEvent(event(), config({ url: target(), headers: { authorization: 'Bearer hint' } }))
    expect(results).toEqual([{ channel: NotifyChannel.HTTP, ok: true, status: 200, attempts: 1 }])
    const body = JSON.parse(received[0]!.body)
    expect(body.text).toContain('同步成功')
    expect(body.event.commit).toBe('abc1234def')
    expect(received[0]!.headers.authorization).toBe('Bearer hint')
    expect(received[0]!.headers['content-type']).toContain('application/json')
  })

  it('slack / 钉钉 / 企业微信各自的请求体形状', async () => {
    await notifyEvent(event({ outcome: 'failure', error: '推送被拒' }), config({ url: undefined, channels: [NotifyChannel.SLACK], slackUrl: target('/slack') }))
    expect(JSON.parse(received[0]!.body)).toEqual({ text: expect.stringContaining('推送被拒') })
    expect(received[0]!.url).toBe('/slack')

    await notifyEvent(event(), config({ url: undefined, channels: [NotifyChannel.DINGTALK], dingtalkUrl: target('/ding') }))
    const ding = JSON.parse(received[1]!.body)
    expect(ding.msgtype).toBe('text')
    expect(ding.text.content).toContain('同步成功')

    await notifyEvent(event(), config({ url: undefined, channels: [NotifyChannel.WECOM], wecomUrl: target('/wecom') }))
    expect(JSON.parse(received[2]!.body).text.content).toContain('company/main')
  })

  it('钉钉加签：URL 带上时间戳与 HMAC 签名', async () => {
    const secret = 'SEC-test-secret'
    await notifyEvent(event(), config({ url: undefined, channels: [NotifyChannel.DINGTALK], dingtalkUrl: target('/ding'), dingtalkSecret: secret }))
    const url = new URL(`http://x${received[0]!.url}`)
    const timestamp = url.searchParams.get('timestamp')!
    const sign = url.searchParams.get('sign')!
    expect(Number(timestamp)).toBeGreaterThan(1_600_000_000_000)
    expect(sign).toBe(crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'))
  })

  it('HTTP 200 里的 errcode 非零算失败', async () => {
    reply = res => res.end('{"errcode":310000,"errmsg":"keywords not in content"}')
    const [result] = await notifyEvent(event(), config({ url: target(), channels: [NotifyChannel.DINGTALK], dingtalkUrl: target() }))
    expect(result.ok).toBe(false)
    expect(result.status).toBe(200)
    expect(result.detail).toContain('310000')
    expect(result.detail).toContain('keywords not in content')
  })

  it('非 2xx 与投递异常都会重试到上限并报出次数', async () => {
    reply = (res) => {
      res.statusCode = 500
      res.end('boom')
    }
    const [failed] = await notifyEvent(event(), config({ url: target(), retries: 2 }))
    expect(failed.ok).toBe(false)
    expect(failed.status).toBe(500)
    expect(failed.attempts).toBe(2)
    expect(received).toHaveLength(2)
    expect(formatNotifyResults([failed])).toEqual([expect.stringContaining('已重试 2 次')])

    const [refused] = await notifyEvent(event(), config({ url: 'http://127.0.0.1:1/nope', retries: 1 }))
    expect(refused.ok).toBe(false)
    expect(refused.detail).toBeTruthy()
  })

  it('端点不回包时按 timeoutMs 放手，不会拖住进程', async () => {
    hang = true
    const started = Date.now()
    const [result] = await notifyEvent(event(), config({ url: target('/slow'), timeoutMs: 600 }))
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/abort|timeout/i)
    expect(Date.now() - started).toBeLessThan(5000)
    // The client aborted, so undici already dropped its half; the server-side socket is
    // released in `afterAll`, where destroying it cannot disturb the pooled connections of
    // the tests that follow.
  })

  it('没有 URL 的渠道直接跳过，stdout 渠道永远可用', async () => {
    const [missing] = await notifyEvent(event(), config({ url: undefined }))
    expect(missing).toEqual({ channel: NotifyChannel.HTTP, ok: false, detail: '未配置该渠道的 URL', attempts: 0 })

    const [plain] = await notifyEvent(event(), config({ url: undefined, channels: [NotifyChannel.SLACK] }))
    expect(plain.detail).toBe('未配置该渠道的 URL')

    const notHttp = await notifyEvent(event(), config({ url: 'git@example.com:not-http' }))
    expect(notHttp[0]!.detail).toContain('不是 http')

    const stdout = await notifyEvent(event(), config({ channels: [NotifyChannel.STDOUT] }))
    expect(stdout[0]!.ok).toBe(true)
    expect(formatNotifyResults(stdout)[0]).toContain('已投递')
  })

  it('未启用时一个包也不发；多渠道并行且互不拖累', async () => {
    expect(await notifyEvent(event(), config({ enable: false }))).toEqual([])
    expect(await notifyEvent(event(), undefined)).toEqual([])
    expect(received).toHaveLength(0)

    reply = res => res.end('{}')
    const results = await notifyEvent(event(), config({ url: target(), slackUrl: target('/slack'), channels: [NotifyChannel.SLACK, NotifyChannel.HTTP] }))
    expect(results).toHaveLength(2)
    expect(results.every(result => result.ok)).toBe(true)
    expect(received).toHaveLength(2)
  })
})
