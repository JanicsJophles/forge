import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  summarizeChangedFiles,
  boundChangedFiles,
  CHANGED_FILES_LIMIT,
  type ChangedFile,
} from './git-changes.js'

test('summarizeChangedFiles counts a mixed M/A/D/R/C/untracked set by status letter', () => {
  const files: ChangedFile[] = [
    { path: 'a.txt', status: 'M' },
    { path: 'b.txt', status: 'M' },
    { path: 'c.txt', status: 'A' },
    { path: 'd.txt', status: 'D' },
    { path: 'e.txt', status: 'R100' }, // rename collapses to renamed
    { path: 'f.txt', status: 'C75' }, // copy collapses to copied
    { path: 'g.txt', status: '?' },
    { path: 'h.txt', status: '?' },
  ]

  const summary = summarizeChangedFiles(files)
  assert.deepEqual(summary, {
    added: 1,
    modified: 2,
    deleted: 1,
    renamed: 1,
    copied: 1,
    untracked: 2,
    total: 8,
  })
})

test('summarizeChangedFiles counts unknown status letters only in total', () => {
  const files: ChangedFile[] = [
    { path: 'u.txt', status: 'U' }, // unmerged — no named bucket
    { path: 'x.txt', status: 'M' },
  ]

  const summary = summarizeChangedFiles(files)
  assert.equal(summary.total, 2)
  assert.equal(summary.modified, 1)
  assert.equal(
    summary.added + summary.deleted + summary.renamed + summary.copied + summary.untracked,
    0,
  )
})

test('boundChangedFiles leaves a within-bounds list untouched', () => {
  const files: ChangedFile[] = [
    { path: 'a.txt', status: 'M' },
    { path: 'b.txt', status: 'A' },
  ]

  const bounded = boundChangedFiles(files)
  assert.equal(bounded.truncated, false)
  assert.equal(bounded.changedFiles.length, 2)
  assert.deepEqual(bounded.changedFiles, files)
})

test('boundChangedFiles caps the list and flags truncation while summary totals stay complete', () => {
  const overflow = CHANGED_FILES_LIMIT + 123
  const files: ChangedFile[] = Array.from({ length: overflow }, (_, i) => ({
    path: `untracked-${i}.txt`,
    status: '?',
  }))

  // The summary reflects the FULL set even though the list will be capped.
  const summary = summarizeChangedFiles(files)
  assert.equal(summary.total, overflow)
  assert.equal(summary.untracked, overflow)

  const bounded = boundChangedFiles(files)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.changedFiles.length, CHANGED_FILES_LIMIT)
})

test('recorded commit probes ignore later commits and dirty worktrees, including root commits', async () => {
  const { execFileSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { getChangedFiles, getChangesPatch } = await import('./git-changes.js')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-commit-changes-'))
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
  ], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  const write = (name: string, content: string) => fs.writeFileSync(path.join(repo, name), content)
  try {
    git('init', '-q')
    write('original.txt', 'original\n')
    git('add', 'original.txt')
    git('commit', '-qm', 'root')
    const root = git('rev-parse', 'HEAD')
    assert.deepEqual(getChangedFiles(repo, root), [{ path: 'original.txt', status: 'A' }])
    assert.match(getChangesPatch(repo, root).patch, /\+original/)
    git('mv', 'original.txt', 'renamed file.txt')
    write('task.txt', 'task content\n')
    git('add', 'task.txt')
    git('commit', '-qm', 'task')
    const task = git('rev-parse', 'HEAD')
    const expected = getChangedFiles(repo, task)
    assert.deepEqual(expected, [
      { path: 'renamed file.txt', status: 'R100' },
      { path: 'task.txt', status: 'A' },
    ])
    const patch = getChangesPatch(repo, task)
    assert.match(patch.patch, /\+task content/)
    write('later.txt', 'later commit\n')
    git('add', 'later.txt')
    git('commit', '-qm', 'later')
    write('task.txt', 'unrelated working tree\n')
    write('untracked.txt', 'untracked\n')
    assert.deepEqual(getChangedFiles(repo, task), expected)
    assert.deepEqual(getChangesPatch(repo, task), patch)
    assert.deepEqual(getChangedFiles(repo), [
      { path: 'task.txt', status: 'M' },
      { path: 'untracked.txt', status: '?' },
    ])
    assert.match(getChangesPatch(repo).patch, /\+unrelated working tree/)
    for (const bad of ['--output=leak', 'HEAD', '', 'f'.repeat(40)]) {
      for (const probe of [getChangedFiles, getChangesPatch]) {
        assert.throws(() => probe(repo, bad), /^Error: Git change inspection unavailable;/)
      }
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

for (const helper of ['external diff', 'textconv']) {
  test(`change inspection suppresses configured ${helper} helpers`, async () => {
    const { execFileSync } = await import('node:child_process')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { getChangedFiles, getChangesPatch } = await import('./git-changes.js')
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-diff-helpers-'))
    const marker = path.join(repo, '.git', 'helper-ran')
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
    ], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
    const write = (name: string, content: string) => fs.writeFileSync(path.join(repo, name), content)
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

      // Record native results before enabling helpers, including root and
      // first-parent merge behavior. Keep helper files inside .git so status
      // does not include test machinery.
      const revisions = [undefined, root, recorded, merge]
      const expected = revisions.map(sha => ({
        files: getChangedFiles(repo, sha), patch: getChangesPatch(repo, sha),
      }))
      write('.git/helper.sh', '#!/bin/sh\nprintf ran > .git/helper-ran\nprintf "converted output\\n"\n')
      fs.chmodSync(path.join(repo, '.git/helper.sh'), 0o755)
      if (helper === 'external diff') {
        git('config', 'diff.external', '.git/helper.sh')
      } else {
        write('.git/info/attributes', '*.txt diff=marker\n')
        git('config', 'diff.marker.textconv', '.git/helper.sh')
      }
      // Positive control: ordinary Git really invokes the configured helper.
      git('diff', '--ext-diff', '--textconv', 'HEAD')
      assert.equal(fs.existsSync(marker), true)
      fs.unlinkSync(marker)
      revisions.forEach((sha, index) => {
        assert.deepEqual(getChangedFiles(repo, sha), expected[index].files)
        assert.equal(fs.existsSync(marker), false, `name-status helper ran for ${sha}`)
        assert.deepEqual(getChangesPatch(repo, sha), expected[index].patch)
        assert.equal(fs.existsSync(marker), false, `patch helper ran for ${sha}`)
      })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
}
