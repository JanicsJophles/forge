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
// owner set a malicious core.fsmonitor / hook / filter / diff driver cannot get code
// to run when we read it. These are the STATIC overrides; per-repo filter drivers are
// neutralised dynamically in safeGit (see filterNeutralizationFlags).
export const GIT_HARDENING_FLAGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'protocol.file.allow=always',
  // A planted log.showSignature + gpg.program would execute gpg.program when we run
  // `git log`; pin both off (findings B).
  '-c', 'log.showSignature=false',
  '-c', 'gpg.program=false',
  // An external diff driver / textconv executes a program while diffing; neutralise
  // the config-level vector (per-command --no-ext-diff/--no-textconv handle the rest).
  '-c', 'diff.external=',
]

export interface GitRunOpts {
  uid?: number
  gid?: number
  // Absolute path to trust for ownership (`-c safe.directory=...`) when we read a
  // repo owned by a different user (the real repo, read as the read-only uid).
  safeDir?: string
  // When set, pin `core.worktree` to this absolute path so a repo-local
  // `core.worktree` (pointing git's working tree at an external dir) cannot redirect
  // reads/writes. Pass the repo root (== cwd) — correct for a standard non-bare repo.
  worktree?: string
}

// Enumerate every `filter.<name>.*` driver configured in the repo at `cwd` and return
// `-c` overrides that BLANK each driver's clean/smudge/process commands and clear its
// `required` flag. A repo-local `filter.<n>.process` + a `.gitattributes filter=<n>`
// otherwise executes code during clone-checkout / diff / status; blanking the commands
// stops execution and `required=false` stops git erroring on the now-empty driver.
// Reading config names never executes a filter, so this probe is itself safe.
export function filterNeutralizationFlags(cwd: string, opts: GitRunOpts = {}): string[] {
  let out = ''
  try {
    out = execFileSync('git', [...GIT_HARDENING_FLAGS, 'config', '--get-regexp', '^filter\\.'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: minimalGitEnv(),
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
    })
  } catch (error) {
    // Git uses exit 1 for no matching keys; all other failures are unsafe.
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) return []
    throw new Error('cannot enumerate git filters', { cause: error })
  }
  const names = new Set<string>()
  for (const line of out.split('\n')) {
    const m = /^filter\.(.+)\.(clean|smudge|process|required)\b/.exec(line)
    if (m) names.add(m[1])
  }
  const flags: string[] = []
  for (const n of names) {
    flags.push(
      '-c', `filter.${n}.clean=`,
      '-c', `filter.${n}.smudge=`,
      '-c', `filter.${n}.process=`,
      '-c', `filter.${n}.required=false`,
    )
  }
  return flags
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
// privileges. Throws on non-zero exit. Every call also neutralises the repo's own
// filter drivers (findings B, C) so a planted clean/smudge/process filter can never
// execute while we clone / diff / status / report.
export function safeGit(args: string[], cwd: string, opts: GitRunOpts = {}): string {
  const flags = [...GIT_HARDENING_FLAGS]
  if (opts.safeDir) flags.push('-c', `safe.directory=${opts.safeDir}`)
  if (opts.worktree) flags.push('-c', `core.worktree=${opts.worktree}`)
  flags.push(...filterNeutralizationFlags(cwd, opts))
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
