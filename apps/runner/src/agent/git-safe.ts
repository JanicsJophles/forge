import { execFileSync } from 'node:child_process'
import { isAbsolute, relative } from 'node:path'

// A fixed, trusted PATH. NEVER inherited from the parent (pm2/root) process, whose
// PATH can point under /root or at unexpected shims. Used for every git/CLI call a
// read-only task triggers.
export const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

// Caps on the per-file and total bytes the overlay step will copy from the real
// working tree into the disposable copy. Bounds both runtime and memory, and stops
// a giant tracked blob from stalling preparation.
export const PER_FILE_COPY_CAP = 64 * 1024 * 1024 // 64 MiB
export const TOTAL_COPY_CAP = 1024 * 1024 * 1024 // 1 GiB

// git invocation hardening. `-c` overrides beat any repo-local config AND propagate
// to subprocesses (upload-pack, etc.) via GIT_CONFIG_PARAMETERS, so a repo whose
// owner set a malicious core.fsmonitor / hook cannot get code to run when we read it.
export const GIT_HARDENING_FLAGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'protocol.file.allow=always',
]

export interface GitRunOpts {
  uid?: number
  gid?: number
  // Absolute path to trust for ownership (`-c safe.directory=...`) when we read a
  // repo owned by a different user (the real repo, read as the read-only uid).
  safeDir?: string
}

// A minimal environment for git. Derived from a fixed allowlist — NEVER from
// process.env — so inherited tokens (GH_TOKEN, ANTHROPIC_API_KEY, …) can never leak
// into a git subprocess, and HOME/global/system config are neutralised.
export function minimalGitEnv(home?: string): NodeJS.ProcessEnv {
  return {
    PATH: SAFE_PATH,
    HOME: home ?? '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}

// Run git with the hardening flags, a minimal env, and (optionally) dropped
// privileges. Throws on non-zero exit.
export function safeGit(args: string[], cwd: string, opts: GitRunOpts = {}): string {
  const flags = [...GIT_HARDENING_FLAGS]
  if (opts.safeDir) flags.push('-c', `safe.directory=${opts.safeDir}`)
  return execFileSync('git', [...flags, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: minimalGitEnv(),
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
  }).trim()
}

// True when `p` is `root` itself or strictly contained within it. Used to prove an
// overlay never escapes the real-repo / copy roots via symlinks or `..`.
export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// A repo-relative path is only safe to overlay if it is relative and has no `..` or
// empty components. (Absolute paths and traversal are rejected outright.)
export function isSafeRelPath(rel: string): boolean {
  if (!rel || isAbsolute(rel)) return false
  return rel.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
