import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask, TaskEvent } from '@forge/shared'
import { stderrLines } from './stderr-lines.js'

const dir = mkdtempSync(join(tmpdir(), 'forge-stderr-lines-'))
process.env.DATA_DIR = dir
process.env.ALLOWED_REPO_PATHS = dir
const { runTask, countActiveProcs } = await import('./runner.js')
const { insertTask, getTask } = await import('../db/queries.js')
const { createEmitter } = await import('./stream.js')
const { db } = await import('../db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

let nextId = 0
async function harness() {
  const task: AgentTask = { id: `stderr-${nextId++}`, repo: dir, branch: 'test',
    prompt: 'test', status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: false }
  insertTask(task)
  const emitter = createEmitter(task.id)
  const events: TaskEvent[] = []
  emitter.on('event', event => events.push(event))
  const child = new EventEmitter() as any
  child.stdin = new EventEmitter()
  child.stdin.end = () => {}
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  await runTask(task, emitter, {
    spawn: (() => child) as any,
    executionIdentity: (() => ({})) as any,
    gitPull: () => {}, gitCommit: () => null, setTimeout, clearTimeout,
  })
  const prefix = getTask(task.id)!.log
  events.length = 0
  return { child, check(expected: string) {
    assert.equal(getTask(task.id)!.log.slice(prefix.length), expected)
    assert.equal(events.filter(e => e.type === 'log').map(e => e.data).join(''), expected)
  } }
}

test('partial lines emit immediately; empty writes and blank lines preserve state', () => {
  const format = stderrLines()
  assert.equal(format(''), '')
  assert.equal(format('fa'), '[stderr] fa')
  assert.equal(format(''), '')
  assert.equal(format('iled\n\nnext'), 'iled\n\n[stderr] next')
  assert.equal(format('\n'), '\n')
  assert.equal(format('end'), '[stderr] end')
})

for (const text of ['', '\n\n', 'failed\n', '\n😀 café 漢\n\nnext\nfinal 🚀']) {
  test(`chunk-independent stderr: ${JSON.stringify(text)}`, async () => {
    const bytes = Buffer.from(text)
    const expected = text.split('\n').map(line => line ? `[stderr] ${line}` : '').join('\n')
    const partitions = [[bytes], Array.from(bytes, byte => Buffer.from([byte]))]
    for (let split = 0; split <= bytes.length; split++) {
      partitions.push([bytes.subarray(0, split), bytes.subarray(split)])
    }
    for (const chunks of partitions) {
      const h = await harness()
      for (const chunk of chunks) h.child.stderr.emit('data', chunk)
      h.child.emit('close', 0, null)
      h.child.emit('close', 0, null)
      h.check(expected)
      assert.equal(countActiveProcs(), 0)
    }
  })
}

test('flush preserves line state and independent decoders; close formats decoder tails', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = await harness()
  h.child.stderr.emit('data', Buffer.from('fa'))
  t.mock.timers.tick(500)
  h.check('[stderr] fa')
  h.child.stdout.emit('data', Buffer.from([0xf0, 0x9f]))
  h.child.stderr.emit('data', Buffer.from('iled\n\né'))
  h.child.stdout.emit('data', Buffer.from([0x98, 0x80]))
  h.child.stderr.emit('data', Buffer.from([0xe6, 0xbc]))
  h.child.emit('close', 0, null)
  h.check('[stderr] failed\n\n[stderr] é😀�')
})
