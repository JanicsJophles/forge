import { statfsSync } from 'node:fs'

/**
 * Free (available-to-unprivileged) bytes on the filesystem that contains
 * `path`. Built on fs.statfsSync so there is no new dependency.
 *
 * `bavail` (not `bfree`) is the block count usable by non-root processes —
 * the runner drops privileges to the forge user, so bavail is the figure
 * that actually governs whether git/the agent can write. Multiplied by the
 * fundamental block size `bsize`.
 *
 * Throws if the path cannot be stat'd (e.g. it does not exist). Callers are
 * expected to treat a throw as "unknown" and fail open rather than crash.
 */
export function freeDiskBytes(path: string): number {
  const stats = statfsSync(path)
  return stats.bavail * stats.bsize
}
