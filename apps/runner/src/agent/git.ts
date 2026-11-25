import { execFile, execFileSync } from 'node:child_process'
import { config } from '../config.js'
import { redact } from './redact.js'
import { resolveAllowedRepo } from './repo-path.js'

// The runner itself is root. Every git command here runs as the agent account (uid/gid below) inside a clone
// that agents write, including its .git/config and .git/hooks, so a hook or core.fsmonitor an agent plants can
// only ever run as the agent. No command goes through a shell: arguments are passed as an argv array.
export interface RunOpts {
  uid: number
  gid: number
  env?: NodeJS.ProcessEnv
}

function git(args: string[], cwd: string, opts: RunOpts): string {
  if (!Number.isInteger(opts.uid) || opts.uid === 0) throw new Error('git must run as the non-root agent account')
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    uid: opts.uid,
    gid: opts.gid,
    ...(opts.env ? { env: opts.env } : {}),
  }).trim()
}

/** Runs a command as the agent account (never uid 0, argv only) without blocking the event loop. */
export function execAsAgent(file: string, args: string[], cwd: string, opts: RunOpts): Promise<string> {
  if (!Number.isInteger(opts.uid) || opts.uid === 0) return Promise.reject(new Error(`${file} must run as the non-root agent account`))
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      uid: opts.uid,
      gid: opts.gid,
      ...(opts.env ? { env: opts.env } : {}),
    }, (err, stdout, stderr) => {
      // The message reaches the task log: credentials in it are masked.
      if (err) reject(new Error(`${file} ${args[0]} failed: ${redact(String(stderr || err.message).trim(), 500)}`))
      else resolve(stdout.trim())
    })
  })
}

/** git as the agent account, without blocking the event loop: for fetches and worktree commands. */
export function gitAsync(args: string[], cwd: string, opts: RunOpts): Promise<string> {
  return execAsAgent('git', args, cwd, opts)
}

export function getCurrentBranch(repoPath: string, opts: RunOpts): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, opts)
}

/**
 * Best-effort: make sure the clone is owned by the agent account. The runner historically ran `git pull` as
 * root, which left root-owned files that later broke the agent's own git add / commit.
 *
 * This chown runs as root, so the path is re-checked right here (a canonical, non-symlink directory inside
 * ALLOWED_REPO_PATHS) and chown never follows a symlink: -P walks the tree physically and -h changes a link
 * itself, so a link an agent plants inside the clone (or swaps in for it) cannot point the chown at /etc.
 */
function ensureRepoOwnership(repoPath: string, opts: RunOpts): void {
  const repo = resolveAllowedRepo(repoPath, config.allowedRepoPaths)
  if (!repo) throw new Error('repo path is not in ALLOWED_REPO_PATHS')
  try {
    execFileSync('chown', ['-R', '-P', '-h', '--', `${opts.uid}:${opts.gid}`, repo], { stdio: 'ignore' })
  } catch {
    // not running as root, or a file vanished mid-walk: neither is a real error
  }
}

export function gitPull(repoPath: string, opts: RunOpts): void {
  ensureRepoOwnership(repoPath, opts)
  // No upstream (e.g. a fresh local repo) makes this a no-op. As before, a failed pull is not fatal either:
  // the agent starts on the clone as it is.
  try {
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoPath, opts)
    if (upstream) git(['pull', '--ff-only'], repoPath, opts)
  } catch {
    // no upstream, or the pull failed
  }
}

export function gitCommit(repoPath: string, message: string, opts: RunOpts): string {
  // Stage tracked modifications only; the agent stages new files itself if it wants them.
  try {
    git(['add', '-u'], repoPath, opts)
  } catch {
    // Nothing tracked was modified
  }

  try {
    git(['commit', '-m', message], repoPath, opts)
  } catch (err: any) {
    const out = `${err?.stdout ?? ''}${err?.stderr ?? ''}`
    if (out.includes('nothing to commit')) return ''
    throw err
  }

  return git(['rev-parse', 'HEAD'], repoPath, opts)
}

export function hasUncommittedChanges(repoPath: string, opts: RunOpts): boolean {
  return git(['status', '--porcelain'], repoPath, opts).length > 0
}
