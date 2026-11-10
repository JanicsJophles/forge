import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('./dashboard.ts', import.meta.url), 'utf8')
const script = source.slice(source.indexOf("    const AUTH_TOKEN_KEY"), source.indexOf('    function escape'))

function harness(stored = '', storageAvailable = true) {
  const elements = new Map<string, any>()
  const el = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      value: '', style: { display: 'none' }, textContent: '',
      focus() { this.focused = true },
    })
    return elements.get(id)
  }
  const timers = new Map<number, () => void>()
  let timerId = 0
  let resolve!: (v: any) => void
  let reject!: (e: Error) => void
  const requests: any[] = []
  const context = vm.createContext({
    document: { getElementById: el }, AbortController,
    sessionStorage: {
      getItem: () => { if (!storageAvailable) throw Error('disabled'); return stored },
      setItem: (_: string, v: string) => { stored = v },
      removeItem: () => { stored = '' },
    },
    fetch: (url: string, options: any) => {
      requests.push({ url, options })
      return new Promise((yes, no) => { resolve = yes; reject = no })
    },
    setTimeout: (fn: () => void, ms: number) => {
      assert.equal(ms, 5000)
      timers.set(++timerId, fn)
      return timerId
    },
    clearTimeout: (id: number) => timers.delete(id),
  })
  vm.runInContext(script + '\nwireAuthToken(); revealAuthIfRequired();', context)
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return {
    el, timers, requests, settle,
    resolve: (v: any) => resolve(v), reject: () => reject(Error('offline')),
    token: () => vm.runInContext('authHeaders().Authorization', context),
    stored: () => stored,
    expire: async () => { for (const fn of [...timers.values()]) fn(); await settle() },
  }
}

for (const failure of ['rejected', 'non-OK', 'malformed', 'missing boolean', 'hung fetch', 'hung body']) {
  test(`auth discovery: ${failure} permits manual recovery without a stored token`, async () => {
    const h = harness()
    assert.equal(h.token(), undefined)
    // The manual control works immediately, even while discovery is pending.
    h.el('editAuthToken').onclick()
    assert.equal(h.el('authTokenRow').style.display, '')
    assert.equal(h.el('editAuthToken').ariaExpanded, 'true')
    assert.equal(h.el('authToken').focused, true)
    h.el('authToken').value = 'new-secret'
    h.el('authToken').oninput()
    assert.equal(h.stored(), 'new-secret')
    assert.equal(h.token(), 'Bearer new-secret')
    if (failure === 'rejected') h.reject()
    if (failure === 'non-OK') h.resolve({ ok: false })
    if (failure === 'malformed') h.resolve({ ok: true, json: async () => { throw Error('bad JSON') } })
    if (failure === 'missing boolean') h.resolve({ ok: true, json: async () => ({}) })
    if (failure === 'hung body') h.resolve({ ok: true, json: () => new Promise(() => {}) })
    await h.settle()
    if (failure.startsWith('hung')) await h.expire()
    assert.match(h.el('authDiscoveryStatus').textContent, /unknown/)
    assert.doesNotMatch(h.el('authDiscoveryStatus').textContent, /new-secret/)
    assert.equal(h.timers.size, 0)
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].url, '/capabilities')
    assert.equal(h.requests[0].options.headers, undefined)
    assert.equal(h.el('authTokenRow').style.display, '')
  })
}

test('auth discovery: confirmed off differs from unknown and still allows token editing', async () => {
  const h = harness('old-secret')
  h.resolve({ ok: true, json: async () => ({ authRequired: false }) })
  await h.settle()
  assert.match(h.el('authDiscoveryStatus').textContent, /authentication is off/)
  assert.equal(h.el('authTokenRow').style.display, 'none')
  h.el('editAuthToken').onclick()
  assert.equal(h.el('authToken').value, 'old-secret')
  h.el('authToken').value = ''
  h.el('authToken').oninput()
  assert.equal(h.token(), undefined)
})

test('auth discovery: late body cannot overwrite unknown status or manual entry', async () => {
  const h = harness('', false)
  let finish!: (v: any) => void
  h.resolve({ ok: true, json: () => new Promise(resolve => { finish = resolve }) })
  await h.settle()
  await h.expire()
  const status = h.el('authDiscoveryStatus').textContent
  h.el('editAuthToken').onclick()
  h.el('authToken').value = 'tab-only'
  h.el('authToken').oninput()
  finish({ authRequired: false })
  await h.settle()
  assert.equal(h.el('authDiscoveryStatus').textContent, status)
  assert.equal(h.token(), 'Bearer tab-only')
  assert.equal(h.requests[0].options.signal.aborted, true)
})
