import type { Fixture } from '../helpers/repo'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { detectLfsPointers, isLfsPointer, lfsAvailable, lfsCacheHint, lfsIncludePatterns, materializeLfsPointers, scanWorkingTreePointers } from '../../src/git/lfs'
import { createFixture } from '../helpers/repo'

const HEX = '0123456789abcdef'.repeat(4)
/** 逐字节照抄 git-lfs 写出来的指针：三行、LF 结尾。 */
function pointer(size = 7): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${HEX}\nsize ${size}\n`
}

describe('指针识别', () => {
  it('认标准指针，带尾换行和不带都行', () => {
    expect(isLfsPointer(pointer())).toBe(true)
    expect(isLfsPointer(pointer().trimEnd())).toBe(true)
    expect(isLfsPointer(`${pointer()}extra\n`)).toBe(false)
  })

  it('只有一行 version 不算指针：那只是一个恰好这么开头的文本文件', () => {
    expect(isLfsPointer('version https://git-lfs.github.com/spec/v1\n')).toBe(false)
    expect(isLfsPointer('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n')).toBe(false)
    expect(isLfsPointer('version https://git-lfs.github.com/spec/v1\noid md5:0123456789abcdef0123456789abcdef\nsize 1\n')).toBe(false)
  })

  it('字段名和空格的容错只到 git-lfs 自己的写法为止', () => {
    expect(isLfsPointer(pointer().replace('size 7', 'size   7'))).toBe(true)
    expect(isLfsPointer(pointer().replace('size 7', 'bytes 7'))).toBe(false)
    expect(isLfsPointer(pointer().replace('sha256:', 'sha256:'))).toBe(true)
  })

  it('大文件再像指针也不打开判断：指针不可能超过 256 字节', () => {
    const big = `${pointer()}${'x'.repeat(300)}`
    expect(isLfsPointer(big)).toBe(false)
  })

  it('真实内容与二进制内容都不是指针', () => {
    expect(isLfsPointer('export const a = 1\n')).toBe(false)
    expect(isLfsPointer('\u0000\u0001\u0002')).toBe(false)
    expect(isLfsPointer('')).toBe(false)
  })
})

describe('detectLfsPointers', () => {
  it('按调用方给的读取器分流：指针、普通文件、读不到的文件各有各的账', async () => {
    const contents: Record<string, string | null> = {
      'src/a.png': pointer(),
      'src/b.ts': 'export const b = 1\n',
      'src/gone.png': null,
    }
    const scan = await detectLfsPointers(Object.keys(contents), async p => contents[p])

    expect(scan.pointers).toEqual(['src/a.png'])
    expect(scan.unreadable).toEqual(['src/gone.png'])
  })

  it('读取器抛异常时归入 unreadable，而不是让整轮同步失败', async () => {
    const scan = await detectLfsPointers(['x.png'], async () => {
      throw new Error('对象不在本地')
    })

    expect(scan.pointers).toEqual([])
    expect(scan.unreadable).toEqual(['x.png'])
  })

  it('空列表不调用读取器', async () => {
    const read = jest.fn(async () => pointer())
    expect(await detectLfsPointers([], read)).toEqual({ pointers: [], unreadable: [] })
    expect(read).not.toHaveBeenCalled()
  })
})

describe('scanWorkingTreePointers', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createFixture('main')
    await fixture.write('src/asset.png', pointer(7))
    await fixture.write('src/code.ts', 'export const a = 1\n')
    await fixture.write('src/big.bin', `${'x'.repeat(400)}`)
    await fixture.commitAll('mixed content')
  })

  afterEach(async () => {
    await fixture?.cleanup()
  })

  it('工作区里指针对普通文件一目了然，超长的文件根本不会被打开', async () => {
    const scan = await scanWorkingTreePointers(fixture.root, ['src/asset.png', 'src/code.ts', 'src/big.bin', 'src/missing.png'])

    expect(scan.pointers).toEqual(['src/asset.png'])
    expect(scan.unreadable).toEqual(['src/missing.png'])
  })

  it('路径按仓库根解析，嵌套目录里的指针同样能找到', async () => {
    await fixture.write('deep/nested/x/y.png', pointer(1))
    const scan = await scanWorkingTreePointers(fixture.root, ['deep/nested/x/y.png'])

    expect(scan.pointers).toEqual(['deep/nested/x/y.png'])
  })

  it('空列表返回空结果，不去 stat 任何东西', async () => {
    expect(await scanWorkingTreePointers(fixture.root, [])).toEqual({ pointers: [], unreadable: [] })
  })
})

describe('取回真实内容的对外契约', () => {
  it('include 模式就是逗号分隔的路径', () => {
    expect(lfsIncludePatterns(['a.png', 'b/c.png'])).toBe('a.png,b/c.png')
    expect(lfsIncludePatterns([])).toBe('')
  })

  it('缓存位置给出可点开的路径', () => {
    expect(lfsCacheHint('/repo')).toBe(path.join('/repo', '.git', 'lfs'))
  })

  it('没有指针时不去碰 git-lfs，attempted 为 false', async () => {
    const outcome = await materializeLfsPointers({ cwd: process.cwd(), remote: 'origin', ref: 'refs/heads/main', paths: [] })

    expect(outcome).toEqual({ attempted: false, replaced: [] })
  })

  it('上游没有 LFS 服务时带一句原因回来，而不是谎报取回成功', async () => {
    const fixture = await createFixture('main')
    try {
      await fixture.write('src/asset.png', pointer())
      await fixture.commitAll('pointer only')
      // 真实场景里的"上游"就是一个普通 git 远程，后面挂了个不存在的 LFS 服务。
      await fixture.git.ensureRemote('up', fixture.root)

      // 装了 git-lfs 的机器：拿不到 batch 服务，note 说原因。
      // 没装的机器：note 说本机没有 git-lfs。两种情况下同步都不该被打断。
      const outcome = await materializeLfsPointers({
        cwd: fixture.root,
        remote: 'up',
        ref: 'refs/heads/main',
        paths: ['src/asset.png'],
        timeoutMs: 30_000,
      })

      expect(outcome.attempted).toBe(true)
      // 这台机器上不可能有真实对象（远程没有 LFS 服务），所以只有一条路：0 个取回 + 一句原因。
      expect(outcome.replaced).toEqual([])
      expect(outcome.note).toBeTruthy()

      // 退出码不算数：文件仍是指针，就绝不能报"已取回"。
      const stillPointer = isLfsPointer(await fixture.read('src/asset.png'))
      expect(outcome.replaced.includes('src/asset.png')).toBe(!stillPointer)
      // 无论取回成不成功，指针文本都还在工作区里：它是合法的 git 内容。
      expect(await fixture.read('src/asset.png')).toBe(pointer())
    }
    finally {
      await fixture.cleanup()
    }
  })

  it('lfsAvailable 与本机 git lfs version 的成败一致', async () => {
    const fixture = await createFixture('main')
    try {
      let installed = true
      try {
        execFileSync('git', ['lfs', 'version'], { cwd: fixture.root, stdio: 'ignore' })
      }
      catch {
        installed = false
      }

      expect(await lfsAvailable(fixture.root)).toBe(installed)
    }
    finally {
      await fixture.cleanup()
    }
  })
})
