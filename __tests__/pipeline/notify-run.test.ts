import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import httpServer from 'node:http'
import { runSync, undoSync } from '../../src/sync'
import { createSyncFixture } from '../helpers/sync-fixture'

/**
 * The wiring, not the payload: `notify` is attached to the run itself so the CLI and the
 * webhook daemon behave the same. Payload shape is covered in `notify/notify.test.ts`.
 */
describe('同步结束后的通知投递', () => {
  let server: Server
  let port = 0
  let posts: Array<{ body: string, headers: IncomingHttpHeaders }> = []
  let fixture: Awaited<ReturnType<typeof createSyncFixture>>

  beforeAll(async () => {
    server = httpServer.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        posts.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers })
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })

  beforeEach(async () => {
    posts = []
    fixture = await createSyncFixture()
    await fixture.drift()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  afterAll(async () => {
    server.close()
    await once(server, 'close')
  })

  const notifyConfig = (extra: Record<string, unknown> = {}) => ({
    enable: true,
    channels: ['http'],
    url: `http://127.0.0.1:${port}/hook`,
    ...extra,
  })

  it('真实同步后投递一次，正文带上提交号与文件数', async () => {
    const config = fixture.config({ notifyConfig: notifyConfig() })
    const result = await runSync({ config, cwd: fixture.down.root })

    expect(result.commit?.created).toBe(true)
    expect(posts).toHaveLength(1)
    const payload = JSON.parse(posts[0]!.body)
    expect(payload.event.outcome).toBe('success')
    expect(payload.event.commit).toBe(result.commit?.hash)
    expect(payload.event.applied).toBe(4)
    expect(payload.text).toContain('同步成功')
    expect(payload.text).toContain('src/config')
  })

  it('预览运行不投递，守护进程自带的重试循环也不会重复投递', async () => {
    const preview = fixture.config({ notifyConfig: notifyConfig(), previewOnly: true })
    const result = await runSync({ config: preview, cwd: fixture.down.root })
    expect(result.previewed).toBe(true)
    expect(posts).toEqual([])

    const config = fixture.config({ notifyConfig: notifyConfig() })
    await runSync({ config, cwd: fixture.down.root, notify: false })
    expect(posts).toEqual([])
  })

  it('撤销同步同样播报', async () => {
    const config = fixture.config({ notifyConfig: notifyConfig() })
    await runSync({ config, cwd: fixture.down.root })
    posts = []

    const undone = await undoSync({ config, cwd: fixture.down.root })
    expect(undone.reverted).toBe(true)
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0]!.body).event.outcome).toBe('undo')
  })

  it('第二次同步没有可做的变更时保持安静', async () => {
    const config = fixture.config({ notifyConfig: notifyConfig() })
    await runSync({ config, cwd: fixture.down.root })
    expect(posts).toHaveLength(1)

    posts = []
    const again = await runSync({ config, cwd: fixture.down.root })
    expect(again.plan.changes).toHaveLength(0)
    expect(posts).toEqual([])
  })

  it('同步抛错时播报失败，并且不吞掉原始异常', async () => {
    const config = fixture.config({ notifyConfig: notifyConfig(), companyBranch: 'no-such-branch' })
    await expect(runSync({ config, cwd: fixture.down.root })).rejects.toThrow()

    expect(posts).toHaveLength(1)
    const payload = JSON.parse(posts[0]!.body)
    expect(payload.event.outcome).toBe('failure')
    expect(payload.event.error).toBeTruthy()
  })

  it('投递失败不会改变同步结果，也不会拖住命令', async () => {
    const config = fixture.config({ notifyConfig: { enable: true, channels: ['http'], url: 'http://127.0.0.1:1/refused', timeoutMs: 500, retries: 1 } })
    const result = await runSync({ config, cwd: fixture.down.root })
    expect(result.commit?.created).toBe(true)
    expect(posts).toEqual([])
  })
})
