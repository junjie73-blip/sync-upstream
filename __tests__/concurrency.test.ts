import { createLimit, mapLimited } from '../src/concurrency'

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createLimit', () => {
  it('并发数被限制在给定值内', async () => {
    const limit = createLimit(2)
    let running = 0
    let peak = 0
    const gates = Array.from({ length: 6 }, () => deferred<number>())

    const tasks = gates.map((gate, index) => limit(async () => {
      running++
      peak = Math.max(peak, running)
      await gate.promise
      running--
      return index
    }))

    await Promise.resolve()
    expect(peak).toBe(2)

    for (const gate of gates)
      gate.resolve(1)

    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4, 5])
    expect(peak).toBe(2)
  })

  it('按 FIFO 顺序放行，不会饿死后面的任务', async () => {
    const limit = createLimit(1)
    const order: string[] = []
    const first = deferred<void>()

    const a = limit(async () => {
      order.push('a')
      await first.promise
      order.push('a-done')
    })
    const b = limit(async () => {
      order.push('b')
    })
    const c = limit(async () => {
      order.push('c')
    })

    await Promise.resolve()
    first.resolve()
    await Promise.all([a, b, c])
    expect(order).toEqual(['a', 'a-done', 'b', 'c'])
  })

  it('单个任务失败不影响队列继续，也不吞掉其他任务的结果', async () => {
    const limit = createLimit(1)
    const boom = limit(async () => {
      throw new Error('boom')
    })
    const ok = limit(async () => 'kept going')

    await expect(boom).rejects.toThrow('boom')
    await expect(ok).resolves.toBe('kept going')
  })

  it('并发数下限为 1，非法值不会产生死锁', async () => {
    for (const concurrency of [0, -3, Number.NaN]) {
      const limit = createLimit(concurrency)
      await expect(limit(async () => concurrency)).resolves.toBe(concurrency)
    }
  })

  it('同步抛错的脚本化任务测试：异常在 task 内部或外部抛出都能被捕获', async () => {
    const limit = createLimit(1)
    const outer = limit(() => {
      throw new Error('sync throw')
    })
    await expect(outer).rejects.toThrow('sync throw')
  })

  it('并发数取整后仍然按 FIFO 完成全部任务', async () => {
    const limit = createLimit(1.9)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => limit(async () => index * 2)),
    )
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
  })

  it('一个槽位释放后只唤醒一个等待者', async () => {
    const limit = createLimit(1)
    let running = 0
    let peak = 0
    const tasks = Array.from({ length: 5 }, () => limit(async () => {
      running++
      peak = Math.max(peak, running)
      await Promise.resolve()
      running--
    }))
    await Promise.all(tasks)
    expect(peak).toBe(1)
  })

  it('mapLimited 保留结果顺序并透传索引', async () => {
    const seen: number[] = []
    const results = await mapLimited(['a', 'b', 'c', 'd'], 2, async (item, index) => {
      seen.push(index)
      return `${item}${index}`
    })
    expect(results).toEqual(['a0', 'b1', 'c2', 'd3'])
    expect(seen).toEqual([0, 1, 2, 3])
  })

  it('mapLimited 中空数组直接返回空结果', async () => {
    expect(await mapLimited([], 3, async () => 1)).toEqual([])
  })
})
