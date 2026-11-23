// Disposable-copy preparation worker.
//
// This module is spawned as a SEPARATE PROCESS that already runs as the read-only
// account (uid/gid dropped by the parent at spawn time) with a minimal env. It must
// never be imported into the main runner process: everything it does — cloning,
// reading the real working tree, and WRITING the overlay — happens with the
// read-only account's privileges, so a hostile working tree cannot trick root into
// reading host files or writing outside the copy.
//
// Contract: argv = [realRepo, copyRepo]. On success it prints a single JSON line
// `{"baseHead":"<sha>"}` to stdout and exits 0. Any failure throws → non-zero exit.
import {
  accessSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  fstatSync,
  readSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  constants as FS,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  safeGit,
  isInside,
  isSafeRelPath,
  PER_FILE_COPY_CAP,
  TOTAL_COPY_CAP,
  GIT_HARDENING_FLAGS,
} from './git-safe.js'

interface OverlayState {
  totalBytes: number
}

// Split NUL-delimited git output into non-empty entries.
function splitZ(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

// Walk `base`/`parts` component-by-component with lstat (never following symlinks).
// Returns the absolute directory iff every component is a REAL directory that stays
// inside realpath(base); otherwise null. This is how we refuse any path whose parent
// in the SOURCE is a symlink (e.g. a tracked dir replaced by a symlink to /root/.ssh).
function resolveRealDirChain(base: string, parts: string[]): string | null {
  const baseReal = realpathSync(base)
  let cur = baseReal
  for (const part of parts) {
    cur = join(cur, part)
    let st
    try {
      st = lstatSync(cur)
    } catch {
      return null // ancestor missing
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return null
  }
  // All components are real dirs; realpath is therefore stable and must stay inside.
  const resolved = realpathSync(cur)
  return isInside(baseReal, resolved) ? resolved : null
}

// Ensure `copyRepo`/`relDir` is a chain of REAL directories, destroying any stale
// symlink/file left by the clone along the way. This is the core of the finding-1
// fix: if HEAD had `d` as a symlink (→ /etc/cron.d) and the working tree turned it
// into a real dir, the clone keeps the symlink; before writing `d/<child>` we replace
// that symlink with a real directory so no write is ever redirected out of the copy.
// Returns the absolute, realpath-verified directory inside the copy.
function ensureRealDirInCopy(copyRepo: string, relDir: string): string {
  const copyReal = realpathSync(copyRepo)
  let cur = copyReal
  for (const part of relDir.split('/').filter(Boolean)) {
    cur = join(cur, part)
    let st
    try {
      st = lstatSync(cur)
    } catch {
      mkdirSync(cur)
      continue
    }
    if (st.isDirectory()) continue
    // A symlink (removed as the link, not its target) or a file is in the way.
    rmSync(cur, { force: true, recursive: true })
    mkdirSync(cur)
  }
  const resolved = realpathSync(cur)
  if (!isInside(copyReal, resolved)) {
    throw new Error(`overlay path escaped the copy root: ${relDir}`)
  }
  return resolved
}

// Remove `copyRepo`/`rel` for a mirrored deletion, but only if every ancestor in the
// copy is a real directory (never follow a symlinked ancestor out of the copy).
function removeFromCopy(copyRepo: string, rel: string): void {
  const parts = rel.split('/')
  const parentDir = resolveRealDirChain(copyRepo, parts.slice(0, -1))
  if (parentDir === null) return
  const target = join(parentDir, parts[parts.length - 1])
  try {
    lstatSync(target)
  } catch {
    return
  }
  rmSync(target, { force: true, recursive: true })
}

// Overlay a single working-tree path from the real repo onto the copy. Reads only the
// real repo (as the read-only uid), writes only inside the copy, follows NO symlink
// for either read or write, and skips anything that is not a regular file or symlink.
function overlayPath(realRepo: string, copyRepo: string, rel: string, state: OverlayState): void {
  if (!isSafeRelPath(rel)) return
  const parts = rel.split('/')
  const name = parts[parts.length - 1]
  const dirParts = parts.slice(0, -1)

  // The SOURCE parent chain must be real directories inside the real repo. If a
  // parent is a symlink (finding 2), refuse the path — we never read through it.
  const srcDir = resolveRealDirChain(realRepo, dirParts)
  if (srcDir === null) return
  const src = join(srcDir, name)

  let st
  try {
    st = lstatSync(src) // never follows the final component
  } catch {
    removeFromCopy(copyRepo, rel) // deleted in the real tree → mirror the deletion
    return
  }

  if (st.isDirectory()) {
    // git emits a path here only when a type change (e.g. HEAD symlink → real dir)
    // occurred. Normalise the copy to a real directory; children arrive separately.
    ensureRealDirInCopy(copyRepo, rel)
    return
  }

  const destDir = ensureRealDirInCopy(copyRepo, dirParts.join('/'))
  const dest = join(destDir, name)

  // Clear any existing entry (as the link itself, never its target).
  try {
    lstatSync(dest)
    rmSync(dest, { force: true, recursive: true })
  } catch {
    // nothing there
  }

  if (st.isSymbolicLink()) {
    // Reproduce the link ONLY if its target stays inside the repo. An ESCAPING link
    // (absolute, or `..` beyond the root) would let the read-only agent READ any host
    // file by following it (finding 2) — so it is skipped, never reproduced. Resolve
    // the target lexically against the link's real directory (it may be dangling).
    const target = readlinkSync(src)
    const realRoot = realpathSync(realRepo)
    const resolvedTarget = resolve(srcDir, target)
    if (!isInside(realRoot, resolvedTarget)) return // escaping symlink — do not mirror
    symlinkSync(target, dest)
    return
  }

  if (!st.isFile()) return // FIFO / socket / device / etc. — skip (finding 5: no hang)

  if (st.size > PER_FILE_COPY_CAP) return
  if (state.totalBytes + st.size > TOTAL_COPY_CAP) return

  // Read with O_NOFOLLOW (st is already a regular file, but guard against TOCTOU),
  // write with O_CREAT|O_EXCL|O_NOFOLLOW so we only ever create a fresh real file
  // inside the real-dir parent — a write can never be redirected through a symlink.
  // NONBLOCK prevents a regular-file -> FIFO race from blocking open. Recheck
  // the opened descriptor and read a bounded amount even if the source grows.
  const srcFd = openSync(src, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
  let buf: Buffer
  try {
    const opened = fstatSync(srcFd)
    const cap = Math.min(PER_FILE_COPY_CAP, TOTAL_COPY_CAP - state.totalBytes)
    if (!opened.isFile() || opened.size > cap) return
    const chunks: Buffer[] = []
    let length = 0
    while (length <= cap) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, cap + 1 - length))
      const n = readSync(srcFd, chunk, 0, chunk.length, null)
      if (n === 0) break
      length += n
      if (length > cap) return
      chunks.push(chunk.subarray(0, n))
    }
    buf = Buffer.concat(chunks, length)
  } finally {
    closeSync(srcFd)
  }
  state.totalBytes += buf.length
  const destFd = openSync(dest, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, st.mode & 0o777)
  try {
    writeFileSync(destFd, buf)
  } finally {
    closeSync(destFd)
  }
}

/** Refuse ACL/mode write access to any real-tree entry, including ignored files. */
export function assertSourceReadOnly(realRepo: string): void {
  if (!lstatSync(realRepo).isDirectory()) throw new Error('read-only source must be a real directory')
  // Write access to a parent can rename/delete even a non-writable repository.
  // A root-owned sticky temp directory protects another uid's children.
  for (let parent = dirname(realRepo); ; parent = dirname(parent)) {
    const st = lstatSync(parent)
    if (!st.isDirectory()) throw new Error('read-only source has a symlinked ancestor')
    let writable = false
    try { accessSync(parent, FS.W_OK); writable = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error
    }
    if (writable && (!(st.mode & 0o1000) || st.uid === process.getuid!())) {
      throw new Error('read-only account has write access to a source ancestor')
    }
    if (parent === dirname(parent)) break
  }
  const pending = [realRepo]
  let entries = 0
  while (pending.length) {
    const path = pending.pop()!
    if (++entries > 1_000_000) throw new Error('read-only source exceeds inspection limit')
    const st = lstatSync(path)
    // Parent writability controls replacement/deletion of links; never follow a
    // user-controlled link merely to inspect it.
    if (st.isSymbolicLink()) continue
    try {
      accessSync(path, FS.W_OK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error
      if (st.isDirectory()) for (const name of readdirSync(path)) pending.push(join(path, name))
      continue
    }
    throw new Error('read-only account has write access to the source repository')
  }
}

function shellArgument(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'"
}

export function prepareCopy(realRepo: string, copyRepo: string, requireReadOnlySource = false): string {
  if (requireReadOnlySource) assertSourceReadOnly(realRepo)
  // upload-pack validates the resolved git directory separately from the worktree.
  // Trust only the exact resolved paths, never safe.directory=*.
  const gitDir = safeGit(['rev-parse', '--absolute-git-dir'], realRepo, { safeDir: realRepo, worktree: realRepo })
  const commonDir = safeGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], realRepo, { safeDir: realRepo, worktree: realRepo })
  if (requireReadOnlySource) {
    assertSourceReadOnly(gitDir)
    if (commonDir !== gitDir) assertSourceReadOnly(commonDir)
  }
  // 1. Clone committed history only, over the regular transport (no hardlinks into
  //    the real object store). safeDir trusts the real repo's ownership (it is owned
  //    by the writable account, not us); the hardening flags neutralise any hostile
  //    repo-local config for this and the upload-pack subprocess.
  safeGit(
    ['clone', '--no-local', '--no-hardlinks', '--quiet',
      // Git strips -c configuration from its upload-pack environment. Carry the
      // exact ownership exceptions and hardening flags into that trusted command
      // explicitly. Shell quoting is necessary because Git invokes this as a command.
      '--upload-pack', ['git', ...GIT_HARDENING_FLAGS,
        '-c', `safe.directory=${realRepo}`, '-c', `safe.directory=${gitDir}`,
        '-c', `safe.directory=${commonDir}`, 'upload-pack'].map(shellArgument).join(' '),
      realRepo, copyRepo],
    dirname(copyRepo),
    { safeDir: realRepo, extraSafeDirs: [gitDir, commonDir] },
  )

  // 2. Overlay the real working tree: tracked changes vs HEAD (+ deletions) and
  //    untracked, non-ignored files. Both reads run as us against the real repo.
  const changed = splitZ(
    safeGit(
      ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', 'HEAD'],
      realRepo,
      { safeDir: realRepo, worktree: realRepo },
    ),
  )
  const untracked = splitZ(
    safeGit(['ls-files', '--others', '--exclude-standard', '-z'], realRepo, { safeDir: realRepo, worktree: realRepo }),
  )
  const state: OverlayState = { totalBytes: 0 }
  const seen = new Set<string>()
  for (const rel of [...changed, ...untracked]) {
    if (seen.has(rel)) continue
    seen.add(rel)
    overlayPath(realRepo, copyRepo, rel, state)
  }

  // 3. Remove every remote so the copy can neither fetch nor push.
  const remotes = safeGit(['remote'], copyRepo).split('\n').map(r => r.trim()).filter(Boolean)
  for (const remote of remotes) {
    safeGit(['remote', 'remove', remote], copyRepo)
  }

  // 4. Record the copy's HEAD so the post-run report can show any commits the agent
  //    made inside the disposable copy.
  return safeGit(['rev-parse', 'HEAD'], copyRepo)
}

// Run only when executed as a script (never when imported). We compare the resolved
// entry path to this module's path so tests can import prepareCopy() directly.
function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  const [realRepo, copyRepo] = process.argv.slice(2)
  if (!realRepo || !copyRepo) {
    process.stderr.write('usage: prep-copy <realRepo> <copyRepo>\n')
    process.exit(2)
  }
  try {
    const baseHead = prepareCopy(realRepo, copyRepo, process.argv[4] === '--require-read-only-source')
    process.stdout.write(JSON.stringify({ baseHead }) + '\n')
    process.exit(0)
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n')
    process.exit(1)
  }
}
