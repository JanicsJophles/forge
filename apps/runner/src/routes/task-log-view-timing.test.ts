import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
const functions = source.slice(source.indexOf('        var elapsedTimer;'), source.indexOf('        async function refreshTiming()'))
  .replace(/\\\\/g, '\\')
const refresh = source.slice(source.indexOf('        async function refreshTiming()'), source.indexOf('        async function refreshStatus('))
function fixture(fetch: any = async () => ({ ok: true, json: async () => ({}) })) {
  const elements = new Map<string, any>()
  let deadline: () => void = () => {}
  let cleared = false
  const context: any = {
    document: { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: '' })
      return elements.get(id)
    } },
    Date: class extends Date { static now() { return Date.parse('2026-11-10T09:00:00Z') } },
    statusVersion: 0, INITIAL_STATUS: 'running', fetch, AbortController, taskUrl: '/tasks/test',
    setTimeout(fn: () => void, ms: number) { assert.equal(ms, 5000); deadline = fn; return 1 },
    clearTimeout() { cleared = true },
  }
  runInNewContext(functions + refresh + ';this.render = timing; this.refresh = refreshTiming;', context)
  return { elements, render: context.render, refresh: context.refresh, deadline: () => deadline(), cleared: () => cleared }
}
const base = { createdAt: '2026-11-10 10:00:00', startedAt: '2026-11-10T10:01:00Z', completedAt: '2026-11-10T11:02:03+01:00' }
test('offline queued, running, completed and failed timing uses UTC consistently', () => {
  const v = fixture()
  for (const status of ['completed', 'failed']) {
    v.render({ ...base, status })
    assert.equal(v.elements.get('createdTime').textContent, '2026-11-10T10:00:00.000Z')
    assert.equal(v.elements.get('finishedTime').textContent, '2026-11-10T10:02:03.000Z')
    assert.equal(v.elements.get('duration').textContent, '63 s')
  }
  v.render({ status: 'queued' })
  assert.equal(v.elements.get('startedTime').textContent, 'Not started')
  assert.equal(v.elements.get('createdTime').textContent, 'Not recorded')
  v.render({ ...base, status: 'running', completedAt: null })
  assert.equal(v.elements.get('finishedTime').textContent, 'Not finished')
  assert.match(v.elements.get('duration').textContent, /Unavailable/)
})
test('invalid dates, missing values, zero duration and clock skew stay explicit', () => {
  const v = fixture()
  for (const invalid of ['bad', '2026-02-30 00:00:00', '2026-11-10', '<script>']) {
    v.render({ ...base, startedAt: invalid })
    assert.equal(v.elements.get('startedTime').textContent, 'Invalid timestamp')
    assert.match(v.elements.get('duration').textContent, /invalid timestamp/)
  }
  v.render({ ...base, completedAt: base.startedAt })
  assert.equal(v.elements.get('duration').textContent, '0 s')
  v.render({ ...base, completedAt: base.createdAt })
  assert.match(v.elements.get('duration').textContent, /clock skew/)
})
test('terminal refresh only updates timing and failed or hung reads retain it', async () => {
  for (const mode of ['success', 'http', 'reject', 'body', 'hung']) {
    let signal: AbortSignal | undefined
    const v = fixture(async (_url: string, options: any) => {
      assert.equal(_url, '/tasks/test?view=status')
      signal = options.signal
      if (mode === 'reject') throw new Error('offline')
      if (mode === 'hung') return new Promise(() => {})
      return { ok: mode !== 'http', json: () => mode === 'body' ? new Promise(() => {}) : Promise.resolve({ ...base, status: 'running' }) }
    })
    v.render({ ...base, completedAt: null })
    const before = v.elements.get('finishedTime').textContent
    const pending = v.refresh()
    await new Promise(resolve => setImmediate(resolve))
    if (mode === 'hung' || mode === 'body') { v.deadline(); assert.equal(signal?.aborted, true) }
    await pending
    assert.equal(v.cleared(), true)
    assert.equal(v.elements.has('status'), false)
    assert.equal(v.elements.get('finishedTime').textContent, mode === 'success' ? '2026-11-10T10:02:03.000Z' : before)
  }
  assert.match(source, /current.close\(\);\s+refreshTiming\(\);/)
  assert.equal(source.match(/refreshTiming\(\);/g)?.length, 2)
  assert.match(source, /substr\(created_at, 1, 64\)/)
})
