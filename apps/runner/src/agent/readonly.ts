import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

interface RunOpts {
  uid?: number
  gid?: number
}

function git(args: string[], cwd: string, opts: RunOpts = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
  }).trim()
}

// Split a NUL-delimited git output into non-empty path entries.
function splitZ(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

// Overlay one working-tree path from the real repo onto the copy. Reads only the
// real repo; writes only the copy. Reproduces regular files (with mode) and
// symlinks; a path missing in the real working tree (a deletion) is removed from
// the copy so the copy's tree matches what the agent would see.
function overlayPath(realRepo: string, copyRepo: string, rel: string): void {
  const src = join(realRepo, rel)
  const dest = join(copyRepo, rel)
  let st
  try {
    st = lstatSync(src)
  } catch {
    // Not present in the real working tree → it was deleted; mirror the deletion.
    rmSync(dest, { force: true })
    return
  }
  if (st.isDirectory()) return // git never emits bare directories here; ignore defensively
  mkdirSync(dirname(dest), { recursive: true })
  rmSync(dest, { force: true })
  if (st.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dest)
    return
  }
  copyFileSync(src, dest)
  chmodSync(dest, st.mode & 0o777)
}

export interface PreparedCopy {
  // HEAD of the disposable copy right after preparation, used later to report any
  // commits the agent created in the copy.
  baseHead: string
}

/**
 * Build a disposable copy of `realRepo` at `copyRepo` for a read-only task.
 *
 * The agent NEVER runs in the real repo. We:
 *   1. `git clone --no-local --no-hardlinks` the committed history only,
 *   2. overlay the real repo's uncommitted tracked + untracked, NON-ignored files
 *      so the agent sees the working state (ignored files are intentionally left
 *      behind and the original is only ever read),
 *   3. remove every remote so the copy has nowhere to push/fetch, and
 *   4. chown the copy to the unprivileged read-only account (best-effort; only
 *      possible when the runner is root).
 *
 * Any failure throws — the caller fails the task before the agent starts.
 */
export function prepareReadOnlyCopy(realRepo: string, copyRepo: string, identity?: RunOpts): PreparedCopy {
  // 1. Clone committed history only. --no-local forces the regular transport so
  //    only reachable objects are copied (no stray .git cruft, no hardlinks into
  //    the real object store). Run as the runner (root in prod) so the fresh copy
  //    is owned by us for the overlay step before we hand it to the RO account.
  execFileSync('git', ['clone', '--no-local', '--no-hardlinks', '--quiet', realRepo, copyRepo], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  // 2. Overlay the real working tree (tracked changes vs HEAD + untracked
  //    non-ignored files). `diff HEAD` covers staged+unstaged modifications and
  //    deletions; ls-files --others --exclude-standard covers new, non-ignored
  //    files. Both read the real repo only.
  const changed = splitZ(git(['diff', '--name-only', '--no-renames', '-z', 'HEAD'], realRepo))
  const untracked = splitZ(git(['ls-files', '--others', '--exclude-standard', '-z'], realRepo))
  const seen = new Set<string>()
  for (const rel of [...changed, ...untracked]) {
    if (seen.has(rel)) continue
    seen.add(rel)
    overlayPath(realRepo, copyRepo, rel)
  }

  // 3. Remove ALL remotes so the copy cannot fetch or push anywhere.
  const remotes = git(['remote'], copyRepo).split('\n').map(r => r.trim()).filter(Boolean)
  for (const remote of remotes) {
    git(['remote', 'remove', remote], copyRepo)
  }

  const baseHead = git(['rev-parse', 'HEAD'], copyRepo)

  // 4. Hand ownership to the read-only account (only root can chown across users;
  //    silently a no-op otherwise, e.g. in tests).
  if (identity?.uid !== undefined && identity.gid !== undefined) {
    try {
      execFileSync('chown', ['-R', `${identity.uid}:${identity.gid}`, copyRepo], { stdio: 'ignore' })
    } catch {
      // Not running as root — fine; the copy stays owned by the runner user.
    }
  }

  return { baseHead }
}

/**
 * Describe what the agent changed inside the disposable copy — INFORMATION ONLY.
 * The real repo is never inspected or touched here. Runs git as the account that
 * owns the copy (via uid/gid) so it does not trip git's dubious-ownership guard.
 */
export function reportReadOnlyChanges(copyRepo: string, baseHead: string, identity: RunOpts = {}): string {
  const lines: string[] = []
  try {
    const status = git(['status', '--porcelain=v2', '--ignored'], copyRepo, identity)
    lines.push(status ? status : '(copy working tree clean)')
  } catch (err) {
    lines.push(`(could not read copy status: ${err instanceof Error ? err.message : 'unknown error'})`)
  }
  try {
    const head = git(['rev-parse', 'HEAD'], copyRepo, identity)
    if (head !== baseHead) {
      // --name-status lists the files each discarded commit touched, so the report
      // surfaces what the agent did even when it committed its changes.
      const log = git(['log', '--name-status', '--oneline', `${baseHead}..HEAD`], copyRepo, identity)
      lines.push('new commits in copy (discarded):', log)
    }
  } catch {
    // HEAD unreadable — nothing to add.
  }
  return lines.join('\n')
}
