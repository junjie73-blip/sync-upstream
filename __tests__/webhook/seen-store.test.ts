import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { SeenStore } from '../../src/webhook/seen-store'

let dir: string
let counter = 0

function statePath(name: string): string {
  counter += 1
  return path.join(dir, `${counter}-${name}`)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-seen-'))
})

afterEach(async () => {
  await fs.remove(dir)
})

describe('SeenStore.mark', () => {
  it('同一个投递号第二次遇到才说是重复', () => {
    const seen = new SeenStore()

    expect(seen.mark('8a2c1f0e-0000-4000-8000-000000000001')).toBe(false)
    expect(seen.mark('8a2c1f0e-0000-4000-8000-000000000001')).toBe(true)
    expect(seen.size).toBe(1)
  })

  it('超出上限时挤掉最旧的，最新的仍在', () => {
    const seen = new SeenStore(2)

    seen.mark('a')
    seen.mark('b')
    seen.mark('c')

    expect(seen.size).toBe(2)
    // 挤掉的是最早那条：它已经没有价值了，而刚处理完的投递最可能收到重发。
    expect(seen.mark('a')).toBe(false)
    expect(seen.mark('c')).toBe(true)
  })

  it('limit 为 1 时只认最新那一条，更早的一律当新投递', () => {
    const seen = new SeenStore(1)

    expect(seen.mark('a')).toBe(false)
    expect(seen.mark('b')).toBe(false)
    expect(seen.mark('b')).toBe(true)
    expect(seen.mark('a')).toBe(false)
  })

  it('不给文件就只在进程内记忆，不碰磁盘', () => {
    const seen = new SeenStore(2)

    seen.mark('a')

    expect(fs.readdirSync(dir)).toEqual([])
    expect(seen.lastError).toBeUndefined()
  })
})

describe('SeenStore 的状态文件', () => {
  it('重启后仍认得处理过的投递号，这是内存集合做不到的那部分', () => {
    const file = statePath('seen.json')

    const before = new SeenStore(8, file)
    before.mark('delivery-before-restart')

    const after = new SeenStore(8, file)
    expect(after.size).toBe(1)
    expect(after.mark('delivery-before-restart')).toBe(true)
  })

  it('写出来的就是 ids 数组，顺序按插入时间', () => {
    const file = statePath('seen.json')
    const seen = new SeenStore(8, file)
    seen.mark('first')
    seen.mark('second')

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ids: ['first', 'second'] })
  })

  it('状态文件比新上限还长时只保留最近的那几条', () => {
    const file = statePath('seen.json')
    fs.writeFileSync(file, JSON.stringify({ ids: ['a', 'b', 'c', 'd', 'e'] }), 'utf8')

    const seen = new SeenStore(2, file)
    expect(seen.size).toBe(2)
    expect(seen.mark('e')).toBe(true)
    expect(seen.mark('a')).toBe(false)
  })

  it('状态文件坏了就当什么都没记住，不能因为去重表起不来而拒绝启动', () => {
    const file = statePath('seen.json')
    fs.writeFileSync(file, '{"ids": [ 截断', 'utf8')

    const seen = new SeenStore(4, file)

    expect(seen.size).toBe(0)
    expect(seen.mark('first-after-corrupt')).toBe(false)
    // 下一次写入把坏文件覆盖掉，进程继续正常记忆。
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).ids).toEqual(['first-after-corrupt'])
  })

  it('顶层不是对象或 ids 不是数组时同样按空表接手', () => {
    const file = statePath('seen.json')
    fs.writeFileSync(file, '[1,2,3]', 'utf8')

    expect(new SeenStore(4, file).size).toBe(0)
  })

  it('目录不存在也会先建出来', () => {
    const file = statePath(path.join('.sync-upstream', 'seen.json'))

    new SeenStore(4, file).mark('x')

    expect(fs.existsSync(file)).toBe(true)
  })

  it('写不进去时记着错误交调用方报一次，内存去重照旧生效', () => {
    const blocker = statePath('blocker')
    fs.writeFileSync(blocker, '不是目录', 'utf8')
    const seen = new SeenStore(4, path.join(blocker, 'seen.json'))

    expect(seen.mark('a')).toBe(false)
    expect(seen.mark('a')).toBe(true)
    expect(seen.lastError).toContain('写入投递去重状态')
  })

  it('写成功后错误会被清掉，不会一直挂着上一条的旧账', () => {
    const file = statePath('seen.json')
    const seen = new SeenStore(4, file)

    seen.mark('a')
    expect(seen.lastError).toBeUndefined()
  })
})
