import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants as FS,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { AgentProvider } from '@forge/shared'
import { spawnContained } from './contained.js'
import type { TaskCgroup } from './cgroup.js'
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

// Options that let the RUNNER (which imports config) steer preparation without this
// module importing config — so readonly.ts stays importable by tests that must not
// trigger config.ts's process.exit when ALLOWED_REPO_PATHS is unset.
export interface PrepOpts {
  // Wall-clock cap for the prep worker. The runner passes config.readonlyPrepTimeoutMs.
  timeoutMs?: number
  // Called with the spawned prep child so the runner can register it for cancellation
  // (finding G): a DELETE arriving during the up-to-two-minute prep must kill it.
  onSpawn?: (child: ChildProcess) => void
  // Move the prep child into the task's cgroup so a cgroup kill reaps it and anything
  // it forks (finding A). No-op when the runner has no cgroup (non-root / CI).
  cgroup?: TaskCgroup
  requireReadOnlySource?: boolean
}

// The runner's own temp-dir prefix for read-only copies. Distinct from the test
// fixtures' prefix so the startup sweep can never touch an in-progress test.
export const READONLY_TMP_PREFIX = 'forge-ro-run-'

const DEFAULT_PREP_TIMEOUT_MS = 120_000
const DEFAULT_REPORT_TIMEOUT_MS = 30_000

// Resolve a sibling worker module. In tsx/dev it is a `.ts` (needs the tsx loader);
// in a compiled build it is the emitted `.js`.
function workerInvocation(stem: string): { args: string[] } {
  const here = fileURLToPath(import.meta.url)
  const isTs = here.endsWith('.ts')
  const worker = join(dirname(here), isTs ? `${stem}.ts` : `${stem}.js`)
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
  opts: PrepOpts = {},
): Promise<PreparedCopy> {
  return new Promise((resolve, reject) => {
    const { args } = workerInvocation('prep-copy')
    const launchOpts = { cwd: process.cwd(), env: minimalGitEnv(identity.home), uid: identity.uid, gid: identity.gid }
    const workerArgs = [...args, realRepo, copyRepo, ...(opts.requireReadOnlySource ? ['--require-read-only-source'] : [])]
    const child = opts.cgroup
      ? spawnContained(opts.cgroup, process.execPath, workerArgs, launchOpts)
      : spawn(process.execPath, workerArgs, { ...launchOpts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })

    opts.onSpawn?.(child)

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
      if (opts.cgroup) opts.cgroup.killAll()
      else if (typeof child.pid === 'number') { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
      finish(() => reject(new Error('read-only copy preparation timed out')))
    }, opts.timeoutMs && opts.timeoutMs >= 1 && opts.timeoutMs <= 2 ** 31 - 1 ? opts.timeoutMs : DEFAULT_PREP_TIMEOUT_MS)

    const append = (value: string, chunk: Buffer): string => (value + chunk.toString()).slice(-1024 * 1024)
    child.stdout!.on('data', d => { out = append(out, d) })
    child.stderr!.on('data', d => { err = append(err, d) })
    child.on('error', e => finish(() => reject(e)))
    child.on('exit', () => { opts.cgroup?.killAll() })
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
 * env (no inherited tokens) and the hardening flags (filters/fsmonitor/hooks/gpg/
 * diff-external all neutralised), pins the worktree to the copy, and drops to the
 * account that owns the copy.
 *
 * This is SYNCHRONOUS and must only be called where blocking is acceptable (it is
 * the body of the report WORKER process — see report-copy.ts). The runner never
 * calls it directly in its event loop; it uses reportReadOnlyChangesAsync instead
 * (finding B: a planted filter could otherwise block the runner for the git call).
 */
export function reportReadOnlyChanges(copyRepo: string, baseHead: string, identity: RunOpts = {}): string {
  const opts = { uid: identity.uid, gid: identity.gid, worktree: copyRepo }
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
      const log = safeGit(
        ['log', '--no-ext-diff', '--no-textconv', '--name-status', '--oneline', `${baseHead}..HEAD`],
        copyRepo,
        opts,
      )
      lines.push('new commits in copy (discarded):', log)
    }
  } catch {
    // HEAD unreadable — nothing to add.
  }
  return lines.join('\n')
}

export interface ReportAsyncOpts extends RunOpts {
  timeoutMs?: number
  onSpawn?: (child: ChildProcess) => void
  cgroup?: TaskCgroup
  killTree?: () => void
}

/**
 * Run the post-run report in a THROWAWAY CHILD PROCESS (finding B). The report means
 * running `git status`/`git log` inside a tree the agent fully controls; doing that
 * synchronously in the runner's close handler let a planted `filter.<n>.process`
 * (or fsmonitor, gpg.program, …) block the whole event loop. Here the work happens in
 * a child that already dropped to the read-only uid with a minimal env, and the
 * parent enforces a hard timeout + whole-tree kill. Never rejects: on any failure or
 * timeout it resolves with a short diagnostic so the run can still complete.
 */
export function reportReadOnlyChangesAsync(
  copyRepo: string,
  baseHead: string,
  opts: ReportAsyncOpts = {},
): Promise<string> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      const { args } = workerInvocation('report-copy')
      const launchOpts = { cwd: process.cwd(), env: minimalGitEnv(opts.home), uid: opts.uid, gid: opts.gid }
      child = opts.cgroup
        ? spawnContained(opts.cgroup, process.execPath, [...args, copyRepo, baseHead], launchOpts)
        : spawn(process.execPath, [...args, copyRepo, baseHead], { ...launchOpts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve(`(could not run read-only report: ${e instanceof Error ? e.message : 'spawn failed'})`)
      return
    }

    opts.onSpawn?.(child)

    let out = ''
    let err = ''
    let done = false
    const finish = (value: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const killTree = (): void => {
      if (opts.cgroup) opts.cgroup.killAll()
      else if (typeof child.pid === 'number') { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
      opts.killTree?.()
    }

    const timer = setTimeout(() => {
      killTree()
      finish('(read-only report timed out)')
    }, opts.timeoutMs && opts.timeoutMs >= 1 && opts.timeoutMs <= 2 ** 31 - 1 ? opts.timeoutMs : DEFAULT_REPORT_TIMEOUT_MS)

    const append = (value: string, chunk: Buffer): string => (value + chunk.toString()).slice(0, 1024 * 1024)
    child.stdout?.on('data', d => { out = append(out, d) })
    child.stderr?.on('data', d => { err = append(err, d) })
    child.on('error', () => finish('(could not run read-only report)'))
    child.on('exit', () => { opts.cgroup?.killAll() })
    child.on('close', code => {
      finish(code === 0 ? out : (out || `(read-only report failed: ${err.trim() || `exit ${code}`})`))
    })
  })
}

// A protected leaf is insufficient if an agent owns an ancestor and can rename
// the leaf. Reject links and writable ancestors before privileged provisioning.
function assertProtectedDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error('read-only path must be absolute')
  const owner = process.getuid!()
  for (let current = path; ; current = dirname(current)) {
    const st = lstatSync(current)
    const stickyRoot = st.uid === 0 && (st.mode & 0o1000) !== 0
    if (!st.isDirectory() || (st.uid !== owner && st.uid !== 0) || ((st.mode & 0o022) !== 0 && !stickyRoot)) {
      throw new Error('read-only path has an unprotected ancestor')
    }
    if (current === dirname(current)) break
  }
}

/** Create the base only through protected real directories, never a planted link. */
export function prepareReadOnlyBase(base: string): void {
  if (!isAbsolute(base)) throw new Error('read-only base must be absolute')
  const absent: string[] = []
  let current = base
  for (;;) {
    try { lstatSync(current); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      absent.unshift(current)
      current = dirname(current)
    }
  }
  assertProtectedDirectory(current)
  for (const directory of absent) mkdirSync(directory, { mode: 0o711 })
  assertProtectedDirectory(base)
  if (lstatSync(base).uid !== process.getuid!()) throw new Error('read-only base must be runner-owned')
  chmodSync(base, 0o711)
}

export interface EphemeralHome {
  // Per-task HOME inside the task dir — discarded with the copy. Prevents a read-only
  // task from planting ~/.gitconfig / ~/.config/... for the NEXT task (finding E).
  home: string
  // Where the provider's auth was copied to (0700, owned by the read-only account),
  // if an auth source was supplied. Passed as CLAUDE_CONFIG_DIR / CODEX_HOME.
  configDir?: string
}

/**
 * Provision an EPHEMERAL HOME for a read-only task inside its own task dir (finding
 * E), optionally seeding it with a PER-TASK COPY of the provider's auth (finding F).
 *
 * The real auth source stays pristine and root-owned; we copy it (as root) into the
 * task dir, then hand the whole ephemeral tree to the read-only account at mode 0700.
 * The copy is discarded with the task dir, so a read-only run cannot persist anything
 * into a location a later task will read, and no credentials are left world-readable.
 */
export function provisionReadOnlyHome(
  tmpRoot: string,
  identity: RunOpts,
  provider: AgentProvider,
  authSrc?: string,
): EphemeralHome {
  // The parent must still exclusively own the task root. In production the
  // runner is root; tests may run as their own unprivileged uid.
  const owner = process.getuid!()
  assertProtectedDirectory(tmpRoot)
  const root = lstatSync(tmpRoot)
  if (!root.isDirectory() || root.uid !== owner || (root.mode & 0o077) !== 0) {
    throw new Error('read-only home requires a private runner-owned task directory')
  }
  const home = join(tmpRoot, 'home')
  mkdirSync(home, { mode: 0o700 }) // exclusive: never reuse a planted directory/link

  let configDir: string | undefined
  let credential: string | undefined
  if (authSrc) {
    assertProtectedDirectory(authSrc)
    const source = lstatSync(authSrc)
    if (!source.isDirectory() || source.uid !== owner || (source.mode & 0o022) !== 0) {
      throw new Error('read-only auth must come from a protected runner-owned directory')
    }
    // Copy only the provider credential, never user config, hooks, plugins,
    // symlinks or arbitrary files from the account's config tree.
    const name = provider === 'claude' ? '.credentials.json' : 'auth.json'
    const fd = openSync(join(authSrc, name), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
    let data: Buffer
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.uid !== owner || (st.mode & 0o022) !== 0 || st.size > 1024 * 1024) {
        throw new Error('read-only credential must be a protected regular file under 1 MiB')
      }
      data = readFileSync(fd)
      if (data.length > 1024 * 1024) throw new Error('read-only credential exceeds 1 MiB')
    } finally { closeSync(fd) }
    configDir = join(home, provider === 'claude' ? '.claude' : '.codex')
    mkdirSync(configDir, { mode: 0o700 })
    credential = join(configDir, name)
    writeFileSync(credential, data, { mode: 0o600, flag: 'wx' })
  }
  if (identity.uid !== undefined && identity.gid !== undefined) {
    if (credential) lchownSync(credential, identity.uid, identity.gid)
    if (configDir) lchownSync(configDir, identity.uid, identity.gid)
    lchownSync(home, identity.uid, identity.gid)
  }
  return { home, configDir }
}

/**
 * Remove a read-only task dir after the run (finding D). The copy's CONTENTS are
 * deleted by a child running as the READ-ONLY uid with `rm -rf --one-file-system`, so
 * root never recursively removes a tree the read-only account could have swapped for a
 * symlink mid-delete (the dir→symlink race), and the delete can never cross a mount.
 * Root then only `rmdir`s the now-empty top dir — rmdir never recurses, so it cannot
 * be redirected into a host tree. NEVER rejects: cleanup failure must not crash the
 * runner (finding D); a dir left behind is reaped by the startup sweep.
 */
export function cleanupReadOnlyCopy(tmpRoot: string, identity: RunOpts = {}): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      // rmdir only (non-recursive): removes the empty top dir, follows nothing. If the
      // child left anything behind, this throws and we leave the dir for the sweep.
      try { rmdirSync(tmpRoot) } catch { /* not empty / already gone — sweep handles it */ }
      resolve()
    }

    let entries: string[]
    try {
      entries = readdirSync(tmpRoot)
    } catch {
      finish()
      return
    }
    if (entries.length === 0) {
      finish()
      return
    }

    const targets = entries.map(e => join(tmpRoot, e))
    let child: ChildProcess
    try {
      child = spawn('/bin/rm', ['-rf', '--one-file-system', '--', ...targets], {
        stdio: 'ignore',
        ...(identity.uid !== undefined ? { uid: identity.uid } : {}),
        ...(identity.gid !== undefined ? { gid: identity.gid } : {}),
      })
    } catch {
      finish()
      return
    }

    const guard = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      finish()
    }, 30_000)
    guard.unref?.()
    child.on('error', () => { clearTimeout(guard); finish() })
    child.on('close', () => { clearTimeout(guard); finish() })
  })
}

/** Sweep stale task directories with the same unprivileged, bounded cleanup as a run. */
export async function sweepStaleReadOnlyDirs(base: string = tmpdir(), allowedUids: number[] = [], identity: RunOpts = {}): Promise<number> {
  let entries: string[]
  try { entries = readdirSync(base) } catch { return 0 }
  let swept = 0
  for (const name of entries) {
    if (!name.startsWith(READONLY_TMP_PREFIX)) continue
    const full = join(base, name)
    try {
      const st = lstatSync(full)
      if (!st.isDirectory() || (allowedUids.length > 0 && !allowedUids.includes(st.uid))) continue
      if (identity.uid === undefined || identity.gid === undefined) continue
      await cleanupReadOnlyCopy(full, identity)
      swept++
    } catch { /* best effort */ }
  }
  return swept
}
