import { redactSecrets } from '../../src/log/redact'

describe('redactSecrets', () => {
  it('URL 里的账号口令一律抹掉，因为 git 的错误文本就是这么写的', () => {
    expect(redactSecrets('拉取 https://git:ghp_secretvalue@github.com/a/b.git 失败'))
      .toBe('拉取 https://***@github.com/a/b.git 失败')
  })

  it('key=value 与 key: value 两种写法都只留键名', () => {
    expect(redactSecrets('token=ghp_abcdefghijklmnop')).toBe('token=***')
    expect(redactSecrets('password: hunter2 已用于登录')).toBe('password: *** 已用于登录')
    expect(redactSecrets('api-key = sk-proj-xyz&repo=a')).toBe('api-key = ***&repo=a')
  })

  it('JSON 里带引号的值打码后仍然是合法 JSON', () => {
    const line = JSON.stringify({ msg: '推送失败', token: 'ghp_abcdefghijklmnop', secret: 'a b c' })
    const out = redactSecrets(line)

    expect(JSON.parse(out)).toEqual({ msg: '推送失败', token: '***', secret: '***' })
  })

  it('Authorization: Bearer 这种请求头写法只打码令牌，保留可读的认证方案', () => {
    const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')

    expect(out).toBe('Authorization: Bearer ***')
    expect(out).not.toContain('eyJ')
  })

  it('短令牌也不能从认证头里漏出去，即便它不够长到被单独识别', () => {
    const out = redactSecrets('Authorization=Bearer abc123')

    expect(out).toBe('Authorization=Bearer ***')
    expect(out).not.toContain('abc123')
  })

  it('没有请求头前缀的裸 Bearer 仍按长度打码，同时不伤到正文里的这个词', () => {
    expect(redactSecrets('using Bearer eyJhbGciOiJIUzI1NiI here')).toBe('using Bearer *** here')
    expect(redactSecrets('the bearer token is expired')).toBe('the bearer token is expired')
  })

  it('调用方给出的原文优先整串替换，哪怕它本身长得像配置', () => {
    const secret = 'wh=sec/ret=value'

    expect(redactSecrets(`签名用 ${secret} 计算`, [secret])).toBe('签名用 *** 计算')
  })

  it('普通日志一个字都不该被改：路径、提交号、中文说明都不是密钥', () => {
    const line = '[2026-10-23] [INFO] 已提交 5c6b3a83（3 个文件）· src/config/a.ts'

    expect(redactSecrets(line)).toBe(line)
  })

  it('tokenizer 这种词不该被当成 token', () => {
    expect(redactSecrets('tokenizer: ok')).toBe('tokenizer: ok')
  })
})
