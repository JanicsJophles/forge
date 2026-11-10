import { execFileSync } from 'node:child_process'

export interface ChangedFile {
  /** Repo-relative path. For renames/copies this is the destination path. */
  path: string
  /** Git status letter: M/A/D/R…/C… for tracked changes, '?' for untracked. */
  status: string
}

/** Server-computed counts over the FULL changed-file set, keyed off the status
 * letter. `total` always equals the number of entries, so unknown status letters
 * (anything other than A/M/D/R/C/?) are reflected in `total` but no named bucket. */
export interface ChangedFilesSummary {
  added: number
  modified: number
  deleted: number
  renamed: number
  copied: number
  untracked: number
  total: number
}

/**
 * Cap for the per-response changed-file list. A pathological working tree (e.g.
 * thousands of untracked files) would otherwise return an unbounded JSON body on
 * the request thread; callers get the bounded list plus a `truncated` flag, while
 * the summary counts still describe the full set.
 */
export const CHANGED_FILES_LIMIT = 2_000

/**
 * Reduce a changed-file list to counts by Git status letter. Pure: no I/O. Keys
 * off the first character of each status (A/M/D/R/C/'?'); R100, C75, etc. collapse
 * to renamed/copied. Unknown letters are counted only in `total`.
 */
export function summarizeChangedFiles(files: ChangedFile[]): ChangedFilesSummary {
  const summary: ChangedFilesSummary = {
    added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, untracked: 0, total: 0,
  }
  for (const file of files) {
    summary.total += 1
    switch (file.status[0]) {
      case 'A': summary.added += 1; break
      case 'M': summary.modified += 1; break
      case 'D': summary.deleted += 1; break
      case 'R': summary.renamed += 1; break
      case 'C': summary.copied += 1; break
      case '?': summary.untracked += 1; break
      // Unknown status letters contribute to total only.
    }
  }
  return summary
}

/**
 * Bound a changed-file list to CHANGED_FILES_LIMIT entries. Pure: no I/O. Returns
 * the original array untouched when it is within bounds, otherwise the first
 * CHANGED_FILES_LIMIT entries with `truncated: true`.
 */
export function boundChangedFiles(files: ChangedFile[]): { changedFiles: ChangedFile[]; truncated: boolean } {
  if (files.length <= CHANGED_FILES_LIMIT) return { changedFiles: files, truncated: false }
  return { changedFiles: files.slice(0, CHANGED_FILES_LIMIT), truncated: true }
}

// Read probes run on the request thread: cap each at two seconds so a stuck
// Git process (including a filesystem monitor hook) cannot block it indefinitely.
const GIT_READ_TIMEOUT_MS = 2_000

// Bind every Git subprocess to its supplied cwd and strip inherited Git envvars,
// mirroring git.ts readGit so a hook or parent checkout cannot redirect the probe.
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES',
  ]) delete env[key]
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
  }
}

function readGit(args: string[], repoPath: string): string
function readGit(args: string[], repoPath: string, allowMissing: true): string | null
function readGit(args: string[], repoPath: string, allowMissing = false): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_READ_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: gitEnvironment(),
    })
  } catch (error) {
    // Only Git's explicit "not found" exit is optional. Spawn errors, signals,
    // timeouts and repository errors must still fail the review.
    const failure = error as { status?: number; signal?: string; code?: string }
    if (allowMissing && failure.status === 1 && !failure.signal && !failure.code) return null
    // Never attach the original error: child-process errors can contain stderr,
    // paths, URLs, and credentials, and callers may return this message verbatim.
    throw new Error('Git change inspection unavailable; read probe failed or exceeded 2000ms')
  }
}

// A missing HEAD alone is not proof of an unborn branch: validate the symbolic
// branch and confirm its ref is absent. Broken/detached HEADs remain failures.
function checkoutDiffArgs(repoPath: string): string[] {
  if (readGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repoPath, true) !== null) {
    return ['diff', '--no-ext-diff', '--no-textconv', 'HEAD']
  }
  const ref = readGit(['symbolic-ref', 'HEAD'], repoPath).trim()
  if (!ref.startsWith('refs/heads/') ||
      readGit(['show-ref', '--verify', '--quiet', ref], repoPath, true) !== null) {
    throw new Error('Git change inspection unavailable; invalid HEAD')
  }
  // With no HEAD, --cached uses Git's empty tree (also works with SHA-256).
  return ['diff', '--no-ext-diff', '--no-textconv', '--cached']
}

// Byte cap on the unified diff returned to a reviewer: a response body bound so a
// large refactor cannot stream an unbounded transcript back on the request thread.
// The caller receives the first CHANGES_PATCH_BYTE_CAP bytes plus a `truncated` flag.
export const CHANGES_PATCH_BYTE_CAP = 1_000_000

// Hard ceiling on the raw diff the probe will buffer before the cap is applied.
// Above this, execFileSync throws ENOBUFS and getChangesPatch reports the static
// failure (503 to the client) rather than materialising an enormous diff in memory.
const CHANGES_PATCH_MAX_BUFFER = 64 * 1024 * 1024

// Buffer-returning sibling of readGit for binary-safe diff capture: the diff is
// sliced on a byte boundary, so it must be read as bytes, not a utf8 string.
// Same env hardening, 2s timeout, SIGKILL, and static-message failure as readGit.
function readGitBuffer(args: string[], repoPath: string): Buffer {
  try {
    return execFileSync('git', args, {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_READ_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: CHANGES_PATCH_MAX_BUFFER,
      env: gitEnvironment(),
    })
  } catch {
    throw new Error('Git change inspection unavailable; read probe failed or exceeded 2000ms')
  }
}

// Diff/show probes disable external diff and textconv: repository configuration
// must not execute helpers or substitute their output during review reads.
// Accept only recorded object IDs, never arbitrary revisions or Git options.
// --root compares a parentless commit with the empty tree; merge commits use
// their first parent so file and patch responses describe the same footprint.
function commitArgs(commitSha: string): string[] {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(commitSha)) {
    throw new Error('Git change inspection unavailable; invalid commit ID')
  }
  return ['show', '--no-ext-diff', '--no-textconv', '--format=', '--root', '--diff-merges=first-parent', commitSha]
}

/**
 * With a commit ID, return that commit's diff (including root commits). Otherwise,
 * produce the bounded unified diff of a checkout's tracked changes against HEAD —
 * the same tracked footprint getChangedFiles lists, as a reviewable patch. For an
 * unborn HEAD, compare staged content against the empty tree. Read-only probes
 * use argument arrays, each bounded to 2s and SIGKILLed, with core.quotepath=false so non-ASCII paths stay readable.
 * The returned patch is capped at CHANGES_PATCH_BYTE_CAP bytes (first bytes kept,
 * `truncated: true` when the cap bit). Throws a static-message Error on failure;
 * never surfaces raw Git stderr.
 */
export function getChangesPatch(repoPath: string, commitSha?: string | null): { patch: string; truncated: boolean } {
  const diff = readGitBuffer(['-c', 'core.quotepath=false', ...(commitSha != null ? [...commitArgs(commitSha), '--no-color', '--'] : [...checkoutDiffArgs(repoPath), '--no-color'])], repoPath)
  if (diff.length <= CHANGES_PATCH_BYTE_CAP) {
    return { patch: diff.toString('utf8'), truncated: false }
  }
  return { patch: diff.subarray(0, CHANGES_PATCH_BYTE_CAP).toString('utf8'), truncated: true }
}

// `git diff --name-status -z HEAD` emits NUL-terminated fields. A normal entry is
// two fields (status, path); a rename/copy is three (status, old, new). Using -z
// keeps paths with spaces or newlines intact.
function parseNameStatusZ(output: string, into: Map<string, string>): void {
  const tokens = output.split('\0')
  let i = 0
  while (i < tokens.length) {
    const status = tokens[i]
    if (!status) {
      i += 1
      continue
    }
    const code = status[0]
    if (code === 'R' || code === 'C') {
      // status, old path, new path — report the destination.
      const destination = tokens[i + 2]
      if (destination) into.set(destination, status)
      i += 3
    } else {
      const path = tokens[i + 1]
      if (path) into.set(path, status)
      i += 2
    }
  }
}

// `git status --porcelain -z` emits `XY path\0` per entry, with a trailing
// `old\0` field for renames/copies. Only untracked entries ('??') are harvested
// here; tracked modifications already come from the diff. Rename origin fields
// are skipped so entry indexing stays aligned.
function parsePorcelainUntrackedZ(output: string, into: Map<string, string>): void {
  const tokens = output.split('\0')
  let i = 0
  while (i < tokens.length) {
    const entry = tokens[i]
    if (!entry) {
      i += 1
      continue
    }
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    const hasRenameOrigin = x === 'R' || x === 'C' || y === 'R' || y === 'C'
    i += hasRenameOrigin ? 2 : 1
    if (x === '?' && y === '?' && path && !into.has(path)) {
      into.set(path, '?')
    }
  }
}

/**
 * With a commit ID, list only that commit's changes. Otherwise, compute
 * the concrete file footprint of a checkout: tracked changes against
 * HEAD plus untracked files. Runs only read-only Git probes (execFileSync with
 * an arg array, never a shell string), each bounded to 2s and SIGKILLed, and
 * never surfaces raw Git stderr. Throws a static-message Error on failure.
 */
export function getChangedFiles(repoPath: string, commitSha?: string | null): ChangedFile[] {
  const files = new Map<string, string>()
  if (commitSha != null) {
    parseNameStatusZ(readGit([...commitArgs(commitSha), '--name-status', '-z', '--'], repoPath), files)
  } else {
    parseNameStatusZ(readGit([...checkoutDiffArgs(repoPath), '--name-status', '-z', '--'], repoPath), files)
    parsePorcelainUntrackedZ(readGit(['status', '--porcelain', '-z', '--untracked-files=all'], repoPath), files)
  }
  return [...files].map(([path, status]) => ({ path, status }))
}
