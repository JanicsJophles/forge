import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

class Element {
  innerHTML = ''
  value = ''
  onchange = () => {}
  querySelectorAll() { return [] }
  set textContent(value: unknown) {
    this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}

test('recent failure previews bound Unicode, escape diagnostics, and retain good rows on malformed polls', async () => {
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    const { port } = server.address() as { port: number }
    html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  assert.match(html, /white-space: pre-wrap/)
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  let rows: unknown = []
  const requests: string[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let timerId = 0
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    Date, AbortController,
    setTimeout: (fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string) => {
      requests.push(url)
      if (url.endsWith('/retry')) return new Promise(() => {})
      return { ok: true, json: async () => rows }
    },
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  const poll = () => vm.runInContext('refreshRecentTasks()', context)
  const output = () => el('recentTasks').innerHTML
  const row = (id: string, errorMessage?: unknown, extra = {}) => ({ id, repo: 'forge', status: 'failed', errorMessage, ...extra })
  rows = [row('long/task', 'line\n' + '😀'.repeat(495) + 'OMITTED'),
    row('exact', '😀'.repeat(500)), row('hostile', '<img onerror="bad"> & </script>'),
    row('missing'), row('null', null), row('blank', ' \n\t'),
    row('completed', 'hidden diagnostic', { status: 'completed' }),
    row('other', 'other diagnostic', { repo: 'brain' })]
  await poll()
  assert.ok(output().includes('line\n' + '😀'.repeat(495) + '</div>'))
  assert.ok(output().includes('😀'.repeat(500) + '</div>'))
  assert.equal((output().match(/Diagnostic truncated/g) || []).length, 1)
  assert.equal((output().match(/no saved reason/g) || []).length, 3)
  assert.match(output(), /href="\/tasks\/long%2Ftask\/log\/view">Full saved failure context/)
  assert.match(output(), /&lt;img/)
  assert.doesNotMatch(output(), /OMITTED|<img|<\/script>|hidden diagnostic|\uD83D(?!\uDE00)/u)
  const good = output()
  for (const error of [42, {}, [], false]) {
    rows = [row('replacement', 'valid'), row('invalid', error)]
    await poll()
    assert.equal(output(), good)
    assert.match(el('recentHealth').innerHTML, /Recent tasks stale/)
  }
  // A pending retry keeps its original deadline when recent rows are rebuilt.
  const button = { dataset: { taskId: 'long%2Ftask' }, disabled: false, textContent: 'retry',
    closest: () => null, insertAdjacentElement: () => {} }
  context.button = button
  const pending = vm.runInContext('retryTask(button)', context)
  const deadline = [...timers.values()].find(t => t.ms === 15000)!
  rows = [row('long/task', 'updated\nreason')]
  await poll()
  assert.match(output(), /updated\nreason/)
  assert.match(output(), /disabled>retrying/)
  assert.equal([...timers.values()].find(t => t.ms === 15000), deadline)
  deadline.fn()
  await pending
  await poll()
  assert.match(output(), /Retry outcome unknown/)
  assert.doesNotMatch(output(), /disabled>retrying/)
  el('repoFilter').value = 'forge'
  el('repoFilter').onchange()
  rows = [row('selected', 'selected reason'), row('other', 'other diagnostic', { repo: 'brain' })]
  await poll()
  assert.match(output(), /selected reason/)
  assert.doesNotMatch(output(), /other diagnostic/)
  assert.ok(requests.every(url => url === '/agent-context' || url.startsWith('/tasks?limit=15') || url === '/tasks/long%2Ftask/retry'))
})
