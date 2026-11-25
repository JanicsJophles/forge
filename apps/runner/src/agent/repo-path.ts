import { lstatSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'

// The runner is root. A task's repo path reaches `chown -R` and the agent's cwd, so a path an attacker shapes
// ("/opt/repos/../../etc", a symlink planted under /opt/repos, or shell syntax) must never get that far.
// Only plain absolute paths made of [A-Za-z0-9._/-], with no "." or ".." segment, are considered at all.
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/

export function isPlainAbsolutePath(path: string): boolean {
  if (typeof path !== 'string' || !SAFE_PATH.test(path)) return false
  const segments = path.split('/').slice(1)
  return segments.every((segment, i) => segment !== '.' && segment !== '..' && (segment !== '' || i === segments.length - 1))
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function realDir(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * The canonical repo path when `repo` is a real directory (not a symlink) strictly inside one of `allowedRoots`,
 * and `repo` is already written in canonical form; otherwise null. Callers use the returned path, never the input.
 */
export function resolveAllowedRepo(repo: string, allowedRoots: readonly string[]): string | null {
  if (!isPlainAbsolutePath(repo)) return null
  const wanted = stripTrailingSlash(repo)
  let stat
  try {
    stat = lstatSync(wanted)
  } catch {
    return null
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null
  if (realDir(wanted) !== wanted) return null
  for (const root of allowedRoots) {
    if (!isPlainAbsolutePath(root)) continue
    const realRoot = realDir(stripTrailingSlash(root))
    if (realRoot && wanted.startsWith(realRoot + sep) && wanted.length > realRoot.length + 1) return wanted
  }
  return null
}
