import type { DeliveryRecord } from '../../src/webhook/delivery-log'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { DeliveryLog, readDeliveryLog, summariseDeliveries } from '../../src/webhook/delivery-log'

let dir: string
let file: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-delivery-'))
  file = path.join(dir, 'deliveries.jsonl')
})

afterEach(async () => {
  await fs.remove(dir)
})

function jsonlOf(target: string): Record<string, unknown>[] {
  return fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('DeliveryLog.record', () => {
  it('一条投递一行 JSON，时间缺省时自动补齐', () => {
    const log = new DeliveryLog(file)

    expect(log.record({ decision: 'accepted', platform: 'github', event: 'push', branch: 'main', status: 202 })).toBeUndefined()

    const [record] = jsonlOf(file)
    expect(record).toEqual({ decision: 'accepted', platform: 'github', event: 'push', branch: 'main', status: 202, at: expect.any(String) })
  })

  it('嵌套目录不存在也能写：审计文件常放在 .sync-upstream/ 下面', () => {
    const nested = path.join(dir, '.sync-upstream', 'deliveries.jsonl')

    expect(new DeliveryLog(nested).record({ decision: 'ignored', reason: '分支不匹配' })).toBeUndefined()
    expect(jsonlOf(nested)).toHaveLength(1)
  })

  it('只记录投递的形状，绝不把请求体写进审计', () => {
    const log = new DeliveryLog(file)
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [{ message: '发布 secret = hunter2' }] })

    // 运维拿到的行里应当只有字段本身；正文从来没进过 record。
    log.record({ decision: 'accepted', event: 'push', branch: 'main', reason: body.slice(0, 0) || undefined })

    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('commits')
    expect(raw).not.toContain('hunter2')
  })

  it('写不进去时把错误当返回值交出去，投递照样要回话', () => {
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, '不是目录', 'utf8')

    const failure = new DeliveryLog(path.join(blocker, 'a.jsonl')).record({ decision: 'rejected' })

    expect(typeof failure).toBe('string')
    expect(failure).toContain('写入投递审计')
  })

  it('复用同一套清洗：密钥与颜色码都进不了审计文件', () => {
    const log = new DeliveryLog(file, ['whsec_top_secret'])

    log.record({ decision: 'failed', reason: `\u001B[31mtoken=ghp_abcdefghijklmnop 且 whsec_top_secret 泄漏` })

    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('ghp_abcdefghijklmnop')
    expect(raw).not.toContain('whsec_top_secret')
    expect(raw).not.toContain(String.fromCharCode(27))
    expect(JSON.parse(raw).reason).toContain('token=***')
  })

  it('path 让 doctor 能说清审计文件在哪', () => {
    expect(new DeliveryLog(file).path).toBe(file)
  })
})

describe('readDeliveryLog', () => {
  it('文件不存在时给出空统计，而不是报错', () => {
    expect(readDeliveryLog(path.join(dir, 'missing.jsonl'))).toEqual({ total: 0, records: [] })
  })

  it('倒序返回最近的几条，total 仍然是总条数', () => {
    const log = new DeliveryLog(file)
    for (const branch of ['a', 'b', 'c', 'd'])
      log.record({ decision: 'accepted', branch })

    const tail = readDeliveryLog(file, 2)
    expect(tail.total).toBe(4)
    expect(tail.records.map(record => record.branch)).toEqual(['d', 'c'])
  })

  it('半行损坏（进程被 kill 时最常见）跳过它继续读，别让整个审计读不出来', () => {
    const log = new DeliveryLog(file)
    log.record({ decision: 'accepted', branch: 'ok-1' })
    fs.appendFileSync(file, '{"decision":"accepted","branch":"截断', 'utf8')
    log.record({ decision: 'synced', branch: 'ok-2' })

    const tail = readDeliveryLog(file)
    expect(tail.total).toBe(2)
    expect(tail.records.map(record => record.branch)).toEqual(['ok-2', 'ok-1'])
  })

  it('缺 decision 的行不算投递记录', () => {
    fs.writeFileSync(file, `${JSON.stringify({ at: 'x', branch: 'main' })}\n`, 'utf8')

    expect(readDeliveryLog(file).total).toBe(0)
  })

  it('limit 大于条数时有多少给多少', () => {
    new DeliveryLog(file).record({ decision: 'rejected' })

    expect(readDeliveryLog(file, 50).records).toHaveLength(1)
  })
})

describe('summariseDeliveries', () => {
  it('五种决定各计一次，没出现过的也是 0', () => {
    const records: DeliveryRecord[] = [
      { decision: 'accepted' },
      { decision: 'accepted' },
      { decision: 'synced' },
      { decision: 'failed' },
      { decision: 'ignored' },
    ]

    expect(summariseDeliveries(records)).toEqual({ accepted: 2, ignored: 1, rejected: 0, synced: 1, failed: 1 })
  })

  it('认不出的决定直接忽略，不能让一个脏行把统计带崩', () => {
    expect(summariseDeliveries([{ decision: 'maybe' as DeliveryRecord['decision'] }]).accepted).toBe(0)
  })
})
