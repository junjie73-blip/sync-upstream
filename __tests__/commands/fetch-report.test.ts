import { doctorCommand } from '../../src/commands/doctor'
import { stripAnsi } from '../../src/commands/output'
import { statusCommand, statusMarkdown } from '../../src/commands/status'
import { lfsAvailable } from '../../src/git/lfs'
import { createSyncFixture } from '../helpers/sync-fixture'

let fixture: Awaited<ReturnType<typeof createSyncFixture>>

beforeEach(async () => {
  fixture = await createSyncFixture()
})

afterEach(async () => {
  await fixture?.cleanup()
})

async function statusOf(overrides: Record<string, unknown> = {}) {
  const out = await statusCommand(fixture.context({ config: fixture.config(overrides) }))
  return { out, text: out.lines.join('\n'), md: statusMarkdown(out.report.data, out.report.warnings) }
}

describe('status 的抓取一行', () => {
  it('完整抓取时不占一行：默认值不值得说', async () => {
    const { text, md } = await statusOf()

    // 快照行自己就写着「抓取于 <时间>」，所以只能认行首的标签，否则这条断言永远为假。
    expect(stripAnsi(text)).not.toMatch(/^抓取\s/m)
    expect(md).not.toMatch(/^- 抓取/m)
  })

  it('blob 过滤写明 git 的实际参数', async () => {
    const { text, md } = await statusOf({ fetchConfig: { filter: 'blob' } })

    expect(text).toContain('部分抓取 blob:none')
    expect(md).toContain('部分抓取 blob:none')
  })

  it('tree 过滤单列，因为它通常更慢', async () => {
    const { text } = await statusOf({ fetchConfig: { filter: 'tree' } })

    expect(text).toContain('tree:0')
  })

  it('浅抓取把深度和"改名识别已关闭"一起写出来', async () => {
    const { text } = await statusOf({ fetchConfig: { depth: 50 } })

    expect(text).toContain('浅抓取 depth=50')
    expect(text).toContain('改名识别已关闭')
  })

  it('带标签与 LFS 策略各占一个词，多项用 · 连接', async () => {
    const { text } = await statusOf({ fetchConfig: { tags: true, lfs: 'materialize' } })

    expect(text).toContain('带标签')
    expect(text).toContain('LFS 取回真实内容')
    expect(text).toContain(' · ')
  })

  it('off 说"不检测"，而不是不提', async () => {
    const { text } = await statusOf({ fetchConfig: { lfs: 'off' } })

    expect(text).toContain('LFS 不检测')
    expect(text).not.toContain('LFS 取回真实内容')
  })

  it('机器输出里 fetch 是结构化字段，缺深度用 null', async () => {
    const { out } = await statusOf({ fetchConfig: { filter: 'blob' } })

    expect(out.report.data.config.fetch).toEqual({ filter: 'blob', depth: null, tags: false, lfs: 'pointer' })
  })
})

describe('doctor 的抓取检查', () => {
  async function doctorOf(overrides: Record<string, unknown> = {}) {
    const out = await doctorCommand(fixture.context({ config: fixture.config(overrides) }))
    const checks = out.report.data.checks.filter(check => ['fetch', 'shallow', 'lfs'].includes(check.id))
    return { out, checks, of: (id: string) => checks.find(check => check.id === id) }
  }

  it('默认配置不产生任何抓取相关的检查', async () => {
    const { checks } = await doctorOf()

    expect(checks).toEqual([])
  })

  it('blob 过滤只是提示，不改退出码', async () => {
    const { of, out } = await doctorOf({ fetchConfig: { filter: 'blob' } })

    expect(of('fetch')?.level).toBe('info')
    expect(of('fetch')?.message).toContain('--filter=blob:none')
    expect(out.report.data.blocking).toBe(0)
  })

  it('tree 过滤给警告并说明代价', async () => {
    const { of } = await doctorOf({ fetchConfig: { filter: 'tree' } })

    expect(of('fetch')?.level).toBe('warn')
    expect(of('fetch')?.hint).toContain('逐个回源取对象')
  })

  it('浅抓取的警告说清代价', async () => {
    const { of } = await doctorOf({ fetchConfig: { depth: 5 } })

    expect(of('fetch')?.level).toBe('warn')
    expect(of('fetch')?.message).toContain('--depth=5')
    expect(of('fetch')?.hint).toContain('关闭改名识别')
    // 仓库本身还没变浅，不该凭空冒出一条 shallow。
    expect(of('shallow')).toBeUndefined()
  })

  it('仓库真的变浅后，doctor 单独报一条并给出补回历史的方法', async () => {
    fixture.down.gitRaw(['fetch', '-q', '--depth=1', 'origin', 'main'])
    expect(await fixture.down.git.isShallow()).toBe(true)

    const { of } = await doctorOf({ fetchConfig: { depth: 5 } })

    expect(of('shallow')?.level).toBe('warn')
    expect(of('shallow')?.message).toContain('depth=5')
    expect(of('shallow')?.hint).toContain('git fetch --unshallow')
  })

  it('materialize 是否可用，取决于本机有没有 git-lfs', async () => {
    const { of } = await doctorOf({ fetchConfig: { lfs: 'materialize' } })
    const installed = await lfsAvailable(fixture.down.root)

    expect(of('lfs')?.level).toBe(installed ? 'pass' : 'warn')
    if (!installed)
      expect(of('lfs')?.hint).toContain('安装 git-lfs')
  })

  it('pointer 是默认策略，不值得单独检查', async () => {
    const { checks } = await doctorOf({ fetchConfig: { lfs: 'pointer' } })

    expect(checks.filter(check => check.id === 'lfs')).toEqual([])
  })
})
