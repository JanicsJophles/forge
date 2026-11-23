import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerCommand, readOnlyGitEnv } from './provider.js'

test('claude writable mode keeps the permission bypass', () => {
  const { command, args } = providerCommand('claude', false)
  assert.equal(command, 'claude')
  assert.deepEqual(args, ['--dangerously-skip-permissions', '-p'])
})

test('claude read-only uses plan mode and denies mutation tools', () => {
  const { command, args } = providerCommand('claude', true)
  assert.equal(command, 'claude')
  assert.deepEqual(args, ['--permission-mode', 'plan', '--disallowedTools', 'Edit,Write,NotebookEdit', '-p'])
  assert.ok(!args.includes('--dangerously-skip-permissions'))
})

test('claude defaults to writable mode when readOnly is omitted', () => {
  assert.deepEqual(providerCommand('claude').args, ['--dangerously-skip-permissions', '-p'])
})

test('codex command is identical in both modes (read-only is enforced out-of-band)', () => {
  const writable = providerCommand('codex', false)
  const readonly = providerCommand('codex', true)
  assert.deepEqual(writable, { command: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'] })
  assert.deepEqual(readonly, writable)
})

test('unsupported provider throws', () => {
  // @ts-expect-error exercising the runtime guard with an invalid provider
  assert.throws(() => providerCommand('gpt'), /Unsupported agent provider/)
})

test('readOnlyGitEnv rewrites every push scheme to a nonexistent path', () => {
  const env = readOnlyGitEnv({ PATH: '/usr/bin' })
  assert.equal(env.PATH, '/usr/bin', 'base env is preserved')
  const count = Number(env.GIT_CONFIG_COUNT)
  assert.equal(count, 6)
  const keys: string[] = []
  const values: string[] = []
  for (let i = 0; i < count; i++) {
    keys.push(env[`GIT_CONFIG_KEY_${i}`] as string)
    values.push(env[`GIT_CONFIG_VALUE_${i}`] as string)
  }
  for (const key of keys) {
    assert.equal(key, 'url.file:///nonexistent/forge-read-only-no-push/.pushInsteadOf')
  }
  assert.deepEqual(values.sort(), ['file://', 'git@', 'git://', 'http://', 'https://', 'ssh://'].sort())
})

test('readOnlyGitEnv appends onto any pre-existing GIT_CONFIG_COUNT', () => {
  const env = readOnlyGitEnv({ GIT_CONFIG_COUNT: '2' })
  assert.equal(env.GIT_CONFIG_COUNT, '8')
  assert.equal(env.GIT_CONFIG_KEY_2, 'url.file:///nonexistent/forge-read-only-no-push/.pushInsteadOf')
  assert.equal(env.GIT_CONFIG_KEY_7, 'url.file:///nonexistent/forge-read-only-no-push/.pushInsteadOf')
})
