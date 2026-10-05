/** A scheduled task: called only when a slot is free, exactly once. */
export type Limit = <T>(task: () => Promise<T>) => Promise<T>

/**
 * Bounded concurrent task runner.
 *
 * `p-limit` is ESM-only, which the CJS bundle built by `tsup` cannot `require`, so the
 * published CLI crashed on start-up. The behaviour actually needed here is small enough
 * to own: FIFO dispatch, at most `concurrency` running, failures isolated per task.
 */
export function createLimit(concurrency: number): Limit {
  const slots = Math.max(1, Number.isFinite(concurrency) ? Math.floor(concurrency) : 1)
  const pending: Array<() => void> = []
  let running = 0

  const dispatch = (): void => {
    if (running >= slots || pending.length === 0)
      return
    running++
    pending.shift()!()
  }

  return <T>(task: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    pending.push(() => {
      task()
        .then(resolve, reject)
        .finally(() => {
          running--
          dispatch()
        })
    })
    dispatch()
  })
}

/** Run every task through a shared limit and wait for all of them, keeping rejections local. */
export async function mapLimited<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = createLimit(concurrency)
  return Promise.all(items.map((item, index) => limit(() => fn(item, index))))
}
