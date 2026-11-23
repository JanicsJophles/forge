import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionReadOnlyHome, prepareReadOnlyBase } from './readonly.js'

test('provisioning copies only credentials with private modes and ignores agent configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-provision-'))
  try {
    const task = join(root, 'task'), auth = join(root, 'auth')
    mkdirSync(task, { mode: 0o700 }); mkdirSync(auth, { mode: 0o700 })
    writeFileSync(join(auth, 'auth.json'), '{"test":true}', { mode: 0o600 })
    writeFileSync(join(auth, 'config.toml'), 'untrusted config')
    const result = provisionReadOnlyHome(task, {}, 'codex', auth)
    assert.equal(readFileSync(join(result.configDir!, 'auth.json'), 'utf8'), '{"test":true}')
    assert.equal(existsSync(join(result.configDir!, 'config.toml')), false)
    assert.equal(statSync(result.home).mode & 0o777, 0o700)
    assert.equal(statSync(join(result.configDir!, 'auth.json')).mode & 0o777, 0o600)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('provisioning refuses a planted home symlink without writing its target', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-provision-link-'))
  try {
    const task = join(root, 'task'), target = join(root, 'target')
    mkdirSync(task, { mode: 0o700 }); mkdirSync(target)
    symlinkSync(target, join(task, 'home'))
    assert.throws(() => provisionReadOnlyHome(task, {}, 'codex'), /EEXIST/)
    assert.equal(existsSync(join(target, '.codex')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('provisioning refuses writable ancestors and credential symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-provision-trust-'))
  try {
    const task = join(root, 'task'), auth = join(root, 'auth')
    mkdirSync(task, { mode: 0o700 }); mkdirSync(auth, { mode: 0o700 })
    chmodSync(root, 0o777)
    assert.throws(() => provisionReadOnlyHome(task, {}, 'codex', auth), /unprotected ancestor/)
    chmodSync(root, 0o700)
    writeFileSync(join(root, 'secret'), 'not a credential')
    symlinkSync(join(root, 'secret'), join(auth, 'auth.json'))
    assert.throws(() => provisionReadOnlyHome(task, {}, 'codex', auth), /ELOOP/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('base setup refuses a planted directory symlink without chmodding its target', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-base-link-'))
  try {
    const target = join(root, 'target'), base = join(root, 'base')
    mkdirSync(target, { mode: 0o700 }); symlinkSync(target, base)
    assert.throws(() => prepareReadOnlyBase(base), /unprotected ancestor/)
    assert.equal(statSync(target).mode & 0o777, 0o700)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
