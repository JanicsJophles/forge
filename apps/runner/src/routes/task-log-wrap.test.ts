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
  let focused: any = null
  function element() {
    return {
      hidden: true, checked: true, value: '', textContent: '', scrollTop: 0, clientHeight: 100,
      children: [] as any[],
      // Deterministic wrapped text geometry, independent of browser layout.
      get scrollHeight(): number { return this.children.reduce((n, child) => n + child.textContent.length, 0) },
      get childNodes(): any[] { return this.children },
      getBoundingClientRect: () => ({ top: 0 }),
      appendChild(child: any) { this.children.push(child) },
      remove() {},
      focus() { focused = this },
    }
  }
  runInNewContext(script, {
    document: {
      get activeElement() { return focused },
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
      addRange: (r: any) => { ranges.push(r); focused = elements.get('log') },
    }) },
    EventSource: class {
      addEventListener(name: string, fn: (event: any) => void) { listeners.set(name, fn) }
      close() { closed = true }
    },
    sessionStorage: { getItem: () => '' },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'running' }) }),
  })
  await new Promise(resolve => setImmediate(resolve))
  elements.set('wrapLongLines', element())
  return {
    source, elements, listeners, ranges, created,
    focused: () => focused,
    query(text: string) { elements.get('findText').value = text; elements.get('findText').oninput() },
    next() { elements.get('findForm').onsubmit({ preventDefault() {} }) },
    previous() { elements.get('findPrevious').onclick() },
    feedback: () => elements.get('findResult').textContent,
    isClosed: () => closed,
    log: (text: string) => listeners.get('log')!({ data: JSON.stringify(text) }),
  }
}

test('native labelled wrap checkbox preserves the existing wrapped default and scopes CSS to transcript', async () => {
  const { source } = await viewer()
  assert.match(source, /<input type="checkbox" id="wrapLongLines" aria-controls="log" checked \/>/)
  assert.match(source, /<label for="wrapLongLines">Wrap long lines<\/label>/)
  assert.match(source, /#log\s*\{[^}]*overflow: auto;[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/)
  assert.match(source, /#wrapLongLines:not\(:checked\) ~ #log\s*\{ white-space: pre; overflow-wrap: normal; \}/)
  assert.match(source, /id="wrapLongLines"[^>]*>[\s\S]*<pre id="log"/)
  // Native Space activation and label activation require no script or storage.
  const script = source.match(/    <script>([\s\S]*?)<\/script>/)![1]
  assert.doesNotMatch(script, /wrapLongLines/)
})

test('both wrap settings preserve search, focus, pause, bounded output and replay state', async () => {
  for (const checked of [false, true]) {
    const v = await viewer()
    const wrap = v.elements.get('wrapLongLines')
    const log = v.elements.get('log')
    v.listeners.get('open')!({})
    v.log('needle ' + 'x'.repeat(128 * 1024))
    v.query('xxx')
    const node = log.children[0]
    const text = node.textContent
    const range = v.ranges[0]
    const feedback = v.feedback()
    const follow = v.elements.get('followStatus').textContent
    log.scrollTop = 1000
    log.onscroll()
    wrap.focus()
    wrap.checked = checked
    assert.equal(node.textContent, text)
    assert.equal(v.ranges[0], range)
    assert.equal(v.feedback(), feedback)
    assert.equal(v.elements.get('followStatus').textContent, follow)
    assert.equal(v.elements.get('findText').value, 'xxx')
    assert.equal(v.elements.get('omitted').hidden, false)
    v.log('tail')
    assert.equal(log.children.length, 1)
    assert.equal(node.textContent.length, 128 * 1024)
    assert.equal(log.scrollTop, 996)
    assert.match(v.elements.get('followStatus').textContent, /Paused/)
    assert.equal(v.focused(), wrap)
    v.listeners.get('error')!({})
    v.listeners.get('open')!({})
    v.log('fresh xxx')
    assert.equal(node.textContent, 'fresh xxx')
    assert.equal(wrap.checked, checked)
    assert.equal(v.elements.get('findText').value, 'xxx')
    assert.equal(v.feedback(), '1 / 1 in retained log')
    assert.equal(v.focused(), wrap)
    assert.equal(log.children.length, 1)
    // Replay retains the existing reset-to-follow behavior.
    v.elements.get('jumpLatest').onclick()
    v.log(' next')
    assert.equal(log.scrollTop, log.scrollHeight)
    assert.equal(v.elements.get('followStatus').textContent, 'Following latest output')
    wrap.checked = !checked
    assert.equal(node.textContent, 'fresh xxx next')
    assert.equal(v.focused(), wrap)
  }
})
