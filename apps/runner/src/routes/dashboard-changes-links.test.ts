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

test('live and recent rows expose safe HTML changes links and preserve controls and repo filtering', async () => {
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
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    Date, AbortController,
    fetch: async () => { throw new Error('unused') },
    setTimeout: () => 1, clearTimeout: () => {},
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  const hostile = '\"><img src=x onerror="bad">/a?b#c&\''
  for (const [renderer, root] of [['renderTasks', 'tasks'], ['renderRecentTasks', 'recentTasks']]) {
    for (const status of ['queued', 'running', 'completed', 'failed']) {
      context.rows = [{ id: hostile, status, repo: 'forge' }]
      vm.runInContext(`${renderer}(rows)`, context)
      const output = el(root).innerHTML
      const links = [...output.matchAll(/<a\b[^>]*>/g)].map(match => match[0])
      assert.equal(links.length, renderer === 'renderRecentTasks' && status === 'failed' ? 3 : 2)
      for (const [index, suffix] of ['log/view', 'changes/view'].entries()) {
        assert.ok(links[index].includes(`href="/tasks/${encodeURIComponent(hostile)}/${suffix}"`))
        assert.match(links[index], /target="_blank"/)
        assert.match(links[index], /rel="noopener"/)
      }
      assert.doesNotMatch(output, /<img|href="[^"]*"bad/)
      assert.match(output, /&lt;img/)
      if (renderer === 'renderRecentTasks' && ['completed', 'failed'].includes(status)) {
        assert.match(output, /class="retry"/)
        assert.ok(output.includes(`data-task-id="${encodeURIComponent(hostile)}"`))
      }
    }
    for (const id of [undefined, null, '']) {
      context.rows = [{ id, status: 'failed' }]
      vm.runInContext(`${renderer}(rows)`, context)
      assert.doesNotMatch(el(root).innerHTML, /<a\b|class="retry"|class="cancel"/)
    }
  }

  context.rows = [
    { id: 'chosen-task', repo: 'forge', status: 'running' },
    { id: 'other-task', repo: 'brain', status: 'running' },
  ]
  vm.runInContext('latestSnapshot = { liveAgents: [], recentEvents: [], liveByRepo: {}, liveTasks: rows }; renderSnapshot()', context)
  el('repoFilter').value = 'forge'
  el('repoFilter').onchange()
  vm.runInContext('renderRecentTasks(rows)', context)
  for (const root of ['tasks', 'recentTasks']) {
    assert.match(el(root).innerHTML, /href="\/tasks\/chosen-task\/changes\/view"/)
    assert.doesNotMatch(el(root).innerHTML, /other-task/)
  }
  el('repoFilter').value = ''
  el('repoFilter').onchange()
  vm.runInContext('renderRecentTasks(rows)', context)
  for (const root of ['tasks', 'recentTasks']) {
    assert.match(el(root).innerHTML, /href="\/tasks\/other-task\/changes\/view"/)
  }
})
