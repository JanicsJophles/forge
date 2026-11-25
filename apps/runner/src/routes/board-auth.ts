import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { bearerToken, needsToken } from './auth.js'

// Optional bearer tokens for agent-board writers.
//
// Board writes (checkpoint, delete, events) stay open to every agent. A writer
// that sends a board token has its rows stamped with its name (writtenBy), and
// a stamped row can then only be changed or deleted by that same writer.
// Consumers that make decisions from board rows can trust stamped rows and
// ignore anonymous ones.
//
//   FORGE_BOARD_TOKEN          writer name "default"
//   FORGE_BOARD_TOKEN_<NAME>   writer name "<name>" (lowercase)
//
// These are separate from the runner task tokens: a board token never allows a
// task, and a task token does not stamp rows.

export const BOARD_TOKEN_ENV = /^FORGE_BOARD_TOKEN(?:_([A-Z0-9]{1,32}))?$/

export function boardTokensFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const match = BOARD_TOKEN_ENV.exec(key)
    if (match && value?.trim()) tokens[match[1]?.toLowerCase() ?? 'default'] = value.trim()
  }
  return tokens
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export type BoardAuthOptions = {
  tokens: Readonly<Record<string, string>>
  info?: (message: string) => void
}

/**
 * Sets res.locals.boardWriter on an open board write that carries a valid
 * board token. Anything else (no header, a task token, a wrong token) is an
 * anonymous write, exactly as before: board writes never fail on auth.
 */
export function boardAuth({ tokens, info = console.log }: BoardAuthOptions): RequestHandler {
  const expected = Object.entries(tokens)
    .map(([name, token]) => ({ name, token: token.trim() }))
    .filter(({ token }) => token.length > 0)
    .map(({ name, token }) => ({ name, digest: digest(token) }))
  if (expected.length) info(`[auth] board writer tokens set (${expected.map(e => e.name).join(', ')}).`)

  return (req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase()
    if (SAFE_METHODS.has(method) || needsToken(method, req.path)) return next()
    const provided = bearerToken(req)
    if (provided === undefined) return next()
    const providedDigest = digest(provided ?? '')
    let writer: string | undefined
    for (const candidate of expected) {
      if (timingSafeEqual(providedDigest, candidate.digest)) writer ??= candidate.name
    }
    if (writer !== undefined) res.locals.boardWriter = writer
    next()
  }
}
