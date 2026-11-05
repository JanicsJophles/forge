import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

class Element {
  innerHTML = ''
  value = ''
  set textContent(value: unknown) {
    this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}

test('dashboard PR links honor owners, fall back for checkout paths, and reject hostile components', async () => {
  const original = process.env.GITHUB_ORG
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const { port } = server.address() as { port: number }
    for (const org of [undefined, 'custom-org', '\"><script>bad</script>?query#hash']) {
      if (org === undefined) delete process.env.GITHUB_ORG
      else process.env.GITHUB_ORG = org
      const html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
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
      const render = (repo: unknown, prNumber: unknown = 42) => {
        context.events = [{ eventType: 'pr_opened', repo, prNumber }]
        vm.runInContext('renderEvents(events)', context)
        return el('events').innerHTML
      }
      const link = (repo: unknown, expected: string | null, number: unknown = 42) => {
        const output = render(repo, number)
        const hrefs = [...output.matchAll(/href="([^"]*)"/g)].map(match => match[1])
        assert.deepEqual(hrefs, expected ? [expected] : [], `${String(repo)} with org ${org}`)
        assert.doesNotMatch(output, /<script>|<img|onclick=|onerror=/)
        if (expected) {
          const url = new URL(expected)
          assert.equal(url.origin, 'https://github.com')
          assert.equal(url.search, '')
          assert.equal(url.hash, '')
          assert.equal(url.pathname.split('/').length, 5)
        }
      }
      const fallback = org === undefined ? 'JanicsJophles' : org
      const validOrg = org === undefined || org === 'custom-org'
      for (const repo of ['project', '/opt/repos/project']) {
        link(repo, validOrg ? `https://github.com/${fallback}/project/pull/42` : null)
      }
      link('another-owner/project.name', 'https://github.com/another-owner/project.name/pull/42')
      for (const repo of [undefined, null, '', 'owner/', 'owner/repo/extra', 'owner/..', '.', '..',
        'owner/rep"o', 'owner/repo?query', 'owner/repo#hash', 'owner/repo%2fextra',
        '\"><script>bad</script>', 'owner?query/repo', 'owner#hash/repo', 'own"er/repo',
        '/opt/repos/repo?query', '//evil.example/repo']) link(repo, null)
      for (const number of ['42" onclick="bad', '42?query#hash', '<img src=x>', -1, 1.5, Infinity]) {
        // Markup in the PR label must remain text, even for direct renderer calls.
        const output = render('owner/repo', number)
        assert.doesNotMatch(output, /<a |<img/)
      }
      assert.match(render(null), /PR#42/)
    }
  } finally {
    if (original === undefined) delete process.env.GITHUB_ORG
    else process.env.GITHUB_ORG = original
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
