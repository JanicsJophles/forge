import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CHANGES_PATCH_BYTE_CAP as cap, getChangesPatch } from './git-changes.js'

for (const mode of ['unborn', 'checkout', 'commit'] as const) {
  test(`UTF-8 patch cap preserves whole codepoints for ${mode} diffs`, () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-patch-utf8-'))
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
    ], { cwd: repo, stdio: 'pipe', maxBuffer: 2 * cap })
    const write = (content: string) => {
      writeFileSync(join(repo, 'sample.txt'), content)
      git('add', 'sample.txt')
    }
    const raw = () => git('diff', '--no-ext-diff', '--no-textconv', '--no-color',
      ...(mode === 'unborn' ? ['--cached'] : ['HEAD']))
    try {
      git('init', '-q')
      if (mode !== 'unborn') {
        write('')
        git('commit', '-qm', 'empty file')
      }
      write('x\n')
      const prefixLength = raw().length - 2 // Added line's x and newline.
      const cases = [
        { name: 'below cap', content: 'é€😀\n', end: undefined },
        { name: 'exact cap', content: 'a'.repeat(cap - prefixLength - 3) + 'é\n', end: undefined },
        { name: 'one-byte overflow', content: 'a'.repeat(cap - prefixLength) + '\n', end: cap },
        { name: 'ASCII overflow', content: 'a'.repeat(cap + 20) + '\n', end: cap },
        ...['é', '€', '😀'].flatMap(character =>
          Array.from({ length: Buffer.byteLength(character) - 1 }, (_, index) => {
            const keptBytes = index + 1
            return {
              name: `${Buffer.byteLength(character)}-byte character split after ${keptBytes}`,
              content: 'a'.repeat(cap - prefixLength - keptBytes) + character + '\n',
              end: cap - keptBytes,
            }
          })),
        { name: 'complete codepoint at cap', content: 'a'.repeat(cap - prefixLength - 4) + '😀\n', end: cap },
      ]
      for (const fixture of cases) {
        write(fixture.content)
        const diff = raw()
        // Exercise recorded-commit reads against exactly the same diff as HEAD.
        let sha: string | undefined
        if (mode === 'commit') {
          git('commit', '-qm', fixture.name)
          sha = git('rev-parse', 'HEAD').toString('utf8').trim()
        }
        const result = getChangesPatch(repo, sha)
        const expected = diff.subarray(0, fixture.end ?? diff.length).toString('utf8')
        assert.equal(result.patch, expected, fixture.name)
        assert.equal(result.truncated, diff.length > cap, fixture.name)
        assert.ok(Buffer.byteLength(result.patch) <= cap, fixture.name)
        assert.ok(!result.patch.includes('\ufffd'), fixture.name)
        if (fixture.name === 'exact cap') assert.equal(diff.length, cap)
        if (fixture.name === 'one-byte overflow') assert.equal(diff.length, cap + 1)
        if (mode === 'commit') git('reset', '--soft', 'HEAD^')
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
}
