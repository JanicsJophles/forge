import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

// Optional bearer token for the runner's state-changing routes.
//
// Any request that is not a read (GET/HEAD/OPTIONS) needs
// "Authorization: Bearer <FORGE_RUNNER_TOKEN>", except the agent-board writes
// listed in OPEN_WRITES. Deny-by-default means a write route added later is
// covered without anyone remembering to add it here.
//
// FORGE_RUNNER_TOKEN unset: nothing is enforced, as before this change, and one
// warning is logged at startup. That lets the runner be deployed before its
// callers have the token.

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

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

// RFC 6750 b64token, the only token alphabet a bearer credential may use.
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
  token: string | undefined
  warn?: (message: string) => void
  info?: (message: string) => void
}

/** Express middleware enforcing the runner token. Logs the auth mode once. */
export function runnerAuth({ token, warn = console.warn, info = console.log }: RunnerAuthOptions): RequestHandler {
  const expected = token?.trim()
  if (!expected) {
    warn('[auth] FORGE_RUNNER_TOKEN is not set: task routes accept unauthenticated requests. Set it to require a bearer token.')
    return (_req, _res, next) => next()
  }
  if (expected.length < 32) warn('[auth] FORGE_RUNNER_TOKEN is shorter than 32 characters; use a long random value.')
  info('[auth] FORGE_RUNNER_TOKEN is set: state-changing task routes require a bearer token.')

  const expectedDigest = digest(expected)
  return (req: Request, res: Response, next: NextFunction) => {
    if (!needsToken(req.method, req.path)) return next()
    const provided = bearerToken(req)
    // Hash both sides so the comparison has a fixed length and takes the
    // same time whatever the caller sent.
    const ok = provided !== undefined && timingSafeEqual(digest(provided), expectedDigest)
    if (ok) return next()
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' })
  }
}
