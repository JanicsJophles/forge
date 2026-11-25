import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

// Optional bearer tokens for the runner's state-changing routes.
//
// Any request that is not a read (GET/HEAD/OPTIONS) needs
// "Authorization: Bearer <token>", except the agent-board writes listed in
// OPEN_WRITES. Deny-by-default means a write route added later is covered
// without anyone remembering to add it here.
//
// Tokens come from the environment (see config.ts):
//   FORGE_RUNNER_TOKEN          caller name "default"
//   FORGE_RUNNER_TOKEN_<NAME>   caller name "<name>" (lowercase), one per caller
// so each caller can be given, rotated and revoked on its own. Accepted
// writes are logged with the caller name, never the token.
//
// No token configured: nothing is enforced, as before this change, and one
// warning is logged at startup. That lets the runner be deployed before its
// callers have a token.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Agent-board writes stay open for now: many agents post checkpoints without a
// token. Exact routes only (Express matches paths case-insensitively and
// ignores one trailing slash, so these do as well).
const OPEN_WRITES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/agent-state\/checkpoint\/?$/i },
  { method: 'DELETE', path: /^\/agent-state\/[^/]+\/?$/i },
  { method: 'POST', path: /^\/agent-events\/?$/i },
]

export function needsToken(method: string, path: string): boolean {
  const m = method.toUpperCase()
  if (SAFE_METHODS.has(m)) return false
  return !OPEN_WRITES.some(route => route.method === m && route.path.test(path))
}

export const TOKEN_ENV = /^FORGE_RUNNER_TOKEN(?:_([A-Z0-9]{1,32}))?$/

/** Caller name -> token for every FORGE_RUNNER_TOKEN[_NAME] variable that has a value. */
export function tokensFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const match = TOKEN_ENV.exec(key)
    if (match && value?.trim()) tokens[match[1]?.toLowerCase() ?? 'default'] = value.trim()
  }
  return tokens
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

// RFC 6750 b64token, the only token alphabet a bearer credential may use.
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/
const BEARER = /^bearer +([A-Za-z0-9\-._~+/]+=*) *$/i
const MAX_HEADER_LENGTH = 4096

/** The bearer token in the request, or undefined if it has none or several. */
export function bearerToken(req: IncomingMessage): string | undefined {
  // Node keeps only the first of repeated Authorization headers; refuse the
  // request instead of guessing which one the client meant.
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'authorization') count++
  }
  if (count !== 1) return undefined
  const header = req.headers.authorization
  if (typeof header !== 'string' || header.length > MAX_HEADER_LENGTH) return undefined
  return BEARER.exec(header)?.[1]
}

export type RunnerAuthOptions = {
  /** Caller name -> token. Empty: no enforcement. */
  tokens: Readonly<Record<string, string>>
  warn?: (message: string) => void
  info?: (message: string) => void
  now?: () => number
}

const REFUSAL_LOG_INTERVAL_MS = 60_000
const printable = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 120)

/** Express middleware enforcing the runner tokens. Logs the auth mode once. */
export function runnerAuth({ tokens, warn = console.warn, info = console.log, now = Date.now }: RunnerAuthOptions): RequestHandler {
  const entries = Object.entries(tokens)
    .map(([name, token]) => [name, token.trim()] as const)
    .filter(([, token]) => token.length > 0)
  if (entries.length === 0) {
    warn('[auth] FORGE_RUNNER_TOKEN is not set: task routes accept unauthenticated requests. Set it to require a bearer token.')
    return (_req, _res, next) => next()
  }
  for (const [name, token] of entries) {
    if (token.length < 32) warn(`[auth] runner token "${name}" is shorter than 32 characters; use a long random value.`)
    if (!B64TOKEN.test(token)) warn(`[auth] runner token "${name}" has characters a bearer header cannot carry; it will never match.`)
  }
  info(`[auth] runner tokens set (${entries.map(([name]) => name).join(', ')}): state-changing task routes require a bearer token.`)

  const expected = entries.map(([name, token]) => ({ name, digest: digest(token) }))
  let lastRefusalLog = -Infinity
  let refusedSinceLog = 0

  return (req: Request, res: Response, next: NextFunction) => {
    if (!needsToken(req.method, req.path)) return next()
    const provided = bearerToken(req)
    // Hash so every comparison has a fixed length, and compare against every
    // token without stopping early, so timing says nothing about which matched.
    const providedDigest = digest(provided ?? '')
    let caller: string | undefined
    for (const candidate of expected) {
      if (timingSafeEqual(providedDigest, candidate.digest) && provided !== undefined) caller ??= candidate.name
    }
    if (caller !== undefined) {
      res.locals.runnerCaller = caller
      info(`[auth] ${req.method} ${printable(req.path)} by ${caller}`)
      return next()
    }
    refusedSinceLog++
    const t = now()
    if (t - lastRefusalLog >= REFUSAL_LOG_INTERVAL_MS) {
      warn(`[auth] refused ${req.method} ${printable(req.path)} from ${printable(req.socket.remoteAddress ?? '?')}` +
        (refusedSinceLog > 1 ? ` (${refusedSinceLog} refusals since the last line)` : ''))
      lastRefusalLog = t
      refusedSinceLog = 0
    }
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' })
  }
}
