import { execFileSync } from 'node:child_process'
import { gitEnvironment } from './git.js'

export interface AheadBehind {
  ahead: number
  behind: number
}

// Read probes run on the request thread: cap at two seconds so a stuck Git
// process (including a filesystem monitor hook) cannot block it indefinitely.
const GIT_READ_TIMEOUT_MS = 2_000

/**
 * Compare the checkout's HEAD against its tracked upstream using only refs that
 * are already present locally — this performs NO `git fetch`, so the counts
 * reflect the last-fetched state of the remote tracking ref, not the live remote.
 *
 * `git rev-list --left-right --count @{u}...HEAD` prints "<behind>\t<ahead>":
 * the left side (`@{u}`) counts commits the upstream has that HEAD lacks (behind),
 * the right side (`HEAD`) counts commits HEAD has that the upstream lacks (ahead).
 *
 * Returns null — never throws — when the branch has no configured upstream
 * (`@{u}` is unresolvable), HEAD is detached, the probe times out, or Git fails
 * for any other reason. A single unreadable repo must never fail the whole
 * /repos response, and Git's stderr (which can contain remote URLs and
 * credentials) must never be surfaced to callers that persist or return it.
 */
export function getAheadBehind(repoPath: string): AheadBehind | null {
  let output: string
  try {
    output = execFileSync(
      'git',
      ['rev-list', '--left-right', '--count', '@{u}...HEAD'],
      {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GIT_READ_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: gitEnvironment(),
      },
    ).trim()
  } catch {
    return null
  }

  const parts = output.split(/\s+/)
  if (parts.length !== 2) return null
  const behind = Number(parts[0])
  const ahead = Number(parts[1])
  if (!parts.every(part => /^\d+$/.test(part)) ||
    !Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead)) return null
  return { ahead, behind }
}
