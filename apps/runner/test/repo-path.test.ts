import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPlainAbsolutePath, resolveAllowedRepo } from '../src/agent/repo-path.js'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'forge-repo-path-')))
const root = join(base, 'repos')
const outside = join(base, 'outside')
mkdirSync(join(root, 'app'), { recursive: true })
mkdirSync(join(root, 'nested', 'deep'), { recursive: true })
mkdirSync(outside)
symlinkSync(outside, join(root, 'escape'))
symlinkSync(join(root, 'app'), join(root, 'alias'))
writeFileSync(join(root, 'file'), '')

test('plain absolute paths only', () => {
  assert.equal(isPlainAbsolutePath('/opt/repos/app'), true)
  assert.equal(isPlainAbsolutePath('/opt/repos/app/'), true)
  for (const bad of ['opt/repos/app', '/opt/repos/../../etc', '/opt/repos/./app', '/opt//repos/app',
    '/opt/repos/x$(id)', '/opt/repos/x`id`', '/opt/repos/a b', '/opt/repos/a;b', '/opt/repos/a"b', '']) {
    assert.equal(isPlainAbsolutePath(bad), false, bad)
  }
})

test('a canonical directory inside a root is allowed and returned', () => {
  assert.equal(resolveAllowedRepo(join(root, 'app'), [root]), join(root, 'app'))
  assert.equal(resolveAllowedRepo(join(root, 'app') + '/', [root + '/']), join(root, 'app'))
  assert.equal(resolveAllowedRepo(join(root, 'nested', 'deep'), [root]), join(root, 'nested', 'deep'))
})

test('traversal, symlinks, the root itself, files and prefix siblings are refused', () => {
  assert.equal(resolveAllowedRepo(join(root, '..', 'outside'), [root]), null)
  assert.equal(resolveAllowedRepo(root + '/../../etc', [root]), null)
  assert.equal(resolveAllowedRepo(join(root, 'escape'), [root]), null)
  assert.equal(resolveAllowedRepo(join(root, 'alias'), [root]), null)
  assert.equal(resolveAllowedRepo(root, [root]), null)
  assert.equal(resolveAllowedRepo(join(root, 'file'), [root]), null)
  assert.equal(resolveAllowedRepo(join(root, 'missing'), [root]), null)
  mkdirSync(root + '-evil', { recursive: true })
  assert.equal(resolveAllowedRepo(root + '-evil', [root]), null)
})

test('shell syntax never reaches the filesystem check', () => {
  assert.equal(resolveAllowedRepo(join(root, 'app') + '$(touch /tmp/pwned)', [root]), null)
})
