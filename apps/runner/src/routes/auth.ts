import type { RequestHandler } from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'

// Methods that can create, mutate, or destroy state. Reads (GET/HEAD/OPTIONS)
// stay open so health checks, the dashboard, and the agent-board snapshots keep
// working without a credential.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Compare in constant time. Both sides are hashed to a fixed-length digest so
// timingSafeEqual never throws on a length mismatch — which would itself leak
// the expected token's length.
function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

// Pull the token out of an `Authorization: Bearer <token>` header. The scheme is
// case-insensitive; surrounding whitespace is tolerated. A header carrying
// anything but a single bearer token yields undefined (treated as unauthorized).
function extractBearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim())
  return match ? match[1] : undefined
}

/**
 * Build the bearer-auth middleware. When no token is configured the returned
 * middleware is a pass-through: the runner behaves exactly as it did before, so
 * the fleet's own unauthenticated localhost POSTs keep working. When a token is
 * configured, state-mutating requests must carry `Authorization: Bearer <token>`
 * or they get 401; reads are never challenged.
 */
export function requireBearerAuth(token: string | undefined): RequestHandler {
  if (!token) {
    return (_req, _res, next) => next()
  }
  return (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) {
      next()
      return
    }
    const provided = extractBearerToken(req.headers.authorization)
    if (provided === undefined || !tokensMatch(provided, token)) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  }
}
