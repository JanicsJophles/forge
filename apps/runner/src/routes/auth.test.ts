import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, Server } from 'node:http'

// config.ts and db/schema.ts read env at import time, so set it up first.
// Canonical (macOS tmpdir is behind a symlink): task repos must be written in canonical form.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-auth-')))
const dataDir = path.join(root, 'data'), binDir = path.join(root, 'bin'), repo = path.join(root, 'repo')
fs.mkdirSync(dataDir); fs.mkdirSync(binDir); fs.mkdirSync(repo)
Object.assign(process.env, {
  DATA_DIR: dataDir, ALLOWED_REPO_PATHS: root, CLAUDE_RUN_USER: os.userInfo().username, MAX_CONCURRENT_TASKS: '50',
  PATH: `${binDir}:${process.env.PATH}`,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
})
for (const key of Object.keys(process.env)) if (key.startsWith('FORGE_RUNNER_TOKEN')) delete process.env[key]
// Fake agent: stays alive briefly so a DELETE has something to cancel.
fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nsleep 2\nexit 0\n', { mode: 0o755 })
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
git('init', '-q'); fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')

const { createApp } = await import('../app.js')
const { needsToken, bearerToken, tokensFromEnv } = await import('./auth.js')
const q = await import('../db/queries.js')

const TOKEN = 'a'.repeat(16) + 'B-._~+/' + '9'.repeat(16) + '=='
const servers: Server[] = []
after(() => { for (const s of servers) s.close() })

type Logs = { warn: string[]; info: string[] }
async function start(token: string | Record<string, string> | undefined, now?: () => number): Promise<{ base: string; port: number; logs: Logs }> {
  const logs: Logs = { warn: [], info: [] }
  const tokens = typeof token === 'string' ? { default: token } : token ?? {}
  const app = createApp({ tokens, now, warn: m => logs.warn.push(m), info: m => logs.info.push(m) })
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise(resolve => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, port, logs }
}

const secured = await start(TOKEN)
const open = await start(undefined)

const json = { 'Content-Type': 'application/json' }
const taskBody = () => JSON.stringify({ repo, prompt: 'hello', autoCommit: false })

function seedTask(status: 'queued' | 'completed' = 'queued'): string {
  const id = `seed-${Math.random().toString(36).slice(2)}`
  q.insertTask({ id, repo, branch: 'main', prompt: 'p', status, log: '', createdAt: new Date().toISOString(), provider: 'claude', autoCommit: false })
  return id
}

// Tasks created through POST /tasks (seeded ones use prompt 'p').
const taskCount = () => q.listTasks(10_000).filter(t => t.prompt === 'hello').length

/** Send bytes exactly as written, so header casing, spacing and repeats are not normalised by a client. */
function raw(port: number, head: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([...head, 'Host: 127.0.0.1', 'Content-Length: 0', 'Connection: close', '', ''].join('\r\n'))
    })
    let data = ''
    socket.on('data', chunk => { data += chunk })
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1])))
    socket.on('error', reject)
  })
}

// Every state-changing task/repo route, including ones that do not exist yet:
// deny-by-default must refuse them before routing.
const mutating: Array<{ method: string; path: () => string }> = [
  { method: 'POST', path: () => '/tasks' },
  { method: 'DELETE', path: () => `/tasks/${seedTask()}` },
  { method: 'POST', path: () => `/tasks/${seedTask()}/retry` },
  { method: 'PATCH', path: () => `/tasks/${seedTask()}` },
  { method: 'PUT', path: () => '/repos' },
  { method: 'POST', path: () => '/repos/sync' },
  { method: 'POST', path: () => '/TASKS' },
  { method: 'POST', path: () => '/tasks/' },
]

test('needsToken: writes need it, reads and agent-board writes do not', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) assert.equal(needsToken(m, '/tasks'), false, m)
  assert.equal(needsToken('POST', '/agent-state/checkpoint'), false)
  assert.equal(needsToken('DELETE', '/agent-state/agent-1'), false)
  assert.equal(needsToken('POST', '/agent-events'), false)
  assert.equal(needsToken('POST', '/Agent-Events/'), false)
  for (const p of ['/tasks', '/tasks/x', '/repos', '/agent-state', '/agent-state/../tasks', '/agent-events/x', '/anything']) {
    assert.equal(needsToken('POST', p), true, p)
  }
  assert.equal(needsToken('DELETE', '/agent-state/a/b'), true)
  assert.equal(needsToken('PUT', '/agent-state/checkpoint'), true)
})

test('bearerToken parses one well-formed credential and nothing else', () => {
  const req = (...pairs: string[]) => {
    const headers: Record<string, string> = {}
    for (let i = 0; i < pairs.length; i += 2) headers[pairs[i].toLowerCase()] ??= pairs[i + 1]
    return { rawHeaders: pairs, headers } as unknown as IncomingMessage
  }
  assert.equal(bearerToken(req('Authorization', 'Bearer abc')), 'abc')
  assert.equal(bearerToken(req('authorization', 'bearer abc')), 'abc')
  assert.equal(bearerToken(req('AUTHORIZATION', 'BEARER    abc   ')), 'abc')
  assert.equal(bearerToken(req('Authorization', `Bearer ${TOKEN}`)), TOKEN)
  for (const bad of ['', 'Bearer', 'Bearer ', 'Basic abc', 'Bearerabc', 'Bearer a b', 'Bearer a,Bearer b', 'Bearer a\tb', `Bearer ${'x'.repeat(5000)}`, 'Token abc']) {
    assert.equal(bearerToken(req('Authorization', bad)), undefined, JSON.stringify(bad.slice(0, 30)))
  }
  assert.equal(bearerToken(req()), undefined)
  assert.equal(bearerToken(req('Authorization', 'Bearer abc', 'authorization', 'Bearer abc')), undefined)
})

test('token set: every mutating route refuses a missing or wrong token with a bare 401', async () => {
  const before = taskCount()
  const wrong = [undefined, 'Bearer nope', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Basic ${TOKEN}`, TOKEN, 'Bearer ']
  for (const route of mutating) {
    for (const authorization of wrong) {
      const headers: Record<string, string> = { ...json }
      if (authorization !== undefined) headers.Authorization = authorization
      const res = await fetch(secured.base + route.path(), { method: route.method, headers, body: taskBody() })
      assert.equal(res.status, 401, `${route.method} ${route.path()} with ${authorization}`)
      assert.equal(res.headers.get('www-authenticate'), 'Bearer')
      assert.deepEqual(await res.json(), { error: 'unauthorized' })
    }
  }
  assert.equal(taskCount(), before, 'no task was created by a refused request')
})

test('token set: correct token passes through to the route', async () => {
  const auth = { ...json, Authorization: `Bearer ${TOKEN}` }
  const created = await fetch(`${secured.base}/tasks`, { method: 'POST', headers: auth, body: taskBody() })
  assert.equal(created.status, 201)
  const { taskId } = await created.json() as { taskId: string }
  assert.ok(q.getTask(taskId))

  const cancelled = await fetch(`${secured.base}/tasks/${seedTask()}`, { method: 'DELETE', headers: auth })
  assert.equal(cancelled.status, 200)
  assert.deepEqual(await cancelled.json(), { ok: true })

  // Authorised but invalid body reaches the handler's own validation.
  const invalid = await fetch(`${secured.base}/tasks`, { method: 'POST', headers: auth, body: '{}' })
  assert.equal(invalid.status, 400)
  // Authorised request to a route that does not exist gets the normal 404.
  const missing = await fetch(`${secured.base}/tasks/x/retry`, { method: 'POST', headers: auth })
  assert.equal(missing.status, 404)
})

test('token set: reads, streams and agent-board routes stay open', async () => {
  const done = seedTask('completed')
  for (const p of ['/health', '/tasks', '/tasks/capabilities', `/tasks/${done}`, `/tasks/${done}?view=status`, `/tasks/${done}/stream`,
    '/repos', '/dashboard', '/agent-state', '/agent-events', '/agent-context']) {
    const res = await fetch(secured.base + p)
    assert.equal(res.status, 200, p)
    await res.text()
  }
  const head = await fetch(`${secured.base}/health`, { method: 'HEAD' })
  assert.equal(head.status, 200)

  const cp = await fetch(`${secured.base}/agent-state/checkpoint`, { method: 'POST', headers: json, body: JSON.stringify({ agentId: 'auth-test' }) })
  assert.equal(cp.status, 200)
  const ev = await fetch(`${secured.base}/agent-events`, { method: 'POST', headers: json, body: JSON.stringify({ eventType: 'agent_started' }) })
  assert.equal(ev.status, 201)
  const del = await fetch(`${secured.base}/agent-state/auth-test`, { method: 'DELETE' })
  assert.equal(del.status, 200)
})

test('token set: header variants are parsed strictly and repeated headers are refused', async () => {
  const req = (auth: string[]) => raw(secured.port, ['POST /tasks/nope/retry HTTP/1.1', ...auth])
  // 404 = past auth (the route does not exist); 401 = refused by auth.
  assert.equal(await req([`Authorization: Bearer ${TOKEN}`]), 404)
  assert.equal(await req([`authorization: bearer ${TOKEN}`]), 404)
  assert.equal(await req([`AUTHORIZATION:   BEARER   ${TOKEN}   `]), 404)
  assert.equal(await req([`Authorization: Bearer ${TOKEN}`, `Authorization: Bearer ${TOKEN}`]), 401)
  assert.equal(await req([`Authorization: Bearer ${TOKEN}`, 'authorization: Bearer nope']), 401)
  assert.equal(await req(['Authorization: Bearer nope', `Authorization: Bearer ${TOKEN}`]), 401)
  assert.equal(await req([`Authorization: Bearer ${TOKEN}, Bearer ${TOKEN}`]), 401)
  assert.equal(await req([`Authorization: Bearer\t${TOKEN}`]), 401)
  assert.equal(await req([`X-Authorization: Bearer ${TOKEN}`]), 401)
})

test('token set: logs say auth is on, name the caller and never contain the token', async () => {
  assert.equal(secured.logs.warn.filter(line => !line.startsWith('[auth] refused ')).length, 0)
  assert.match(secured.logs.info[0], /runner tokens set \(default\)/)
  assert.ok(secured.logs.info.some(line => line === '[auth] POST /tasks by default'))
  assert.ok(secured.logs.warn.some(line => /^\[auth\] refused POST \/tasks from 127\.0\.0\.1/.test(line)))
  for (const line of [...secured.logs.warn, ...secured.logs.info]) assert.ok(!line.includes(TOKEN))
  const short = await start('short-token')
  assert.equal(short.logs.warn.length, 1)
  assert.match(short.logs.warn[0], /shorter than 32/)
  assert.ok(!short.logs.warn[0].includes('short-token'))
  // A token outside the bearer alphabet can never be sent, so say so at startup.
  const unsendable = 'x'.repeat(32) + '!$ #'
  const bad = await start(unsendable)
  assert.equal(bad.logs.warn.length, 1)
  assert.match(bad.logs.warn[0], /cannot carry/)
  assert.ok(!bad.logs.warn[0].includes(unsendable))
  const refused = await fetch(`${bad.base}/tasks`, { method: 'POST', headers: { ...json, Authorization: `Bearer ${unsendable}` }, body: taskBody() })
  assert.equal(refused.status, 401)
})

test('token unset: behaves as before and warns once', async () => {
  assert.equal(open.logs.warn.length, 1)
  assert.match(open.logs.warn[0], /FORGE_RUNNER_TOKEN is not set/)
  const created = await fetch(`${open.base}/tasks`, { method: 'POST', headers: json, body: taskBody() })
  assert.equal(created.status, 201)
  const cancelled = await fetch(`${open.base}/tasks/${seedTask()}`, { method: 'DELETE' })
  assert.equal(cancelled.status, 200)
  // A stray header is ignored exactly as before.
  const withJunk = await fetch(`${open.base}/tasks`, { method: 'POST', headers: { ...json, Authorization: 'Bearer whatever' }, body: '{}' })
  assert.equal(withJunk.status, 400)
  assert.equal((await fetch(`${open.base}/tasks/nope/retry`, { method: 'POST' })).status, 404)

  for (const blank of ['', '   ']) {
    const s = await start(blank)
    assert.equal(s.logs.warn.length, 1, 'blank token counts as unset')
    assert.equal((await fetch(`${s.base}/tasks/${seedTask()}`, { method: 'DELETE' })).status, 200)
  }
})

test('default options read the runner tokens through config', async () => {
  const { config } = await import('../config.js')
  assert.deepEqual(config.runnerTokens, {})
})

test('tokensFromEnv: one token per caller name, blanks and look-alikes ignored', () => {
  assert.deepEqual(tokensFromEnv({
    FORGE_RUNNER_TOKEN: ' t-default ', FORGE_RUNNER_TOKEN_BRIDGE: 't-bridge', FORGE_RUNNER_TOKEN_CT207: 't-local',
    FORGE_RUNNER_TOKEN_MAC: '  ', FORGE_RUNNER_TOKENX: 'no', FORGE_RUNNER_TOKEN_lower: 'no', FORGE_RUNNER_TOKEN_: 'no', OTHER: 'no',
  }), { default: 't-default', bridge: 't-bridge', ct207: 't-local' })
  assert.deepEqual(tokensFromEnv({}), {})
})

test('named tokens: each caller is accepted under its own name, others are refused', async () => {
  const BRIDGE = 'b'.repeat(48), MAC = 'm'.repeat(48)
  let clock = 0
  const s = await start({ bridge: BRIDGE, mac: MAC }, () => clock)
  assert.match(s.logs.info[0], /runner tokens set \(bridge, mac\)/)
  for (const [token, name] of [[BRIDGE, 'bridge'], [MAC, 'mac']]) {
    const res = await fetch(`${s.base}/tasks/${seedTask()}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200, name)
    assert.match(s.logs.info.at(-1)!, new RegExp(`^\\[auth\\] DELETE /tasks/seed-[a-z0-9]+ by ${name}$`))
  }
  for (const wrong of [TOKEN, 'b'.repeat(47), `${BRIDGE}${MAC}`]) {
    const res = await fetch(`${s.base}/tasks`, { method: 'POST', headers: { ...json, Authorization: `Bearer ${wrong}` }, body: taskBody() })
    assert.equal(res.status, 401)
  }
  // Refusals are logged at most once a minute, with a count of the ones skipped.
  assert.equal(s.logs.warn.length, 1)
  clock = 60_000
  assert.equal((await fetch(`${s.base}/tasks`, { method: 'POST' })).status, 401)
  assert.equal(s.logs.warn.length, 2)
  assert.match(s.logs.warn[1], /\(3 refusals since the last line\)$/)
  for (const line of [...s.logs.warn, ...s.logs.info]) assert.ok(!line.includes(BRIDGE) && !line.includes(MAC))
})
