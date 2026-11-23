// Security regression tests for read-only copy preparation.
//
// Each test reproduces one of the reviewer's findings as a concrete attack fixture
// and asserts the attack does NOT succeed. They are written against the PUBLIC
// readonly.ts API (`prepareReadOnlyCopy` / `reportReadOnlyChanges`) so the exact
// same test file runs on the pre-fix commit (df76bc0), where each one FAILS:
//   - findings 1,2 : the old `overlayPath` (copyFileSync + mkdirSync onto a stale
//                    symlink) escapes the copy / reads a host file → assertion fails.
//   - finding 3    : the old prepare runs git in the real repo with no hardening, so
//                    a repo-local core.fsmonitor executes → marker assertion fails.
//   - finding 4    : the old `reportReadOnlyChanges` runs git in the copy with no
//                    hardening → a copy-local core.fsmonitor executes → marker fails.
//   - finding 5    : the old overlay copyFileSync's a FIFO and BLOCKS forever → the
//                    whole (synchronous) prepare hangs → the test times out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  readFileSync,
  chmodSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { prepareReadOnlyCopy, reportReadOnlyChanges } from './readonly.js'

let root: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
  }).trim()
}

function initRepo(path: string): void {
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 't@t')
  git(path, 'config', 'user.name', 't')
  git(path, 'config', 'commit.gpgsign', 'false')
}

function tmp(prefix: string): string {
  return mkdtempSync(join(root, prefix))
}

import { before, after } from 'node:test'
before(() => { root = mkdtempSync(join(tmpdir(), 'forge-ro-sec-')) })
after(() => { rmSync(root, { recursive: true, force: true }) })

// ── Finding 1 — write escape via a stale symlink DIRECTORY in the copy ──────────
// HEAD stores `d` as a symlink to an external dir; the working tree replaces it with
// a REAL directory holding `d/evil.txt`. The clone checks out `d` as the symlink, so
// a naive overlay that writes `d/evil.txt` follows the link and writes OUTSIDE the
// copy. The fix rebuilds `d` as a real directory in the copy before writing.
test('finding 1: an overlay write cannot escape the copy through a stale symlinked dir', async () => {
  const real = tmp('f1-real-')
  initRepo(real)
  const escape = tmp('f1-escape-') // the symlink target, OUTSIDE the copy
  writeFileSync(join(real, 'readme.txt'), 'hi\n')
  symlinkSync(escape, join(real, 'd')) // commit `d` as a symlink → escape dir
  git(real, 'add', '-A')
  git(real, 'commit', '-qm', 'init: d is a symlink')
  // Working tree: `d` becomes a real directory with a child file.
  rmSync(join(real, 'd'))
  mkdirSync(join(real, 'd'))
  writeFileSync(join(real, 'd', 'evil.txt'), 'EVIL\n')

  const dest = join(tmp('f1-copyroot-'), 'repo')
  await prepareReadOnlyCopy(real, dest)

  assert.ok(
    !existsSync(join(escape, 'evil.txt')),
    'the overlay must NOT write through the stale symlink into the external escape dir',
  )
  assert.equal(
    readFileSync(join(dest, 'd', 'evil.txt'), 'utf8'),
    'EVIL\n',
    'the file must be written inside the copy as a real file',
  )
})

// ── Finding 2 — read a host file through a symlinked parent directory ────────────
// A tracked file `conf/id_rsa` exists in HEAD; the working tree replaces `conf` with
// a symlink to an external secret dir. A naive overlay resolves `conf/id_rsa` through
// the symlink and copies the HOST secret into the copy. The fix refuses any path
// whose source parent chain is not real directories.
test('finding 2: the overlay cannot read a host file through a symlinked parent dir', async () => {
  const real = tmp('f2-real-')
  initRepo(real)
  mkdirSync(join(real, 'conf'))
  writeFileSync(join(real, 'conf', 'id_rsa'), 'placeholder\n')
  git(real, 'add', '-A')
  git(real, 'commit', '-qm', 'init: conf/id_rsa tracked')
  // External secret the attacker wants exfiltrated into the copy.
  const secretDir = tmp('f2-secret-')
  writeFileSync(join(secretDir, 'id_rsa'), 'SECRET-HOST-KEY\n')
  // Working tree: swap the tracked dir for a symlink to the secret dir.
  rmSync(join(real, 'conf'), { recursive: true, force: true })
  symlinkSync(secretDir, join(real, 'conf'))

  const dest = join(tmp('f2-copyroot-'), 'repo')
  await prepareReadOnlyCopy(real, dest)

  const leaked = join(dest, 'conf', 'id_rsa')
  const leakedSecret = existsSync(leaked) && readFileSync(leaked, 'utf8').includes('SECRET-HOST-KEY')
  assert.ok(!leakedSecret, 'the host secret must NOT be copied into the disposable copy through a symlinked parent')
})

// ── Finding 3 — repo-local core.fsmonitor executes while preparing ──────────────
// Preparing the copy runs `git diff`/`git ls-files` in the REAL repo. Without the
// hardening flags, a repo-local `core.fsmonitor` hook is executed as the runner.
test('finding 3: a repo-local core.fsmonitor is never executed while preparing the copy', async () => {
  const real = tmp('f3-real-')
  initRepo(real)
  writeFileSync(join(real, 'a.txt'), 'a\n')
  git(real, 'add', '-A')
  git(real, 'commit', '-qm', 'init')
  writeFileSync(join(real, 'a.txt'), 'changed\n') // a diff so refresh_index runs

  const marker = join(root, 'f3-fsmonitor-ran')
  const hook = join(root, 'f3-fsmonitor.sh')
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
  chmodSync(hook, 0o755)
  git(real, 'config', 'core.fsmonitor', hook)

  const dest = join(tmp('f3-copyroot-'), 'repo')
  await prepareReadOnlyCopy(real, dest)

  assert.ok(!existsSync(marker), 'core.fsmonitor must be disabled (never executed) for every git call in the real repo')
})

// ── Finding 4 — the post-run report honors the copy's core.fsmonitor ────────────
// `reportReadOnlyChanges` runs git inside the copy. A hostile agent can plant a
// copy-local `core.fsmonitor`; without the hardening flags it runs as the report.
test('finding 4: the post-run report never executes a copy-local core.fsmonitor', async () => {
  const real = tmp('f4-real-')
  initRepo(real)
  writeFileSync(join(real, 'a.txt'), 'a\n')
  git(real, 'add', '-A')
  git(real, 'commit', '-qm', 'init')

  const dest = join(tmp('f4-copyroot-'), 'repo')
  const { baseHead } = await prepareReadOnlyCopy(real, dest)

  // Simulate the agent planting a malicious fsmonitor in its disposable copy.
  const marker = join(root, 'f4-fsmonitor-ran')
  const hook = join(root, 'f4-fsmonitor.sh')
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
  chmodSync(hook, 0o755)
  git(dest, 'config', 'core.fsmonitor', hook)
  writeFileSync(join(dest, 'a.txt'), 'tampered\n') // a worktree change to force refresh

  reportReadOnlyChanges(dest, baseHead)

  assert.ok(!existsSync(marker), 'the report must disable core.fsmonitor so a copy-local hook never runs')
})

// ── Finding 5 — a FIFO in the working tree hangs the copy forever ───────────────
// The working tree turns a tracked file into a FIFO. The old overlay copyFileSync's
// it and blocks forever (no writer). The fix skips non-regular files; preparation
// completes. On the pre-fix commit this test HANGS and times out (= failure).
test('finding 5: a FIFO in the working tree does not hang preparation', { timeout: 30_000 }, async () => {
  const real = tmp('f5-real-')
  initRepo(real)
  writeFileSync(join(real, 'data.txt'), 'original\n')
  git(real, 'add', '-A')
  git(real, 'commit', '-qm', 'init')
  // Replace the tracked regular file with a FIFO (guaranteed listed by `diff HEAD`).
  rmSync(join(real, 'data.txt'))
  execFileSync('mkfifo', [join(real, 'data.txt')])

  const dest = join(tmp('f5-copyroot-'), 'repo')
  await prepareReadOnlyCopy(real, dest) // must return promptly, not block on the FIFO

  // The FIFO must not have been reproduced as a regular file in the copy.
  assert.ok(
    !existsSync(join(dest, 'data.txt')),
    'a FIFO must be skipped, not copied, by the overlay',
  )
})

// ── Root integration: preparation drops to the read-only account ────────────────
// Only meaningful when the test runs as root AND a dedicated, non-root read-only
// account is supplied via FORGE_TEST_RO_USER (e.g. on the runner host). Skipped
// everywhere else (CI, local dev) because it needs a real second account + root.
const roUser = process.env.FORGE_TEST_RO_USER
const runningAsRoot = userInfo().uid === 0
test(
  'root integration: the copy is prepared as the read-only uid, not root',
  { skip: !(runningAsRoot && roUser) ? 'requires root + FORGE_TEST_RO_USER' : false },
  async () => {
    const fields = execFileSync('getent', ['passwd', roUser!], { encoding: 'utf8' }).trim().split(':')
    const uid = Number(fields[2])
    const gid = Number(fields[3])
    const home = fields[5]
    assert.ok(uid > 0, 'the read-only account must be non-root')

    const real = tmp('rootint-real-')
    initRepo(real)
    writeFileSync(join(real, 'a.txt'), 'a\n')
    git(real, 'add', '-A')
    git(real, 'commit', '-qm', 'init')
    // The real repo must be readable by the read-only account for the clone.
    execFileSync('chmod', ['-R', 'a+rX', real])

    const copyRoot = tmp('rootint-copyroot-')
    execFileSync('chown', ['-R', `${uid}:${gid}`, copyRoot])
    const dest = join(copyRoot, 'repo')

    const { baseHead } = await prepareReadOnlyCopy(real, dest, { uid, gid, home })
    assert.equal(baseHead, git(real, 'rev-parse', 'HEAD'))
    // Everything the worker created must be owned by the read-only account.
    const { statSync } = await import('node:fs')
    assert.equal(statSync(dest).uid, uid, 'the copy dir is owned by the read-only account')
    assert.equal(statSync(join(dest, 'a.txt')).uid, uid, 'copied files are owned by the read-only account')
  },
)
