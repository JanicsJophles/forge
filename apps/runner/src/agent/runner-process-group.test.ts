import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask } from '@forge/shared'
import { signalProvider } from './process-group.js'

const dir = mkdtempSync(join(tmpdir(), 'forge-group-'))
process.env.DATA_DIR = dir
const { runTask, killTask, countActiveProcs } = await import('./runner.js')
const { insertTask, getTask } = await import('../db/queries.js')
const { createEmitter } = await import('./stream.js')
const { db } = await import('../db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('group signaling uses only the owned negative PID and tolerates vanished groups', () => {
  const signals: unknown[] = []
  const child = { pid: 123456, kill: () => assert.fail('must signal group'), emit: () => {} } as any
  signalProvider(child, 'SIGTERM', ((pid: number, signal: string) => {
    signals.push([pid, signal]); return true
  }) as any)
  assert.deepEqual(signals, [[-123456, 'SIGTERM']])
  signalProvider(child, 'SIGKILL', (() => { throw Object.assign(new Error(), { code: 'ESRCH' }) }) as any)
  for (const pid of [undefined, 0, 1, -10, process.pid]) {
    signalProvider({ pid, kill: () => true } as any, 'SIGTERM', (() => assert.fail('unsafe group')) as any)
  }
})

for (const inheritPipes of [true, false]) {
  test(`Linux descendants stop after ${inheritPipes ? 'cancellation with inherited pipes' : 'timeout after close'}`, {
    skip: process.platform !== 'linux', timeout: 10000,
  }, async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const unrelatedClosed = once(unrelated, 'close')
    let provider: ReturnType<typeof spawn> | undefined
    const timers: { callback: () => void }[] = []
    try {
      const task: AgentTask = { id: `group-${inheritPipes}`, repo: dir, branch: 'test', prompt: 'fixture',
        status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: false }
      insertTask(task)
      const emitter = createEmitter(task.id)
      const done = once(emitter, 'done')
      let ready!: () => void
      const started = new Promise<void>(resolve => { ready = resolve })
      let childPid = 0
      let output = ''
      const childCode = `process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 1000)`
      const parentCode = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: ['ignore', '${inheritPipes ? 'inherit' : 'ignore'}', 'ignore', 'ipc'] });
        child.once('message', pid => process.stdout.write(String(pid) + '\\n'));
        process.on('SIGTERM', () => process.exit(0));
        setInterval(() => {}, 1000);
      `
      await runTask(task, emitter, {
        spawn: ((_command: unknown, _args: unknown, options: any) => {
          assert.equal(options.detached, true)
          provider = spawn(process.execPath, ['-e', parentCode], options)
          provider.stdout!.on('data', data => {
            output += data.toString()
            if (output.includes('\n')) { childPid = Number(output.trim()); ready() }
          })
          return provider
        }) as typeof spawn,
        executionIdentity: (() => ({})) as any,
        gitPull: () => {}, gitCommit: () => assert.fail('no commit'),
        setTimeout: ((callback: () => void) => {
          const timer = { callback, unref() {} }; timers.push(timer); return timer
        }) as any,
        clearTimeout: (() => {}) as any,
      })
      await started
      assert.ok(childPid > 1)
      const exited = once(provider!, 'exit')
      const closed = once(provider!, 'close')
      if (inheritPipes) assert.equal(killTask(task.id), true)
      else timers[0].callback()
      await exited
      if (!inheritPipes) await closed
      assert.equal(countActiveProcs(), 1, 'capacity remains reserved through escalation')
      assert.equal(getTask(task.id)!.status, 'running')
      process.kill(childPid, 0)
      timers[1].callback()
      await closed
      await done
      assert.equal(countActiveProcs(), 0)
      assert.equal(getTask(task.id)!.status, 'failed')
      assert.match(getTask(task.id)!.errorMessage!, inheritPipes ? /cancelled/ : /timed out/)
      // Linux may retain an orphan zombie briefly; it cannot execute or hold pipes.
      const { readFileSync, existsSync } = await import('node:fs')
      const stat = `/proc/${childPid}/stat`
      for (let attempt = 0; existsSync(stat) && !/^\d+ \(.*\) Z /.test(readFileSync(stat, 'utf8')) && attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      if (existsSync(stat)) assert.match(readFileSync(stat, 'utf8'), /^\d+ \(.*\) Z /)
      assert.equal(unrelated.exitCode, null)
      assert.equal(unrelated.signalCode, null)
      process.kill(unrelated.pid!, 0)
    } finally {
      if (provider?.pid) signalProvider(provider, 'SIGKILL')
      unrelated.kill('SIGKILL')
      await unrelatedClosed
    }
  })
}
