import { execFileSync } from 'node:child_process'

export interface ChangedFile {
  /** Repo-relative path. For renames/copies this is the destination path. */
  path: string
  /** Git status letter: M/A/D/R…/C… for tracked changes, '?' for untracked. */
  status: string
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

function readGit(args: string[], repoPath: string): string {
  try {
    return execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_READ_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: gitEnvironment(),
    })
  } catch {
    // Never attach the original error: child-process errors can contain stderr,
    // paths, URLs, and credentials, and callers may return this message verbatim.
    throw new Error('Git change inspection unavailable; read probe failed or exceeded 2000ms')
  }
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
 * Compute the concrete file footprint of a checkout: tracked changes against
 * HEAD plus untracked files. Runs only read-only Git probes (execFileSync with
 * an arg array, never a shell string), each bounded to 2s and SIGKILLed, and
 * never surfaces raw Git stderr. Throws a static-message Error on failure.
 */
export function getChangedFiles(repoPath: string): ChangedFile[] {
  const files = new Map<string, string>()
  parseNameStatusZ(readGit(['diff', '--name-status', '-z', 'HEAD'], repoPath), files)
  parsePorcelainUntrackedZ(readGit(['status', '--porcelain', '-z'], repoPath), files)
  return [...files].map(([path, status]) => ({ path, status }))
}
