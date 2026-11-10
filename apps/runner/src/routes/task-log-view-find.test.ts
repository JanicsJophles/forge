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
  const ranges: any[] = []
  const created: any[] = []
  function element() {
    return {
      hidden: true, value: '', textContent: '', scrollTop: 0, clientHeight: 100,
      children: [] as any[],
      // Deterministic wrapped text geometry, independent of browser layout.
      get scrollHeight(): number { return this.children.reduce((n, child) => n + child.textContent.length, 0) },
      get childNodes(): any[] { return this.children },
      getBoundingClientRect: () => ({ top: 0 }),
      appendChild(child: any) { this.children.push(child) },
      remove() {},
    }
  }
  runInNewContext(script, {
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createRange() {
        const range = {
          start: -1, end: -1, node: null as any,
          setStart(node: any, start: number) { this.node = node; this.start = start },
          setEnd(node: any, end: number) { assert.equal(node, this.node); this.end = end },
          getBoundingClientRect() { return { top: this.start } },
        }
        created.push(range)
        return range
      },
      createTextNode: (text: string) => ({ textContent: text }),
      createElement: element,
    },
    window: { getSelection: () => ({
      get rangeCount() { return ranges.length },
      getRangeAt: (i: number) => ranges[i],
      removeRange: (r: any) => { ranges.splice(ranges.indexOf(r), 1) },
      removeAllRanges: () => { ranges.length = 0 },
      addRange: (r: any) => ranges.push(r),
    }) },
    EventSource: class {
      addEventListener(name: string, fn: (event: any) => void) { listeners.set(name, fn) }
      close() { closed = true }
    },
    sessionStorage: { getItem: () => '' },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'running' }) }),
  })
  await new Promise(resolve => setImmediate(resolve))
  return {
    source, elements, listeners, ranges, created,
    query(text: string) { elements.get('findText').value = text; elements.get('findText').oninput() },
    next() { elements.get('findForm').onsubmit({ preventDefault() {} }) },
    previous() { elements.get('findPrevious').onclick() },
    feedback: () => elements.get('findResult').textContent,
    isClosed: () => closed,
    log: (text: string) => listeners.get('log')!({ data: JSON.stringify(text) }),
  }
}

test('literal find spans frames, wraps in both directions, and uses only one range', async () => {
  const v = await viewer()
  v.log('noise fail')
  v.log('ure <img> .* failure')
  v.query('failure')
  assert.equal(v.feedback(), '1 / 2 in retained log')
  assert.equal(v.ranges[0].start, 6)
  v.next()
  assert.equal(v.feedback(), '2 / 2 in retained log')
  v.next()
  assert.equal(v.feedback(), '1 / 2 in retained log')
  v.previous()
  assert.equal(v.feedback(), '2 / 2 in retained log')
  let prevented = false
  v.elements.get('findText').onkeydown({ key: 'Enter', shiftKey: true, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(v.feedback(), '1 / 2 in retained log')
  for (const query of ['<img>', '.*']) {
    v.query(query)
    assert.equal(v.feedback(), '1 / 1 in retained log')
    const range = v.ranges[0]
    assert.equal(range.node.textContent.slice(range.start, range.end), query)
  }
  assert.equal(v.elements.get('log').children.length, 1)
  assert.equal(v.ranges.length, 1)
})

test('empty, absent, and case-sensitive queries ignore controls and auth', async () => {
  const v = await viewer()
  v.log('Failure')
  v.elements.get('authToken').value = 'secret'
  for (const query of ['failure', 'secret', 'Auth token', '[']) {
    v.query(query)
    assert.equal(v.feedback(), 'No matches in retained log')
    assert.equal(v.elements.get('findNext').disabled, true)
    assert.equal(v.elements.get('findPrevious').disabled, true)
    assert.equal(v.ranges.length, 0)
    v.next()
  }
  v.query('Failure')
  v.query('')
  assert.equal(v.feedback(), 'Enter text to find')
  assert.equal(v.ranges.length, 0)
  assert.match(v.source, /label for="findText"/)
  assert.match(v.source, /Earlier omitted output is not searched/)
})

test('append and prefix eviction refresh offsets without stealing the reading position', async () => {
  const v = await viewer()
  const log = v.elements.get('log')
  v.log('needle' + 'x'.repeat(128 * 1024 - 12) + 'needle')
  const node = log.children[0]
  v.query('needle')
  v.next()
  log.scrollTop = 1000
  const oldRange = v.ranges[0]
  v.log('abc')
  assert.equal(log.scrollTop, 997)
  assert.equal(v.feedback(), '1 / 1 in retained log')
  assert.notEqual(v.ranges[0], oldRange)
  assert.equal(v.ranges[0].start, 128 * 1024 - 9)
  v.log('x'.repeat(128 * 1024))
  assert.equal(v.feedback(), 'No matches in retained log')
  assert.equal(v.ranges.length, 0)
  assert.equal(log.children[0], node)
  v.log('nee')
  v.log('dle')
  assert.equal(v.feedback(), '1 / 1 in retained log')
  assert.equal(v.ranges[0].end, node.textContent.length)
})

test('reconnect replay clears old ranges and searches only replacement text', async () => {
  const v = await viewer()
  v.listeners.get('open')!({})
  v.log('old needle')
  const node = v.elements.get('log').children[0]
  v.query('needle')
  v.listeners.get('error')!({})
  v.listeners.get('open')!({})
  assert.equal(v.ranges.length, 0)
  assert.equal(v.feedback(), 'No matches in retained log')
  v.log('new needle needle')
  assert.equal(v.feedback(), '1 / 2 in retained log')
  assert.equal(v.elements.get('log').children[0], node)
  assert.equal(v.ranges[0].start, 4)
})

test('dense matches keep one text node and one active range; clearing resumes tail-follow', async () => {
  const v = await viewer()
  v.log('x'.repeat(128 * 1024))
  const log = v.elements.get('log')
  v.query('x')
  assert.equal(v.feedback(), '1 / 131072 in retained log')
  assert.equal(log.children.length, 1)
  assert.equal(v.ranges.length, 1)
  // Even at the bottom, an active match pauses tail-follow.
  log.scrollTop = log.scrollHeight
  v.log('x')
  assert.equal(log.scrollTop, log.scrollHeight - 1)
  assert.equal(v.ranges.length, 1)
  v.query('')
  v.log('y')
  assert.equal(log.scrollTop, log.scrollHeight)
  assert.equal(v.ranges.length, 0)
})
