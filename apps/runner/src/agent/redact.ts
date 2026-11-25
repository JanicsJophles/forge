// Masks credential-looking values in text that is about to be logged (task log, SSE, error messages).
// Best effort and deliberately broad: a masked false positive costs a little readability, a miss leaks a secret.
const MASK = '***'

// Variable names whose values are secrets: FOO_TOKEN=, DB_PASSWORD=, API_KEY=, GH_PAT=, ...
const SECRET_NAME = /token|secret|passw|credential|api_?key|access_?key|private_?key|(^|_)key($|_)|(^|_)pat($|_)|auth/i

const RULES: Array<[RegExp, string]> = [
  // scheme://user:pass@host and scheme://token@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]+@/gi, `$1${MASK}@`],
  // Authorization: Bearer xyz / Authorization: token xyz / Authorization: Basic xyz
  [/\b(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s'"]+/gi, `$1${MASK}`],
  [/\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${MASK}`],
  // "password": "x" / 'token': 'x' in JSON-ish text
  [/(["'](?:[A-Za-z0-9_]*(?:token|secret|password|api_?key)[A-Za-z0-9_]*)["']\s*:\s*["'])[^"']*/gi, `$1${MASK}`],
  // Well-known token formats
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MASK],
]

export function redact(text: string): string {
  let out = text
  // NAME=value and --name=value where NAME looks secret
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_-]*)=("[^"]*"|'[^']*'|[^\s'"&;|]+)/g,
    (whole, name: string) => (SECRET_NAME.test(name) ? `${name}=${MASK}` : whole))
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}
