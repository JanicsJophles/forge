import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-board-')))
Object.assign(process.env, { DATA_DIR: root, ALLOWED_REPO_PATHS: root, FORGE_BOARD_TOKEN_GATEWAY: 'g'.repeat(48) })
for (const key of Object.keys(process.env)) if (key.startsWith('FORGE_RUNNER_TOKEN')) delete process.env[key]

const { config } = await import('../config.js')
const { createApp } = await import('../app.js')
const { boardTokensFromEnv } = await import('./board-auth.js')

const GATEWAY = 'g'.repeat(48), SESSIOND = 's'.repeat(48), DISPATCH = 'd'.repeat(48)
const servers: Server[] = []
after(() => { for (const s of servers) s.close() })

const quiet = { warn: () => {}, info: () => {} }
const app = createApp({ tokens: { ct207: DISPATCH }, ...quiet }, { tokens: { gateway: GATEWAY, sessiond: SESSIOND }, ...quiet })
const server = app.listen(0, '127.0.0.1'); servers.push(server)
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const json = { 'Content-Type': 'application/json' }
const bearer = (t: string) => ({ ...json, Authorization: `Bearer ${t}` })
const put = (id: string, headers: Record<string, string>, extra: object = {}) =>
  fetch(`${base}/agent-state/checkpoint`, { method: 'POST', headers, body: JSON.stringify({ agentId: id, agentType: 'project', repo: 'r', ...extra }) })
const row = async (id: string) => (await fetch(`${base}/agent-state/${id}`)).json() as Promise<{ writtenBy: string | null; intent?: string }>

test('config reads board tokens and drops them from the environment', () => {
  assert.deepEqual(config.boardTokens, { gateway: GATEWAY })
  assert.equal(process.env.FORGE_BOARD_TOKEN_GATEWAY, undefined)
  assert.deepEqual(boardTokensFromEnv({ FORGE_BOARD_TOKEN: 'a', FORGE_BOARD_TOKEN_X1: 'b', FORGE_BOARD_TOKENS: 'no', FORGE_BOARD_TOKEN_Y: ' ' }), { default: 'a', x1: 'b' })
})

test('anonymous writes still work and are unstamped', async () => {
  assert.equal((await put('anon-1', json)).status, 200)
  assert.equal((await row('anon-1')).writtenBy, null)
  // A task token or a wrong token is just anonymous on the board.
  assert.equal((await put('anon-2', bearer(DISPATCH))).status, 200)
  assert.equal((await row('anon-2')).writtenBy, null)
  assert.equal((await put('anon-3', bearer('nope'))).status, 200)
  assert.equal((await row('anon-3')).writtenBy, null)
  const ev = await fetch(`${base}/agent-events`, { method: 'POST', headers: bearer(DISPATCH), body: JSON.stringify({ eventType: 'x' }) })
  assert.equal(ev.status, 201)
})

test('a board token stamps the row; only that writer can change or delete it', async () => {
  assert.equal((await put('project-a', bearer(GATEWAY), { intent: 'real' })).status, 200)
  assert.equal((await row('project-a')).writtenBy, 'gateway')
  for (const headers of [json, bearer(SESSIOND), bearer(DISPATCH), bearer('nope')]) {
    assert.equal((await put('project-a', headers, { intent: 'planted' })).status, 403)
    assert.equal((await fetch(`${base}/agent-state/project-a`, { method: 'DELETE', headers })).status, 403)
  }
  assert.equal((await row('project-a')).intent, 'real')
  assert.equal((await put('project-a', bearer(GATEWAY), { intent: 'renewed' })).status, 200)
  assert.equal((await row('project-a')).intent, 'renewed')
  const del = await fetch(`${base}/agent-state/project-a`, { method: 'DELETE', headers: bearer(GATEWAY) })
  assert.deepEqual(await del.json(), { deleted: true })
})

test('a trusted writer takes over an anonymous row with the same id', async () => {
  assert.equal((await put('project-b', json, { intent: 'planted first' })).status, 200)
  assert.equal((await put('project-b', bearer(GATEWAY), { intent: 'real' })).status, 200)
  const r = await row('project-b')
  assert.equal(r.writtenBy, 'gateway')
  assert.equal((await put('project-b', json)).status, 403)
})

test('listings carry writtenBy', async () => {
  const rows = await (await fetch(`${base}/agent-state`)).json() as Array<{ agentId: string; writtenBy: string | null }>
  assert.equal(rows.find(r => r.agentId === 'project-b')?.writtenBy, 'gateway')
  assert.equal(rows.find(r => r.agentId === 'anon-1')?.writtenBy, null)
})

test('board tokens never pass the task check', async () => {
  const res = await fetch(`${base}/tasks`, { method: 'POST', headers: bearer(GATEWAY), body: JSON.stringify({ repo: root, prompt: 'x' }) })
  assert.equal(res.status, 401)
})
