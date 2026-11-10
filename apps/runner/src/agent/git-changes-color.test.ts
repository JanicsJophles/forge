import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getChangesPatch } from './git-changes.js'

test('patches stay plain with forced repository colors for working trees and recorded commits', () => {
  const repo = mkdtempSync(join(tmpdir(), 'forge-patch-color-'))
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
  ], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  const write = (name: string, content: string) => writeFileSync(join(repo, name), content)
  try {
    git('init', '-q')
    write('sample.txt', 'original\n')
    git('add', 'sample.txt')
    git('commit', '-qm', 'root')
    const root = git('rev-parse', 'HEAD')
    git('checkout', '-qb', 'side')
    write('side.txt', 'side\n')
    git('add', 'side.txt')
    git('commit', '-qm', 'side')
    git('checkout', '-qb', 'task', root)
    write('sample.txt', 'recorded\n')
    git('add', 'sample.txt')
    git('commit', '-qm', 'task')
    const recorded = git('rev-parse', 'HEAD')
    git('merge', '--no-ff', '-qm', 'merge', 'side')
    const merge = git('rev-parse', 'HEAD')
    write('sample.txt', 'working tree\n')

    const revisions = [undefined, root, recorded, merge]
    const expected = revisions.map(sha => getChangesPatch(repo, sha))
    git('config', 'color.ui', 'always')
    git('config', 'color.diff.old', 'magenta bold')
    git('config', 'color.diff.new', 'cyan bold')
    git('config', 'color.diff.meta', 'yellow reverse')
    git('config', 'color.diff.frag', 'blue bold')
    // Positive controls prove both Git patch commands would otherwise emit ANSI.
    assert.match(git('diff', 'HEAD'), /\x1b\[/)
    assert.match(git('show', '--format=', recorded), /\x1b\[/)
    revisions.forEach((sha, index) => {
      const result = getChangesPatch(repo, sha)
      assert.deepEqual(result, expected[index])
      assert.equal(result.truncated, false)
      assert.doesNotMatch(result.patch, /\x1b/)
      assert.match(result.patch, /^diff --git /m)
      assert.match(result.patch, /^@@ .* @@/m)
      assert.match(result.patch, /^\+[^+]/m)
    })
    for (const sha of [undefined, recorded]) {
      assert.match(getChangesPatch(repo, sha).patch, /^-original$|^-recorded$/m)
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
