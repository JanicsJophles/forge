import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import test from 'node:test'
import { checkCodexLogin } from './provider.js'

function probe(throws = false) {
  const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean }
  const kills: string[] = []
  child.kill = signal => { kills.push(signal); return true }
  let timeout: () => void = () => assert.fail('No timer installed')
  let cleared = 0
  let scheduled = 0
  const options = { uid: 1001, gid: 1001, env: { HOME: '/fake/home' } }
  const result = checkCodexLogin(options, {
    spawn: ((command, args, actualOptions) => {
      assert.equal(command, 'codex')
      assert.deepEqual(args, ['login', 'status'])
      assert.deepEqual(actualOptions, { ...options, stdio: 'ignore' })
      if (throws) throw new Error('secret spawn diagnostics')
      return child
    }) as typeof spawn,
    setTimeout: (callback, milliseconds) => {
      assert.equal(milliseconds, 10_000)
      timeout = callback
      scheduled++
      return 123 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: timer => {
      assert.equal(timer, 123)
      cleared++
    },
  })
  return { child, result, kills, fire: () => timeout(), cleared: () => cleared, scheduled: () => scheduled }
}

for (const [code, signal, message] of [
  [0, null, null],
  [1, null, 'Codex login probe failed (exit code 1)'],
  [2, null, 'Codex login probe failed (exit code 2)'],
  [127, null, 'Codex login probe failed (exit code 127)'],
  [null, null, 'Codex login probe failed (exit code unknown)'],
  [null, 'SIGKILL', 'Codex login probe failed (signal SIGKILL)'],
  [0, 'SIGTERM', 'Codex login probe failed (signal SIGTERM)'],
] as const) {
  test(`login close: code=${code}, signal=${signal}`, async () => {
    const p = probe()
    p.child.emit('close', code, signal)
    if (message) await assert.rejects(p.result, { message })
    else await p.result
    assert.equal(p.cleared(), 1)
    assert.deepEqual(p.kills, [])
    p.child.emit('error', new Error('secret late error'))
    p.fire()
    assert.deepEqual(p.kills, [])
    assert.equal(p.cleared(), 1)
  })
}

test('spawn error is static and survives a later close', async () => {
  const p = probe()
  p.child.emit('error', new Error('secret spawn diagnostics'))
  p.child.emit('close', 1, null)
  await assert.rejects(p.result, { message: 'Codex CLI is unavailable for the configured runner account' })
  assert.equal(p.cleared(), 1)
})

test('synchronous spawn failure is also sanitized', async () => {
  const p = probe(true)
  await assert.rejects(p.result, { message: 'Codex CLI is unavailable for the configured runner account' })
  assert.equal(p.scheduled(), 0)
})

for (const event of ['close', 'error'] as const) {
  test(`timeout kills once and survives subsequent ${event}`, async () => {
    const p = probe()
    // Exercise even a synchronous event from kill, after timeout has settled.
    p.child.kill = signal => {
      p.kills.push(signal)
      if (event === 'close') p.child.emit('close', null, 'SIGKILL')
      else p.child.emit('error', new Error('secret kill diagnostics'))
      return true
    }
    p.fire()
    await assert.rejects(p.result, { message: 'Codex login check timed out' })
    p.fire()
    assert.deepEqual(p.kills, ['SIGKILL'])
    assert.equal(p.cleared(), 1)
  })
}
