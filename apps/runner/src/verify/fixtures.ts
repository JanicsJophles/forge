import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { verifyTask, type Policy } from './index.js'

export const policy: Policy = { gateTimeoutMs: 2000, allowWorkflows: false, forbiddenPatterns: [] }
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-verify-'))
  const repo = join(root, 'repo')
  const remote = join(root, 'remote.git')
  const bin = join(root, 'bin')
  mkdirSync(repo)
  mkdirSync(bin)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'fixture@example.com')
  git('config', 'user.name', 'Fixture')
  const write = (path: string, content: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  write('example.test.ts', "test('works', () => { expect(true).toBe(true) })\n")
  write('package.json', '{"dependencies":{}}')
  git('add', '.')
  git('commit', '-m', 'base')
  git('remote', 'add', 'origin', remote)
  git('push', 'origin', 'main')
  git('checkout', '-b', 'feature')
  write('feature.txt', 'hello\n')
  const prFile = join(root, 'pr.json')
  const script = `#!/usr/bin/env node\nconst fs = require('fs'); const p = JSON.parse(fs.readFileSync(${JSON.stringify(prFile)}, 'utf8')); if (!p) process.exit(1); process.stdout.write(JSON.stringify(p));\n`
  writeFileSync(join(bin, 'gh'), script, { mode: 0o755 })
  const pr = (overrides = {}) => writeFileSync(prFile, JSON.stringify({ state: 'OPEN', isDraft: true, headRefName: 'feature', headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main', additions: 1, deletions: 0, body: '', ...overrides }))
  const commit = () => { git('add', '-A'); git('commit', '-m', 'change'); git('push', '-f', 'origin', 'feature'); pr() }
  commit()
  return {
    repo, root, git, write, pr, commit,
    missingPR: () => writeFileSync(prFile, 'null'),
    remove: (file: string) => rmSync(join(repo, file)),
    verify: (extra = {}, settings = policy) => verifyTask({ repo, prompt: 'Open a PR', output: 'PR https://github.com/example/repo/pull/1', ...extra }, settings, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
