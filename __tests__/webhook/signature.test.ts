import type { WebhookPlatform } from '../../src/domain/webhook'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { verifySignature } from '../../src/webhook/signature'

const SECRET = 'super-secret-value'

function sign(body: Buffer, algorithm: 'sha1' | 'sha256' = 'sha256'): string {
  return createHmac(algorithm, SECRET).update(body).digest('hex')
}

function headersWith(name: string, value: string): NodeJS.Dict<string | string[]> {
  return { [name]: value }
}

describe('verifySignature', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }))

  describe.each<WebhookPlatform>(['github', 'gitea'])('%s 平台使用 x-hub-signature-256', (platform) => {
    it('正确签名通过', () => {
      const result = verifySignature(platform, body, headersWith('x-hub-signature-256', `sha256=${sign(body)}`), SECRET)
      expect(result.ok).toBe(true)
      expect(result.reason).toBeUndefined()
    })

    it('签名不匹配拒绝', () => {
      const result = verifySignature(platform, body, headersWith('x-hub-signature-256', `sha256=${sign(Buffer.from('other'))}`), SECRET)
      expect(result.ok).toBe(false)
      expect(result.reason).toBeDefined()
    })

    it('缺少前缀 sha256= 拒绝', () => {
      const result = verifySignature(platform, body, headersWith('x-hub-signature-256', sign(body)), SECRET)
      expect(result.ok).toBe(false)
    })
  })

  it('gitea 仅在 allowLegacySha1 时接受旧版 sha1 签名', () => {
    const headers = headersWith('x-hub-signature', `sha1=${sign(body, 'sha1')}`)
    expect(verifySignature('gitea', body, headers, SECRET).ok).toBe(false)
    expect(verifySignature('gitea', body, headers, SECRET, { allowLegacySha1: true }).ok).toBe(true)
    // GitHub 永不接受 legacy sha1
    expect(verifySignature('github', body, headers, SECRET, { allowLegacySha1: true }).ok).toBe(false)
  })

  it('gitlab 比较 x-gitlab-token', () => {
    expect(verifySignature('gitlab', body, headersWith('x-gitlab-token', SECRET), SECRET).ok).toBe(true)
    expect(verifySignature('gitlab', body, headersWith('x-gitlab-token', 'wrong'), SECRET).ok).toBe(false)
    expect(verifySignature('gitlab', body, {}, SECRET).ok).toBe(false)
  })

  it('bitbucket 使用 x-hub-signature 的 sha256 HMAC', () => {
    expect(verifySignature('bitbucket', body, headersWith('x-hub-signature', `sha256=${sign(body)}`), SECRET).ok).toBe(true)
    expect(verifySignature('bitbucket', body, headersWith('x-hub-signature', sign(body)), SECRET).ok).toBe(false)
    expect(verifySignature('bitbucket', body, {}, SECRET).ok).toBe(false)
  })

  it('缺少签名头时拒绝并给出原因', () => {
    const result = verifySignature('github', body, {}, SECRET)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('x-hub-signature-256')
  })

  it('空 secret 一律拒绝', () => {
    for (const platform of ['github', 'gitlab', 'bitbucket', 'gitea'] as WebhookPlatform[]) {
      const result = verifySignature(platform, body, headersWith('x-gitlab-token', ''), '')
      expect(result.ok).toBe(false)
    }
  })

  it('失败原因绝不回显 secret', () => {
    const cases = [
      verifySignature('github', body, {}, SECRET),
      verifySignature('github', body, headersWith('x-hub-signature-256', 'sha256=deadbeef'), SECRET),
      verifySignature('gitlab', body, headersWith('x-gitlab-token', 'wrong'), SECRET),
      verifySignature('bitbucket', body, headersWith('x-hub-signature', 'sha256=wrong'), SECRET),
      verifySignature('gitea', body, headersWith('x-hub-signature', `sha1=${sign(body, 'sha1').slice(0, 8)}`), SECRET, { allowLegacySha1: true }),
    ]
    for (const result of cases) {
      expect(result.ok).toBe(false)
      expect(result.reason).not.toContain(SECRET)
    }
  })
})
