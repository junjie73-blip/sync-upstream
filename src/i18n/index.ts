import process from 'node:process'
import { en, zh } from './catalog'

/**
 * The two languages this CLI speaks.
 *
 * Chinese is the default because that is how the tool has always answered; an environment that
 * says otherwise (`LANG=en_US.UTF-8`) gets English without having to ask. Anything the locale
 * module does not know about stays Chinese rather than disappearing.
 */
export type Locale = 'zh' | 'en'

export const LOCALES: readonly Locale[] = ['zh', 'en']

const catalogs: Record<Locale, Record<string, string>> = { zh, en }

let active: Locale = 'zh'

/**
 * Read the language from the environment, best match first.
 *
 * `SYNC_UPSTREAM_LANG` wins because it is the one switch that can only mean this tool; after that
 * come `LC_ALL`, `LANG` and `LANGUAGE` (the last is a colon list, most preferred first). A locale
 * naming Chinese selects `zh`; any *other* recognised locale selects `en`, which is the useful
 * default for somebody whose machine is not Chinese at all. `C` and `POSIX` — with or without an
 * encoding suffix such as `C.UTF-8` — are not signals, and no signal at all keeps `zh`.
 */
export function detectLocale(env: Record<string, string | undefined> = process.env): Locale {
  const explicit = env.SYNC_UPSTREAM_LANG
  if (explicit && isLocale(explicit))
    return explicit

  const candidates: string[] = []
  for (const name of ['LC_ALL', 'LANG', 'LANGUAGE'] as const) {
    const value = env[name]
    if (value)
      candidates.push(...value.split(':'))
  }
  for (const candidate of candidates) {
    const normalized = candidate.trim().toLowerCase().replace(/_/g, '-')
    // Drop the encoding and modifier suffixes before deciding: `C.UTF-8` — what containers and CI
    // set all the time — is the same "no locale here" signal as bare `C`.
    const base = normalized.split('.')[0].split('@')[0]
    if (base === '' || base === 'c' || base === 'posix')
      continue
    if (base.startsWith('zh'))
      return 'zh'
    // The first non-Chinese locale in the preference list is the one the user reads.
    return 'en'
  }
  return 'zh'
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value.trim().toLowerCase())
}

/** Apply a locale, ignoring anything unrecognised (a typo in `--lang` must not silence the tool). */
export function setLocale(value: string | Locale | null | undefined): Locale {
  if (typeof value === 'string' && isLocale(value))
    active = value.trim().toLowerCase() as Locale
  return active
}

export function currentLocale(): Locale {
  return active
}

/** Pick from the flag, then the environment, then the historical default. */
export function initLocale(flagValue: string | undefined, env: Record<string, string | undefined> = process.env): Locale {
  return setLocale(flagValue ?? detectLocale(env))
}

/**
 * Look a message up and fill in `{placeholders}`.
 *
 * Only placeholders the caller actually supplied get replaced: `{target}`/`{date}` appear inside
 * config documentation, and eating them would turn `分支名，占位符 {target}` into `分支名，占位符 `.
 * A key missing from the catalog comes back as the key itself, which is louder in a test failure
 * than an empty string.
 */
export function t(key: string, vars?: Record<string, string | number | undefined>): string {
  const template = catalogs[active][key] ?? catalogs.zh[key] ?? key
  if (!vars)
    return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Join a list of names the way this language does.
 *
 * The Chinese lists were built with `、` and `；`, which read as stray punctuation in an English
 * sentence, so the separator is part of the locale rather than part of the message.
 */
export function joinList(values: string[], kind: 'comma' | 'semicolon' = 'comma'): string {
  if (values.length === 0)
    return ''
  if (active !== 'zh')
    return values.join(kind === 'comma' ? ', ' : '; ')
  return values.join(kind === 'comma' ? '、' : '；')
}

/** Every key the tool knows about — used by the catalog-parity test. */
export function messageKeys(): string[] {
  return Object.keys(catalogs.zh)
}
