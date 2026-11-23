import { spawn } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { safeGit, minimalGitEnv } from './git-safe.js'

export interface RunOpts {
  uid?: number
  gid?: number
  home?: string
}

export interface PreparedCopy {
  // HEAD of the disposable copy right after preparation, used later to report any
  // commits the agent created in the copy.
  baseHead: string
}

// The runner's own temp-dir prefix for read-only copies. Distinct from the test
// fixtures' prefix so the startup sweep can never touch an in-progress test.
export const READONLY_TMP_PREFIX = 'forge-ro-run-'

// How long preparation may run before we give up and tear the worker down. The
// overlay is bounded by size caps, so this only trips on a pathological repo.
const PREP_TIMEOUT_MS = Number(process.env.READONLY_PREP_TIMEOUT_MS ?? 120_000)

// Resolve the sibling worker module. In tsx/dev it is a `.ts` (needs the tsx loader);
// in a compiled build it is the emitted `.js`.
function workerInvocation(): { args: string[] } {
  const here = fileURLToPath(import.meta.url)
  const isTs = here.endsWith('.ts')
  const worker = join(dirname(here), isTs ? 'prep-copy.ts' : 'prep-copy.js')
  return { args: isTs ? ['--import', 'tsx', worker] : [worker] }
}

/**
 * Build a disposable copy of `realRepo` at `copyRepo` for a read-only task.
 *
 * Preparation runs in a SEPARATE CHILD PROCESS that drops to the read-only account
 * (uid/gid) with a minimal env — so the clone, the reads of the real working tree,
 * and every overlay WRITE happen with the unprivileged account's rights, never as
 * root. The event loop is never blocked: the child is awaited asynchronously and
 * torn down (whole process group) on timeout. Any failure rejects so the caller
 * fails the task before the agent starts.
 */
export function prepareReadOnlyCopy(
  realRepo: string,
  copyRepo: string,
  identity: RunOpts = {},
): Promise<PreparedCopy> {
  return new Promise((resolve, reject) => {
    const { args } = workerInvocation()
    const child = spawn(process.execPath, [...args, realRepo, copyRepo], {
      // Run the preparation UNPRIVILEGED. cwd stays in the runner package so the tsx
      // loader resolves in dev; git uses absolute paths so cwd is irrelevant to it.
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: minimalGitEnv(identity.home),
      detached: true, // own group → we can kill the whole tree on timeout
      ...(identity.uid !== undefined ? { uid: identity.uid } : {}),
      ...(identity.gid !== undefined ? { gid: identity.gid } : {}),
    })

    let out = ''
    let err = ''
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      if (typeof child.pid === 'number') {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      }
      finish(() => reject(new Error('read-only copy preparation timed out')))
    }, PREP_TIMEOUT_MS)

    child.stdout.on('data', d => { out += d.toString() })
    child.stderr.on('data', d => { err += d.toString() })
    child.on('error', e => finish(() => reject(e)))
    child.on('close', code => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`read-only copy preparation failed (exit ${code}): ${err.trim() || 'no output'}`))
          return
        }
        const lastLine = out.trim().split('\n').pop() ?? ''
        try {
          const parsed = JSON.parse(lastLine) as { baseHead?: unknown }
          if (typeof parsed.baseHead !== 'string' || !parsed.baseHead) {
            throw new Error('missing baseHead')
          }
          resolve({ baseHead: parsed.baseHead })
        } catch {
          reject(new Error('read-only copy preparation returned a malformed result'))
        }
      })
    })
  })
}

/**
 * Describe what the agent changed inside the disposable copy — INFORMATION ONLY.
 * The real repo is never inspected or touched here. Every git call uses a MINIMAL
 * env (no inherited tokens) and the hardening flags (so a core.fsmonitor the agent
 * planted in the copy cannot run), and drops to the account that owns the copy.
 */
export function reportReadOnlyChanges(copyRepo: string, baseHead: string, identity: RunOpts = {}): string {
  const opts = { uid: identity.uid, gid: identity.gid }
  const lines: string[] = []
  try {
    const status = safeGit(['status', '--porcelain=v2', '--ignored'], copyRepo, opts)
    lines.push(status ? status : '(copy working tree clean)')
  } catch (err) {
    lines.push(`(could not read copy status: ${err instanceof Error ? err.message : 'unknown error'})`)
  }
  try {
    const head = safeGit(['rev-parse', 'HEAD'], copyRepo, opts)
    if (head !== baseHead) {
      const log = safeGit(['log', '--name-status', '--oneline', `${baseHead}..HEAD`], copyRepo, opts)
      lines.push('new commits in copy (discarded):', log)
    }
  } catch {
    // HEAD unreadable — nothing to add.
  }
  return lines.join('\n')
}

/**
 * Remove any read-only copy temp dirs left behind by a previous process (crash, pm2
 * restart, OOM kill). Called once at startup, when no task is running.
 */
export function sweepStaleReadOnlyDirs(base: string = tmpdir()): number {
  let removed = 0
  let entries: string[]
  try {
    entries = readdirSync(base)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (!name.startsWith(READONLY_TMP_PREFIX)) continue
    try {
      rmSync(join(base, name), { recursive: true, force: true })
      removed++
    } catch {
      // Best-effort; a dir we cannot remove is not fatal to startup.
    }
  }
  return removed
}
