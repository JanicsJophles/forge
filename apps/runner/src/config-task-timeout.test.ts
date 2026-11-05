import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask } from '@forge/shared'

const dir = mkdtempSync(join(tmpdir(), 'forge-timeout-'))
process.env.DATA_DIR = dir
process.env.ALLOWED_REPO_PATHS = dir
process.env.DOTENV_CONFIG_PATH = '/dev/null'
delete process.env.TASK_TIMEOUT_MS
const { config } = await import('./config.js')
const { runTask, countActiveProcs } = await import('./agent/runner.js')
const { insertTask, getTask } = await import('./db/queries.js')
const { createEmitter } = await import('./agent/stream.js')
const { db } = await import('./db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const cases: [string | undefined, number, boolean][] = [
  [undefined, 1800000, false], ['1', 1, false], ['60000', 60000, false],
  ['2147483647', 2147483647, false],
  ...['2147483648', '99999999999999999999', '9'.repeat(400), '', '0', '-1',
    'NaN', 'Infinity', '1.5', '100ms', '1e3', '0x10', ' 100 ']
    .map(value => [value, 1800000, true] as [string, number, boolean]),
]

for (const [index, [raw, expected, invalid]] of cases.entries()) {
  test(`timeout config and scheduling: ${raw?.slice(0, 24) ?? 'missing'}`, async () => {
    if (raw === undefined) delete process.env.TASK_TIMEOUT_MS
    else process.env.TASK_TIMEOUT_MS = raw
    const warnings: string[] = []
    const originalWarn = console.warn
    let validated: typeof config
    try {
      console.warn = message => warnings.push(String(message))
      ;({ config: validated } = await import(`./config.js?timeout-case=${index}`))
    } finally {
      console.warn = originalWarn
    }
    assert.equal(validated.taskTimeoutMs, expected)
    assert.deepEqual(warnings, invalid ? ['[config] Invalid TASK_TIMEOUT_MS; using default 1800000.'] : [])
    Object.assign(config, { taskTimeoutMs: validated.taskTimeoutMs })
    // Changing the raw environment after config loads must not bypass validation.
    process.env.TASK_TIMEOUT_MS = '2147483648'
    const task: AgentTask = { id: `timeout-${index}`, repo: dir, branch: 'test',
      prompt: 'test', status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: false }
    insertTask(task)
    const child = new EventEmitter() as any
    child.stdin = new EventEmitter()
    child.stdin.end = () => {}
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const signals: string[] = []
    child.kill = (signal: string) => { signals.push(signal); return true }
    const timers: { callback: () => void; delay: number; cleared: boolean }[] = []
    await runTask(task, createEmitter(task.id), {
      spawn: (() => child) as any,
      executionIdentity: (() => ({})) as any,
      gitPull: () => {}, gitCommit: () => null,
      setTimeout: ((callback: () => void, delay: number) => {
        const timer = { callback, delay, cleared: false, unref() {} }
        timers.push(timer)
        return timer
      }) as any,
      clearTimeout: ((timer: any) => { timer.cleared = true }) as any,
    })
    try {
      assert.deepEqual(timers.map(timer => timer.delay), [expected])
      assert.deepEqual(signals, [])
      timers[0].callback()
      assert.deepEqual(signals, ['SIGTERM'])
      assert.equal(timers[1].delay, 10000)
      assert.match(getTask(task.id)!.errorMessage!, new RegExp(`timed out after ${expected}ms`))
      timers[1].callback()
      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    } finally {
      child.emit('close', null, 'SIGKILL')
    }
    assert.equal(countActiveProcs(), 0)
    assert.ok(timers.every(timer => timer.cleared))
  })
}
