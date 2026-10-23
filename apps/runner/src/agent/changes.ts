import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// What a task did to its repo, snapshotted when the agent exits. Tasks share
// one working tree, so this must run before anything else touches the repo.

export const MAX_CHANGED_FILES = 500
const GIT_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'type_changed'
export interface ChangedFile { path: string; status: ChangeStatus; added: number | null; deleted: number | null }
export interface TaskChanges {
  files: ChangedFile[]
  captured_at: string
  base_sha: string | null
  truncated: boolean
  error?: string
}
interface Identity { uid?: number; gid?: number; env?: NodeJS.ProcessEnv }

// --no-optional-locks: never take the real index.lock (a concurrent task's agent
// may be mid-`git add` in the same tree) or rewrite its stat cache.
function git(repo: string, args: string[], id: Identity, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd: repo, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...(id.env ?? process.env), ...env },
    ...(id.uid !== undefined ? { uid: id.uid } : {}),
    ...(id.gid !== undefined ? { gid: id.gid } : {}),
  })
}

// HEAD after the pre-run pull; null for an unborn branch.
export function headSha(repo: string, id: Identity = {}): string | null {
  try { return git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], id).trim() || null } catch { return null }
}

const STATUS: Record<string, ChangeStatus> = { A: 'added', M: 'modified', D: 'deleted', T: 'type_changed' }

// -z records: "<status>\0<path>\0" (--no-renames so no two-path records).
function parseNameStatus(out: string): Map<string, ChangeStatus> {
  const parts = out.split('\0'), map = new Map<string, ChangeStatus>()
  for (let i = 0; i + 1 < parts.length; i += 2) map.set(parts[i + 1], STATUS[parts[i][0]] ?? 'modified')
  return map
}

// -z records: "<added>\t<deleted>\t<path>\0"; binary files report "-".
function parseNumstat(out: string): Map<string, [number | null, number | null]> {
  const map = new Map<string, [number | null, number | null]>()
  for (const rec of out.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec)
    if (m) map.set(m[3], [m[1] === '-' ? null : Number(m[1]), m[2] === '-' ? null : Number(m[2])])
  }
  return map
}

// Untracked (non-ignored) paths from `git status --porcelain=v1 -z`. With
// --untracked-files=all a trailing "/" only marks a nested repository.
function untrackedPaths(out: string): { files: string[]; repos: string[] } {
  const parts = out.split('\0'), files: string[] = [], repos: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (rec.startsWith('?? ')) (rec.endsWith('/') ? repos : files).push(rec.slice(3))
    else if (/^[RC]|^.[RC]/.test(rec)) i++ // index or worktree rename/copy carries a second path
  }
  return { files, repos }
}

/**
 * Diff the working tree (incl. commits the agent or auto-commit made) against
 * baseSha. Every call uses a throwaway copy of the index (untracked files are
 * intent-added there) and --no-optional-locks, so the real index is never
 * written or locked.
 * All git runs as the task's execution identity.
 */
export function captureChanges(repo: string, baseSha: string | null, id: Identity = {}, maxFiles = MAX_CHANGED_FILES): TaskChanges {
  const captured_at = new Date().toISOString()
  let tmpIndex: string | undefined
  try {
    const base = baseSha ?? headSha(repo, id)
      ?? git(repo, ['hash-object', '-t', 'tree', '--stdin'], id).trim() // unborn: empty tree
    tmpIndex = path.resolve(repo, git(repo, ['rev-parse', '--git-path', `forge-changes-${process.pid}-${Date.now()}.index`], id).trim())
    const realIndex = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'index'], id).trim())
    if (fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tmpIndex)
      // Keep the index mtime: git's racy-clean check compares file mtimes to it,
      // and a fresh mtime would hide same-size edits made in the commit's second.
      const st = fs.statSync(realIndex)
      fs.utimesSync(tmpIndex, st.atime, st.mtime)
      if (id.uid !== undefined && id.gid !== undefined) { try { fs.chownSync(tmpIndex, id.uid, id.gid) } catch { /* not root */ } }
    }
    const env = { GIT_INDEX_FILE: tmpIndex }
    const untracked = untrackedPaths(git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], id, env))
    // Bounded: never intent-add more than we could report. Nested repos can't be
    // intent-added (one with no commit fails the whole add), so list them as-is.
    const toAdd = untracked.files.slice(0, maxFiles + 1)
    for (let i = 0; i < toAdd.length; i += 200) git(repo, ['add', '-N', '--', ...toAdd.slice(i, i + 200)], id, env)
    const statuses = parseNameStatus(git(repo, ['diff', '--name-status', '-z', '--no-renames', base], id, env))
    const counts = parseNumstat(git(repo, ['diff', '--numstat', '-z', '--no-renames', base], id, env))
    for (const r of untracked.repos) statuses.set(r.slice(0, -1), 'added')
    const all = [...statuses.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const files = all.slice(0, maxFiles).map(([p, status]) => {
      const [added, deleted] = counts.get(p) ?? [null, null]
      return { path: p, status, added, deleted }
    })
    return { files, captured_at, base_sha: baseSha, truncated: all.length > maxFiles || untracked.files.length > toAdd.length }
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || 'unknown error').trim().slice(0, 500)
    return { files: [], captured_at, base_sha: baseSha, truncated: false, error: `capture failed: ${msg}` }
  } finally {
    if (tmpIndex) { try { fs.rmSync(tmpIndex, { force: true }) } catch { /* best effort */ } }
  }
}
