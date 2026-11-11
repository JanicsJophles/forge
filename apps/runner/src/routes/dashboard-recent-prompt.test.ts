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

test('recent saved prompts stay bounded and inert through polling, filtering and stale responses', async () => {
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    const { port } = server.address() as { port: number }
    html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  const elements = new Map<string, Element>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  let rows: unknown = []
  const requests: string[] = []
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    Date, AbortController, setTimeout: () => 1, clearTimeout: () => {},
    fetch: async (url: string) => {
      requests.push(url)
      return { ok: true, json: async () => rows }
    },
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  const poll = () => vm.runInContext('refreshRecentTasks()', context)
  const output = () => el('recentTasks').innerHTML
  const row = (id: string, prompt?: unknown, extra = {}) => ({ id, repo: 'forge', status: 'failed', prompt, ...extra })
  rows = [row('normal', '  fix\n\t the   runner  '), row('hostile', '<img src=x onerror="bad"> & </script>'),
    row('missing'), row('blank', ' \n\t'), row('malformed', 42), row('server', 'saved', { promptTruncated: true }),
    row('long', 'a'.repeat(159) + '😀' + 'omitted'), row('exact', '😀'.repeat(160)),
    row('other', 'hidden prompt', { repo: 'brain' })]
  await poll()
  assert.match(output(), /fix the runner/)
  assert.doesNotMatch(output(), /<img|<\/script>/)
  assert.match(output(), /&lt;img/)
  assert.equal((output().match(/No saved prompt/g) || []).length, 3)
  assert.equal((output().match(/prompt truncated/g) || []).length, 2)
  assert.ok(output().includes('a'.repeat(159) + '😀<span'))
  assert.ok(output().includes('😀'.repeat(160) + '</div>'))
  assert.doesNotMatch(output(), /omitted|\uD83D(?!\uDE00)/u)
  assert.match(output(), /class="retry"/)
  el('repoFilter').value = 'forge'
  el('repoFilter').onchange()
  await poll()
  assert.doesNotMatch(output(), /hidden prompt/)
  rows = [row('normal', 'replacement prompt')]
  await poll()
  assert.match(output(), /replacement prompt/)
  assert.doesNotMatch(output(), /fix the runner|prompt truncated|No saved prompt/)
  const last = output()
  rows = { malformed: true }
  await poll()
  assert.equal(output(), last)
  assert.match(el('recentHealth').innerHTML, /Recent tasks stale/)
  assert.deepEqual(requests, ['/agent-context', '/tasks?limit=15', ...Array(3).fill('/tasks?limit=15&repo=forge')])
})
