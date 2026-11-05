import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AgentTask, TaskEvent } from '@forge/shared'

const dir = mkdtempSync(join(tmpdir(), 'forge-log-decoding-'))
process.env.DATA_DIR = dir
process.env.ALLOWED_REPO_PATHS = dir
const { runTask } = await import('./runner.js')
const { insertTask, getTask } = await import('../db/queries.js')
const { createEmitter } = await import('./stream.js')
const { db } = await import('../db/schema.js')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

let nextId = 0
async function harness() {
  const task: AgentTask = { id: `decode-${nextId++}`, repo: dir, branch: 'test',
    prompt: 'test', status: 'queued', log: '', createdAt: new Date().toISOString(), autoCommit: false }
  insertTask(task)
  const emitter = createEmitter(task.id)
  const events: TaskEvent[] = []
  let done = 0
  emitter.on('event', event => events.push(event))
  emitter.on('done', () => done++)
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
  return {
    child,
    check(expected: string, terminal = 'complete', persistedSuffix = '') {
      assert.equal(getTask(task.id)!.log.slice(prefix.length), expected + persistedSuffix)
      assert.equal(events.filter(e => e.type === 'log').map(e => e.data).join(''), expected)
      assert.equal(events.at(-1)?.type, terminal)
      assert.equal(done, 1)
    },
  }
}

const tag = (text: string) => text.split('\n').map(line => line ? `[stderr] ${line}` : '').join('\n')
for (const text of ['😀', 'é', '漢', 'Brain 😀 café 中文\n']) {
  const bytes = Buffer.from(text)
  for (let split = 1; split < bytes.length; split++) {
    test(`preserves ${JSON.stringify(text)} split at byte ${split}`, async t => {
      t.mock.timers.enable({ apis: ['setInterval'] })
      const h = await harness()
      h.child.stdout.emit('data', bytes.subarray(0, split))
      // A periodic flush must leave partial codepoints in the decoder.
      t.mock.timers.tick(500)
      h.child.stdout.emit('data', bytes.subarray(split))
      h.child.emit('close', 0, null)
      h.check(text)
    })
  }
}

test('independent decoders preserve bytewise interleaved streams and stderr tags', async () => {
  const h = await harness()
  const out = Buffer.from('😀é漢')
  const err = Buffer.from('界á🚀\n')
  // Expected output follows arrival of each completed codepoint.
  for (let i = 0; i < Math.max(out.length, err.length); i++) {
    if (i < out.length) h.child.stdout.emit('data', out.subarray(i, i + 1))
    if (i < err.length) h.child.stderr.emit('data', err.subarray(i, i + 1))
  }
  h.child.emit('close', 0, null)
  h.check('[stderr] 界😀[stderr] áé漢[stderr] 🚀\n')
})

test('stderr tagging retains chunk and newline behavior at every byte boundary', async () => {
  const text = '😀 café 漢\nnext\n'
  const bytes = Buffer.from(text)
  for (let split = 1; split < bytes.length; split++) {
    const h = await harness()
    h.child.stderr.emit('data', bytes.subarray(0, split))
    h.child.stderr.emit('data', bytes.subarray(split))
    h.child.emit('close', 0, null)
    // Decode only the complete prefix, then the remaining characters.
    let end = split
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
    h.check(tag(bytes.subarray(0, end).toString()) + tag(bytes.subarray(end).toString()))
  }
})

for (const terminal of ['close', 'error'] as const) {
  test(`drains incomplete final sequences before ${terminal} terminal event exactly once`, async () => {
    const h = await harness()
    h.child.stdout.emit('data', Buffer.from([0xf0, 0x9f]))
    h.child.stderr.emit('data', Buffer.from([0xe6, 0xbc]))
    if (terminal === 'error') h.child.emit('error', new Error('fake spawn failure'))
    else h.child.emit('close', 0, null)
    h.child.emit('close', 0, null)
    h.check('�[stderr] �', terminal === 'error' ? 'error' : 'complete',
      terminal === 'error' ? '[forge] failed to spawn claude: fake spawn failure. Check installation and login for the configured runner user.\n' : '')
  })
}
