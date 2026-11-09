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
  private text = ''
  set textContent(value: unknown) {
    this.text = String(value)
    this.innerHTML = this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  get textContent() { return this.text }
}

test('served dashboard scopes recent history and rejects late responses across repository changes', async () => {
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
  const requests: { url: string; resolve: (value: unknown) => void }[] = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    AbortController, Date,
    fetch: (url: string) => new Promise(resolve => requests.push({ url, resolve })),
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId },
    clearTimeout: (id: number) => timers.delete(id),
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  // Enable browser-only selection refresh after the unrelated startup wiring.
  vm.runInContext('window = {}; refreshRecentTasks()', context)
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const take = (url: string) => {
    const index = requests.findIndex(r => r.url === url)
    assert.ok(index >= 0, `missing request ${url}`)
    return requests.splice(index, 1)[0]
  }
  const respond = async (request: ReturnType<typeof take>, rows: unknown[]) => {
    request.resolve({ ok: true, json: async () => rows })
    await settle()
  }
  const select = (repo: string) => { el('repoFilter').value = repo; el('repoFilter').onchange() }
  const row = (id: string, repo: string) => ({ id, repo, status: 'failed' })
  await respond(take('/tasks?limit=15'), [row('old-task', 'other')])
  assert.match(el('recentTasks').innerHTML, /data-task-id="old-task"/)
  const repo = 'owner/repo & space'
  const url = '/tasks?limit=15&repo=' + encodeURIComponent(repo)
  select(repo)
  assert.doesNotMatch(el('recentTasks').innerHTML, /old-task|retry/)
  assert.equal(el('recentCount').textContent, '0')
  const stale = take(url)
  select('other')
  const other = take('/tasks?limit=15&repo=other')
  select(repo)
  const current = take(url)
  await respond(current, [row('chosen-task', repo), row('unrelated-task', 'other')])
  assert.match(el('recentTasks').innerHTML, /chosen-task/)
  assert.doesNotMatch(el('recentTasks').innerHTML, /unrelated-task/)
  assert.equal(el('recentCount').textContent, '1')
  const timerCount = timers.size
  await respond(stale, [row('stale-task', repo)])
  await respond(other, [row('other-task', 'other')])
  assert.match(el('recentTasks').innerHTML, /chosen-task/)
  assert.doesNotMatch(el('recentTasks').innerHTML, /stale-task|other-task/)
  assert.equal(timers.size, timerCount, 'stale responses must not fork polling loops')
  select('empty')
  await respond(take('/tasks?limit=15&repo=empty'), [])
  assert.match(el('recentTasks').innerHTML, /no recent tasks for this repository/)
  assert.equal(el('recentCount').textContent, '0')
  select('')
  await respond(take('/tasks?limit=15'), [row('all-one', repo), row('all-two', 'other')])
  assert.match(el('recentTasks').innerHTML, /all-one/)
  assert.match(el('recentTasks').innerHTML, /all-two/)
  assert.equal(el('recentCount').textContent, '2')
})
