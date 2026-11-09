import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

async function viewer() {
  const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
  const script = source.match(/    <script>([\s\S]*?)<\/script>/)![1]
    .replace('${streamLiteral}', JSON.stringify('/tasks/test/stream'))
    .replace('${statusLiteral}', JSON.stringify('running'))
  const elements = new Map<string, any>()
  const listeners = new Map<string, (event: any) => void>()
  let closed = false
  function element(text = ''): any {
    let value = text
    return {
      hidden: true, value: '', scrollTop: 0, clientHeight: 100, childNodes: [] as any[],
      get textContent(): string { return value + this.childNodes.map((n: any) => n.textContent).join('') },
      set textContent(text: string) { value = text; this.childNodes = [] },
      get scrollHeight(): number { return this.textContent.length },
      appendChild(child: any) { this.childNodes.push(child); child.parent = this },
      remove() {
        if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((n: any) => n !== this)
      },
    }
  }
  runInNewContext(script, {
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createTextNode: (text: string) => element(text), createElement: () => element(),
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
    elements, source, closed: () => closed,
    event: (name: string, text?: string) => listeners.get(name)!(text === undefined ? {} : { data: JSON.stringify(text) }),
  }
}

test('successful reopen replaces replay across repeated network failures with inert Unicode text', async () => {
  const v = await viewer()
  const log = v.elements.get('log')
  const replay = 'hello 😀 日本語 <img src=x onerror=alert(1)>\n'
  v.event('open')
  v.event('log', replay)
  v.event('error')
  assert.equal(log.textContent, replay, 'network error alone retains output')
  assert.equal(v.closed(), false)
  for (let i = 0; i < 5; i++) {
    const retainedNode = log.childNodes[0]
    const omitted = v.elements.get('omitted')
    if (omitted) omitted.hidden = false
    v.event('open')
    assert.equal(log.childNodes[0], retainedNode, 'retained transcript node remains valid for the DOM cap')
    assert.equal(log.textContent, '')
    assert.equal(v.elements.get('omitted').hidden, true)
    assert.equal(v.elements.get('replayNotice').hidden, false)
    v.event('log', replay)
    v.event('log', 'live\n')
    assert.equal(log.textContent, replay + 'live\n')
    assert.equal(log.scrollTop, log.scrollHeight)
    assert.ok(log.childNodes.length <= 3, 'empty nodes do not accumulate on reconnect')
    v.event('error')
  }
  assert.doesNotMatch(v.source, /\.innerHTML/)
  assert.match(v.source, /earlier displayed output was replaced/)
  assert.equal(v.elements.get('cancel').hidden, false)
  v.event('complete')
  assert.equal(v.closed(), true)
  assert.equal(v.elements.get('retry').hidden, false)
  v.event('open')
  assert.equal(log.textContent, replay + 'live\n', 'terminal streams cannot reset')
})

test('empty replay clears stale output; terminal failure closes and preserves controls', async () => {
  const v = await viewer()
  const log = v.elements.get('log')
  v.event('open')
  v.event('log', 'old output\n'.repeat(100))
  log.scrollTop = 0
  v.event('log', 'unpinned\n')
  assert.equal(log.scrollTop, 0, 'ordinary output preserves paused autoscroll')
  v.event('error')
  v.event('open')
  v.event('log', '')
  assert.equal(log.textContent, '')
  v.event('error', 'failed 😀 <script>bad</script>')
  assert.equal(log.textContent, 'failed 😀 <script>bad</script>')
  assert.equal(v.elements.get('status').textContent, 'failed')
  assert.equal(v.elements.get('cancel').hidden, true)
  assert.equal(v.elements.get('retry').hidden, false)
  assert.equal(v.closed(), true)
})
