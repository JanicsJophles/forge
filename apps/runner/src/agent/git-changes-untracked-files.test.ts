import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { boundChangedFiles, CHANGED_FILES_LIMIT, getChangedFiles, getChangesPatch, summarizeChangedFiles } from './git-changes.js'

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'forge-untracked-'))
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
  ], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  const write = (path: string, content = 'private untracked content\n') => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  git('init', '-q')
  return { repo, git, write }
}

for (const unborn of [true, false]) {
  test(`nested untracked paths are individual files (${unborn ? 'unborn' : 'existing HEAD'})`, () => {
    const { repo, git, write } = fixture()
    try {
      write('.gitignore', '*.ignored\n')
      write('tracked.txt', 'initial\n')
      git('add', '.gitignore', 'tracked.txt')
      let recorded: string | undefined
      if (!unborn) {
        git('commit', '-qm', 'root')
        recorded = git('rev-parse', 'HEAD')
        write('tracked.txt', 'changed\n')
      }
      const paths = ['new/deeper/one.txt', 'new/two.txt', 'new/space name.txt', 'new/日本語.txt', 'new/line\nbreak.txt']
      for (const path of paths) write(path)
      write('new/secret.ignored')
      write('new/deeper/secret.ignored')
      const files = getChangedFiles(repo)
      assert.deepEqual(files.filter(file => file.status === '?').map(file => file.path).sort(), paths.sort())
      assert.deepEqual(files.filter(file => file.status !== '?'), unborn
        ? [{ path: '.gitignore', status: 'A' }, { path: 'tracked.txt', status: 'A' }]
        : [{ path: 'tracked.txt', status: 'M' }])
      const summary = summarizeChangedFiles(files)
      assert.equal(summary.untracked, paths.length)
      assert.equal(summary.total, paths.length + (unborn ? 2 : 1))
      assert.doesNotMatch(getChangesPatch(repo).patch, /private untracked content/)
      if (recorded) {
        assert.deepEqual(getChangedFiles(repo, recorded), [
          { path: '.gitignore', status: 'A' }, { path: 'tracked.txt', status: 'A' },
        ])
        assert.equal(summarizeChangedFiles(getChangedFiles(repo, recorded)).untracked, 0)
      }
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
}

test('expanded nested files retain full summary counts when the response list is capped', () => {
  const { repo, write } = fixture()
  try {
    const count = CHANGED_FILES_LIMIT + 3
    for (let i = 0; i < count; i++) write(`nested/${i}.txt`, '')
    const files = getChangedFiles(repo)
    assert.equal(summarizeChangedFiles(files).untracked, count)
    assert.equal(summarizeChangedFiles(files).total, count)
    const bounded = boundChangedFiles(files)
    assert.equal(bounded.truncated, true)
    assert.equal(bounded.changedFiles.length, CHANGED_FILES_LIMIT)
    assert.ok(bounded.changedFiles.every(file => file.path.endsWith('.txt')))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('status buffer overflow is a sanitized unavailable review, never partial success', () => {
  const { repo, write } = fixture()
  const originalPath = process.env.PATH
  try {
    // Fake only the status response to exceed execFileSync's existing buffer.
    // Other probes delegate to the real Git executable without a shell.
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    write('bin/git', `#!${process.execPath}\nconst { execFileSync } = require('node:child_process');\nif (process.argv[2] === 'status') process.stdout.write('?? nested/private-name\\0'.repeat(100000));\nelse process.stdout.write(execFileSync(${JSON.stringify(gitPath)}, process.argv.slice(2)));\n`)
    // The fixture helper writes ordinary files; make this private executable.
    execFileSync('chmod', ['+x', join(repo, 'bin/git')])
    process.env.PATH = `${join(repo, 'bin')}:${originalPath}`
    assert.throws(() => getChangedFiles(repo), {
      message: 'Git change inspection unavailable; read probe failed or exceeded 2000ms',
    })
  } finally {
    process.env.PATH = originalPath
    rmSync(repo, { recursive: true, force: true })
  }
})
