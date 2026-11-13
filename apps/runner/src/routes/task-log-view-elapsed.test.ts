import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
const start = '2026-11-13T05:00:00Z'
const flush = () => new Promise(resolve => setImmediate(resolve))
function viewer(status = 'running', startedAt: string | null = start) {
  let now = Date.parse(start) + 2000
  let next = 0
  const timers = new Map<number, { fn: () => void, at: number }>()
  const elements = new Map<string, any>()
  const listeners = new Map<string, (event: any) => void>()
  const pages = new Map<string, () => void>()
  const requests: Array<(value: any) => void> = []
  function element(): any { return { textContent: '', value: '', hidden: true, disabled: false, childNodes: [], appendChild() {}, remove() {} } }
  elements.set('startedTime', { ...element(), textContent: startedAt })
  const script = source.match(/    <script>([\s\S]*?)<\/script>/)![1]
    .replace(/\\\\/g, '\\')
    .replace('${streamLiteral}', JSON.stringify('/tasks/test/stream'))
    .replace('${statusLiteral}', JSON.stringify(status))
  runInNewContext(script, {
    Date: class extends Date { static now() { return now } },
    document: { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    }, createElement: element, createTextNode: element },
    window: { addEventListener(name: string, fn: () => void) { pages.set(name, fn) } },
    sessionStorage: { getItem: () => '' }, AbortController,
    setTimeout(fn: () => void, ms: number) { timers.set(++next, { fn, at: now + ms }); return next },
    clearTimeout(id: number) { timers.delete(id) },
    EventSource: class { addEventListener(name: string, fn: (e: any) => void) { listeners.set(name, fn) }; close() {} },
    fetch: () => new Promise(resolve => requests.push(resolve)),
  })
  return {
    text: (id = 'duration') => elements.get(id)?.textContent,
    tick(ms = 1000) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() } },
    event(name: string, data = '') { listeners.get(name)!({ data: JSON.stringify(data) }) },
    respond(index: number, task: any) { requests[index]({ ok: true, json: async () => task }) },
    fail(index: number) { requests[index]({ ok: false }) },
    dispose() { pages.get('pagehide')!() },
    requestCount: () => requests.length,
  }
}
test('initial saved running start advances locally without polling and stops on disposal', () => {
  const v = viewer()
  assert.equal(v.text('durationLabel'), 'Elapsed')
  assert.equal(v.text(), '2 s')
  v.tick(); assert.equal(v.text(), '3 s')
  assert.equal(v.requestCount(), 1)
  v.dispose(); v.tick(10000); assert.equal(v.text(), '3 s')
})
test('queued read becomes running and terminal recorded duration survives a late running read', async () => {
  const v = viewer('queued', null)
  assert.equal(v.text(), 'Not started')
  v.event('complete')
  v.respond(1, { status: 'completed', startedAt: start, completedAt: '2026-11-13T05:00:07Z', commitSha: 'saved' })
  await flush()
  v.respond(0, { status: 'running', startedAt: start, commitSha: null })
  await flush(); v.tick(10000)
  assert.equal(v.text(), '7 s')
  assert.equal(v.text('durationLabel'), 'Duration')
  assert.equal(v.text('recordedCommit'), 'saved')
})
test('queued-to-running status read starts elapsed timing', async () => {
  const v = viewer('queued', null)
  v.respond(0, { status: 'queued', startedAt: null })
  await flush()
  v.event('status', 'running')
  v.respond(1, { status: 'running', startedAt: start })
  await flush(); v.tick()
  assert.equal(v.text(), '3 s')
})
test('failed initial read keeps ticking; terminal failure stops even when timing refresh fails', async () => {
  const v = viewer()
  v.fail(0); await flush(); v.tick()
  assert.equal(v.text(), '3 s')
  v.event('error', 'failed'); v.fail(1); await flush(); v.tick(10000)
  assert.equal(v.text(), '3 s')
  assert.equal(v.text('durationLabel'), 'Elapsed (stopped)')
})
test('missing, invalid and future starts give explicit feedback', () => {
  for (const [value, expected] of [[null, /not recorded/], ['bad', /invalid timestamp/], ['2026-11-13T06:00:00Z', /clock skew/]] as const) {
    const v = viewer('running', value)
    assert.match(v.text(), expected)
    v.tick(); assert.match(v.text(), expected)
    v.dispose()
  }
})
test('disposal fences late timing and status responses', async () => {
  const v = viewer()
  v.dispose()
  v.respond(0, { status: 'running', startedAt: start, commitSha: 'late' })
  await flush(); v.tick(10000)
  assert.equal(v.text(), '2 s')
  assert.notEqual(v.text('recordedCommit'), 'late')
})
