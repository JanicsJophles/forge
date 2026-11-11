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
  get textContent() { return this.innerHTML }
}

async function harness(search: string) {
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
  const pending: { url: string; resolve: (value: unknown) => void }[] = []
  const snapshot = { generatedAt: '2026-11-10T09:00:00Z', liveAgentsCount: 0,
    recentEventsCount: 0, liveAgents: [], recentEvents: [], liveByRepo: {} }
  let href = '/dashboard' + search
  const context = vm.createContext({
    window: { location: { search, pathname: '/dashboard' },
      history: { replaceState: (_state: unknown, _title: string, url: string) => { href = url } } },
    URLSearchParams, AbortController, Date,
    document: { getElementById: el, createElement: () => new Element() },
    fetch: (url: string) => url.startsWith('/tasks?')
      ? new Promise(resolve => pending.push({ url, resolve }))
      : Promise.resolve({ ok: true, json: async () => snapshot }),
    setTimeout: () => 1, clearTimeout: () => {},
  })
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  await flush()
  const select = (id: string, value: string) => { el(id).value = value; el(id).onchange() }
  return { el, context, pending, flush, select, href: () => href, hasAgent: html.includes('id="agentFilter"') }
}

test('URL filters round-trip encoded paths and hostile missing options without serializing launch state', async () => {
  const repo = '/opt/repos/a b/雪&?#'
  const hostile = '"><script>bad</script>&'
  const params = new URLSearchParams({ repo, ticket: hostile, eventType: hostile, activity: 'finished',
    agent: hostile, token: 'secret', prompt: 'private', provider: 'codex' })
  const h = await harness('?' + params)
  for (const [id, value] of [['repoFilter', repo], ['ticketFilter', hostile], ['eventTypeFilter', hostile]]) {
    assert.equal(h.el(id).value, value)
    assert.doesNotMatch(h.el(id).innerHTML, /<script>/)
  }
  assert.match(h.el('ticketFilter').innerHTML, /&quot;&gt;&lt;script&gt;/)
  assert.equal(h.el('activityFilter').value, 'finished')
  if (h.hasAgent) assert.equal(h.el('agentFilter').value, hostile)
  h.el('newTaskPrompt').value = 'draft stays'
  h.el('authToken').value = 'bearer stays'
  h.select('activityFilter', 'working')
  assert.equal(h.el('newTaskPrompt').value, 'draft stays')
  assert.equal(h.el('authToken').value, 'bearer stays')
  assert.doesNotMatch(h.href(), /secret|private|provider|token|prompt/)
  const copy = await harness(h.href().slice('/dashboard'.length))
  assert.equal(copy.el('repoFilter').value, repo)
  assert.equal(copy.el('ticketFilter').value, hostile)
  assert.equal(copy.el('eventTypeFilter').value, hostile)
  assert.equal(copy.el('activityFilter').value, 'working')
  if (copy.hasAgent) assert.equal(copy.el('agentFilter').value, hostile)
  vm.runInContext('refreshRecentTasks()', copy.context)
  assert.equal(copy.pending[0].url, '/tasks?limit=15&repo=' + encodeURIComponent(repo))
})

test('invalid activity defaults to all and repository changes fence old recent requests', async () => {
  const h = await harness('?repo=old&activity=bogus')
  assert.equal(h.el('activityFilter').value, 'all')
  assert.equal(h.href(), '/dashboard?repo=old')
  vm.runInContext('refreshRecentTasks()', h.context)
  h.select('repoFilter', 'new/path')
  assert.equal(h.pending.length, 2)
  assert.match(h.pending[1].url, /repo=new%2Fpath/)
  h.pending[1].resolve({ ok: true, json: async () => [{ id: 'new-task', repo: 'new/path', status: 'completed' }] })
  await h.flush()
  assert.match(h.el('recentTasks').innerHTML, /new-task/)
  h.pending[0].resolve({ ok: true, json: async () => [{ id: 'old-task', repo: 'old', status: 'completed' }] })
  await h.flush()
  assert.match(h.el('recentTasks').innerHTML, /new-task/)
  assert.doesNotMatch(h.el('recentTasks').innerHTML, /old-task/)
  for (const id of ['repoFilter', 'ticketFilter', 'eventTypeFilter']) h.select(id, '')
  assert.equal(h.href(), '/dashboard')
})
