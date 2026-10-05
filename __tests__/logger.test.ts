import { Logger, LogLevel } from '../src/logger'

/** consola writes synchronously through stdout/stderr, so a pair of spies is enough. */
function capture(write: (log: Logger) => void): string {
  const chunks: string[] = []
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    chunks.push(String(chunk))
    return true
  })
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    write(new Logger())
  }
  finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
  return chunks.join('')
}

describe('Logger 等级过滤', () => {
  it('默认 INFO：info/success/warn/error 输出，debug/verbose 静默', () => {
    const out = capture((log) => {
      log.debug('d-line')
      log.verbose('v-line')
      log.info('i-line')
      log.success('s-line')
      log.warn('w-line')
      log.error('e-line')
    })

    expect(out).toContain('i-line')
    expect(out).toContain('s-line')
    expect(out).toContain('w-line')
    expect(out).toContain('e-line')
    expect(out).not.toContain('d-line')
    expect(out).not.toContain('v-line')
  })

  it('--verbose 放行更啰嗦的等级，而不是把 info 一起吞掉', () => {
    const out = capture((log) => {
      log.setLevel(LogLevel.VERBOSE)
      log.verbose('v-line')
      log.info('i-line')
      log.debug('d-line')
    })

    expect(out).toContain('v-line')
    expect(out).toContain('i-line')
    expect(out).not.toContain('d-line')
  })

  it('--silent（ERROR）只保留错误，warn 与步骤日志都闭嘴', () => {
    const out = capture((log) => {
      log.setLevel(LogLevel.ERROR)
      log.info('i-line')
      log.warn('w-line')
      log.step(1, 'step-line')
      log.error('e-line')
    })

    expect(out).toContain('e-line')
    expect(out).not.toContain('i-line')
    expect(out).not.toContain('w-line')
    expect(out).not.toContain('step-line')
  })

  it('setLevel 之后又能调回去，等级切换是可逆的', () => {
    const out = capture((log) => {
      log.setLevel(LogLevel.ERROR)
      log.setLevel(LogLevel.DEBUG)
      log.debug('d-line')
      log.info('i-line')
    })

    expect(out).toContain('d-line')
    expect(out).toContain('i-line')
  })
})
