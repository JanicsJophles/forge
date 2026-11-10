import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getChangedFiles, getChangesPatch } from './git-changes.js'

const probes = [getChangedFiles, getChangesPatch]
const unavailable = /^Error: Git change inspection unavailable;/

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'forge-unborn-'))
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
  ], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q')
  return { repo, git, write: (name: string, text: string) => writeFileSync(join(repo, name), text) }
}

test('unborn reviews expose staged content and untracked names, then ordinary HEAD changes', () => {
  const { repo, git, write } = fixture()
  try {
    assert.deepEqual(getChangedFiles(repo), [])
    assert.deepEqual(getChangesPatch(repo), { patch: '', truncated: false })
    write('loose.txt', 'untracked content\n')
    assert.deepEqual(getChangedFiles(repo), [{ path: 'loose.txt', status: '?' }])
    assert.deepEqual(getChangesPatch(repo), { patch: '', truncated: false })
    write('initial.txt', 'staged content\n')
    git('add', 'initial.txt')
    const files = [{ path: 'initial.txt', status: 'A' }, { path: 'loose.txt', status: '?' }]
    assert.deepEqual(getChangedFiles(repo), files)
    const staged = getChangesPatch(repo)
    assert.match(staged.patch, /\+staged content/)
    assert.equal(staged.truncated, false)
    write('initial.txt', 'later working content\n')
    assert.deepEqual(getChangedFiles(repo), files)
    assert.deepEqual(getChangesPatch(repo), staged)
    git('commit', '-qm', 'first')
    assert.deepEqual(getChangedFiles(repo), [
      { path: 'initial.txt', status: 'M' }, { path: 'loose.txt', status: '?' },
    ])
    assert.match(getChangesPatch(repo).patch, /\+later working content/)
    const recorded = git('rev-parse', 'HEAD')
    assert.deepEqual(getChangedFiles(repo, recorded), [{ path: 'initial.txt', status: 'A' }])
    assert.deepEqual(getChangesPatch(repo, recorded), staged)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('unborn handling does not hide invalid commits, missing directories or corrupt HEADs', () => {
  const { repo, git, write } = fixture()
  try {
    for (const probe of probes) {
      assert.throws(() => probe(join(repo, 'missing')), unavailable)
      assert.throws(() => probe(repo, 'HEAD'), unavailable)
      assert.throws(() => probe(repo, 'f'.repeat(40)), unavailable)
    }
    const ref = git('symbolic-ref', 'HEAD')
    write(`.git/${ref}`, `${'f'.repeat(40)}\n`)
    for (const probe of probes) assert.throws(() => probe(repo), unavailable)
    write(`.git/${ref}`, 'invalid ref\n')
    for (const probe of probes) assert.throws(() => probe(repo), unavailable)
    write('.git/HEAD', 'broken HEAD\n')
    for (const probe of probes) assert.throws(() => probe(repo), unavailable)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('a timed-out HEAD probe fails instead of producing an empty unborn review', () => {
  const { repo } = fixture()
  const originalPath = process.env.PATH
  try {
    const bin = join(repo, 'bin')
    mkdirSync(bin)
    // A private fake Git stalls before answering the HEAD probe. Production
    // still invokes an argument array, with its normal timeout and SIGKILL.
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${originalPath}`
    for (const probe of probes) assert.throws(() => probe(repo), unavailable)
  } finally {
    process.env.PATH = originalPath
    rmSync(repo, { recursive: true, force: true })
  }
})
