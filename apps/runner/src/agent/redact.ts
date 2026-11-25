// Masks credential-looking values in text that is about to be logged (task log, SSE, error messages).
// Best effort and deliberately broad: a masked false positive costs a little readability, a miss leaks a secret.
//
// Every pattern here must stay linear in the input: this runs on the runner's event loop over agent-controlled text.
// Rules start at a literal or a delimiter, name parts are bounded, and value parts are greedy runs that always
// succeed (nothing after them can fail and force backtracking). test/redact.test.ts times each rule on 2 MB inputs.
const MASK = '***'

// Names whose values are secrets: FOO_TOKEN, DB_PASSWORD, API_KEY, GH_PAT, --api-key, X-Auth-Token, ...
const SECRET_NAME = /token|secret|passw|pwd|credential|api[_-]?key|access[_-]?key|private[_-]?key|(^|[_-])key($|[_-])|(^|[_-])pat($|[_-])|(^|[_-])auth($|[_-])|authorization|auth[_-]?token|session|cookie|signature/i
const SECRET_HEADER = /^(?:x-[a-z0-9-]*(?:key|token|secret|auth|pass|session|signature)[a-z0-9-]*|cookie|set-cookie|authorization|proxy-authorization|api-?key)$/i

// A value: a quoted string (closing quote optional) or an unquoted run. Always matches at least one character.
const VALUE = String.raw`("[^"\n]*"?|'[^'\n]*'?|[^\s'"&;|]+)`

// A flag's value: like VALUE, but never another flag.
const FLAG_VALUE = String.raw`("[^"\n]*"?|'[^'\n]*'?|[^\s'"&;|-][^\s'"&;|]*)`

type Rule = [RegExp, string | ((...m: string[]) => string)]

const RULES: Rule[] = [
  // NAME=value and --name=value where the name looks secret
  [new RegExp(String.raw`(^|[^A-Za-z0-9_-])(-{0,2}[A-Za-z_][A-Za-z0-9_-]{0,63})=${VALUE}`, 'g'),
    (whole, pre, name) => (SECRET_NAME.test(name) ? `${pre}${name}=${MASK}` : whole)],
  // --token value, --password value, -u user:pass, --user user:pass
  [new RegExp(String.raw`(^|\s)(--?[A-Za-z][A-Za-z0-9-]{0,40})([ \t]{1,8})${FLAG_VALUE}`, 'g'),
    (whole, pre, flag, gap, value) => ((flag === '-u' || flag === '--user') ? value.includes(':') : SECRET_NAME.test(flag))
      ? `${pre}${flag}${gap}${MASK}` : whole],
  // scheme://user:pass@host and scheme://token@host
  [/:\/\/[^/@\s'"]{1,512}@/g, `://${MASK}@`],
  // Authorization: Bearer xyz / Basic xyz / token xyz
  [/\b(authorization[ \t]{0,8}[:=][ \t]{0,8})(?:bearer[ \t]{1,8}|basic[ \t]{1,8}|token[ \t]{1,8})?[^\s'"]+/gi, `$1${MASK}`],
  // Secret-looking headers: X-Api-Key: v, X-Auth-Token: v, Cookie: v
  [/(^|[\s'"])(x-[A-Za-z0-9-]{1,40}|cookie|set-cookie|proxy-authorization|api-?key)([ \t]{0,8}:[ \t]{0,8})([^'"\r\n]+)/gi,
    (whole, pre, name, sep) => (SECRET_HEADER.test(name) ? `${pre}${name}${sep}${MASK}` : whole)],
  [/\b(bearer|token)[ \t]{1,8}[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${MASK}`],
  // "password": "x" / 'api_key': 'x' in JSON-ish text
  [/(["'])([A-Za-z0-9_-]{1,64})(["'][ \t]{0,8}:[ \t]{0,8}["'])[^"'\n]*/g,
    (whole, q, key, sep) => (SECRET_NAME.test(key) ? `${q}${key}${sep}${MASK}` : whole)],
  // A long bare hex/base64 value right after a secret-ish word: "api key: 3f9a...", "secret abc..."
  [/\b(tokens?|secrets?|password|passwd|api[ _-]?key|key|signature|credentials?)([\s:="']{1,8})[A-Za-z0-9+/_=-]{32,}/gi, `$1$2${MASK}`],
]

// Well-known token formats, checked per run of token characters (one linear scan, anchored checks inside).
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const KNOWN = /^(?:sk-(?:ant-)?[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})/

function maskKnown(text: string): string {
  return text
    .replace(/[A-Za-z0-9_.-]+/g, run => (run.length >= 20 && run.startsWith('eyJ') && JWT.test(run) ? MASK : run))
    .replace(/[A-Za-z0-9_-]+/g, run => (run.length >= 10 && KNOWN.test(run) ? MASK : run))
}

/** All rules over the whole input. Linear, but callers should use redact(), which also bounds the input. */
export function redactUnbounded(text: string): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement as any)
  return maskKnown(out)
}

/** Largest input redact() looks at: work per call stays bounded however large the text is. */
export const REDACT_MAX = 64 * 1024
/** Room past a cut so a secret that straddles it is still recognized. */
const OVERLAP = 512

/**
 * Masks credentials in `text` and returns at most `max` characters. Longer input is cut first (plus a small
 * overlap), a token run touching that cut is dropped (it may be half a secret), the rest is redacted, and the
 * result is cut to `max`.
 */
export function redact(text: string, max = REDACT_MAX): string {
  if (text.length <= max) return redactUnbounded(text)
  let end = Math.min(text.length, max + OVERLAP)
  if (end < text.length) while (end > 0 && /[A-Za-z0-9_.~+/=-]/.test(text[end - 1])) end--
  const out = redactUnbounded(text.slice(0, end))
  return out.length > max ? out.slice(0, max) : out
}
