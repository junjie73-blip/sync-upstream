import { redacted } from '../git/url'

/** Keys whose value must never reach a log file, in the spellings real configs and headers use. */
const KEY = 'authorization|proxy-authorization|access_token|refresh_token|id_token|x-oauth_token|x-oauth-token|x-github-token|x-gitlab-token|webhook_secret|webhook-secret|client_secret|client-secret|api_key|api-key|apikey|token|secret|password|passwd|credential|credentials'

/** `"token": "value"` and `token='value'`: the quotes stay, so a JSON line is still valid JSON. */
const QUOTED_VALUE = new RegExp(`(["']?(?:${KEY})["']?\\s*[:=]\\s*)(["'])([^"']*)\\2`, 'gi')
/**
 * `token=value` / `token: value`: the value stops at the first delimiter, quotes included.
 *
 * Two values are left alone because they are not secrets: the `Bearer`/`Basic` word that sits in
 * front of a token — the scheme passes below already masked what follows it — and `***`, which is
 * this module's own mask. Without the mask lookahead a second pass would re-mask its own output and
 * log `Authorization: *** ***`.
 */
const BARE_VALUE = new RegExp(`(\\b(?:${KEY})["']?\\s*[:=]\\s*)(?!(?:bearer|basic)(?:\\s|$)|\\*\\*\\*)([^"'\\s,;}&]+)`, 'gi')
/** `Authorization: Bearer eyJhb…` is a header line, not a key/value pair, so match the whole shape. */
const HEADER_SCHEME = new RegExp(`\\b(${KEY})\\s*([=:]\\s*(?:bearer|basic)\\s+)([^\\s"',;}&]+)`, 'gi')
/** A scheme with no header in front of it has to earn the mask on its own length. */
const LOOSE_SCHEME = /\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi

const MASK = '***'

/**
 * Scrub everything that looks like a credential out of a line before it reaches a file.
 *
 * Files outlive the run: they get committed by accident, pasted into an issue, shipped to a log
 * aggregator. A token that reaches one of those is a token that has to be rotated, so the scrub is
 * unconditional rather than a flag somebody has to remember to turn on.
 */
export function redactSecrets(value: string, literals: string[] = []): string {
  let out = value
  // Exact strings first: a secret that happens to contain `=` would survive the pattern rules.
  for (const literal of literals) {
    if (typeof literal === 'string' && literal.length > 0)
      out = out.split(literal).join(MASK)
  }
  // `//user:token@host`, the shape git itself puts into remote URLs and error text.
  out = redacted(out)
  // Quoted before bare: `token: "a b"` would otherwise leak everything after the space.
  out = out.replace(QUOTED_VALUE, (_match, key: string, quote: string) => `${key}${quote}${MASK}${quote}`)
  // Scheme before bare, and matching the whole `header: scheme token` shape rather than just the
  // scheme: the bare pass stops at whitespace, so it would mask the word `Bearer` and leave the
  // token sitting in the line.
  out = out.replace(HEADER_SCHEME, (_match, key: string, separator: string) => `${key}${separator}${MASK}`)
  out = out.replace(LOOSE_SCHEME, (_match, scheme: string) => `${scheme} ${MASK}`)
  return out.replace(BARE_VALUE, (_match, key: string) => `${key}${MASK}`)
}
