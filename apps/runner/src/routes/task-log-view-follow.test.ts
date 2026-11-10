import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// Execute the actual inline client without importing the database-backed router.
async function viewer() {
  const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
  const script = source.match(/    <script>([\s\S]*?)<\/script>/)![1]
    .replace('${streamLiteral}', JSON.stringify('/tasks/test/stream'))
    .replace('${statusLiteral}', JSON.stringify('running'))
  const elements = new Map<string, any>()
  const listeners = new Map<string, (event: any) => void>()
  let closed = false
  function element() {
    return {
      hidden: true, value: '', textContent: '', scrollTop: 0, clientHeight: 100,
      children: [] as any[],
      // Deterministic wrapped text geometry, independent of browser layout.
      get scrollHeight(): number { return this.children.reduce((n, child) => n + child.textContent.length, 0) },
      appendChild(child: any) { this.children.push(child) },
      get childNodes() { return this.children },
      remove() {},
    }
  }
  runInNewContext(script, {
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createTextNode: (text: string) => ({ textContent: text }),
      createElement: element,
    },
    EventSource: class {
      addEventListener(name: string, fn: (event: any) => void) { listeners.set(name, fn) }
      close() { closed = true }
    },
    sessionStorage: { getItem: () => '' },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'running' }) }),
  })
  await new Promise(resolve => setImmediate(resolve))
  return {
    source, elements, listeners, isClosed: () => closed,
    log: (text: string) => listeners.get('log')!({ data: JSON.stringify(text) }),
  }
}

test('native jump control resumes following after scroll pause and prefix trimming', async () => {
  const v = await viewer()
  const log = v.elements.get('log')
  const feedback = v.elements.get('followStatus')
  const jump = v.elements.get('jumpLatest')
  assert.match(v.source, /<button type="button" id="jumpLatest" aria-controls="log">Jump to latest<\/button>/)
  v.log('a'.repeat(128 * 1024))
  log.scrollTop = 1000
  log.onscroll()
  assert.match(feedback.textContent, /Paused/)
  v.log('b'.repeat(100))
  assert.equal(log.scrollTop, 900)
  assert.match(feedback.textContent, /Paused/)
  v.log('c'.repeat(256 * 1024))
  assert.equal(log.scrollTop, 0)
  assert.equal(log.children.length, 1)
  assert.match(feedback.textContent, /Paused/)
  jump.onclick()
  assert.equal(log.scrollTop, log.scrollHeight)
  assert.equal(feedback.textContent, 'Following latest output')
  v.log('next')
  assert.equal(log.scrollTop, log.scrollHeight)
  log.scrollTop = 100
  log.onscroll() // Also covers programmatic find navigation away from the tail.
  v.log('paused again')
  assert.equal(log.scrollTop, 88)
  assert.match(feedback.textContent, /Paused/)
  log.scrollTop = log.scrollHeight - log.clientHeight
  log.onscroll()
  v.log('manual resume')
  assert.equal(log.scrollTop, log.scrollHeight)
  assert.equal(feedback.textContent, 'Following latest output')
})

test('empty, completed and failed transcripts retain a usable jump control', async () => {
  for (const terminal of ['complete', 'error']) {
    const v = await viewer()
    const log = v.elements.get('log')
    const jump = v.elements.get('jumpLatest')
    jump.onclick()
    v.log('')
    assert.equal(log.children.length, 0)
    assert.equal(v.elements.get('followStatus').textContent, 'Following latest output')
    v.log('x'.repeat(1000))
    log.scrollTop = 100
    log.onscroll()
    v.listeners.get(terminal)!({ data: JSON.stringify('failed') })
    assert.match(v.elements.get('followStatus').textContent, /Paused/)
    jump.onclick()
    assert.equal(log.scrollTop, log.scrollHeight)
    assert.equal(v.elements.get('followStatus').textContent, 'Following latest output')
    assert.equal(v.isClosed(), true)
  }
})

test('reconnect replay resets paused feedback and follows the replacement tail', async () => {
  const v = await viewer()
  const log = v.elements.get('log')
  v.listeners.get('open')!({})
  v.log('x'.repeat(256 * 1024))
  log.scrollTop = 1000
  log.onscroll()
  v.listeners.get('error')!({})
  assert.match(v.elements.get('followStatus').textContent, /Paused/)
  v.listeners.get('open')!({})
  assert.equal(log.children[0].textContent, '')
  assert.equal(v.elements.get('followStatus').textContent, 'Following latest output')
  assert.equal(v.elements.get('omitted').hidden, true)
  assert.equal(v.elements.get('replayNotice').hidden, false)
  v.log('fresh replay'.repeat(100))
  assert.equal(log.children.length, 1)
  assert.equal(log.children[0].textContent, 'fresh replay'.repeat(100))
  assert.equal(log.scrollTop, log.scrollHeight)
  v.log('live chunk')
  assert.equal(log.scrollTop, log.scrollHeight)
})
