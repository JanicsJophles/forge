import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('log HTTP slices are bounded, lossless, resumable and strictly validated', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { taskLogRouter } = await import('./task-log.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())
  const insert = db.prepare("INSERT INTO tasks (id, repo, branch, prompt, log) VALUES (?, '/fake', 'test', 'test', ?)")
  const log = 'a😀é中\u0000\n'.repeat(30000)
  const expected = Buffer.from(log)
  insert.run('unicode', log)
  insert.run('empty', '')
  insert.run('null', null)
  const app = express().use('/tasks', taskLogRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  async function get(id: string, query = '', status = 200) {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks/${id}/log${query}`)
    assert.equal(response.status, status, query)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    return response.json()
  }
  const first = await get('unicode')
  assert.equal(first.offset, 0)
  assert.equal(first.nextOffset, 262144)
  assert.equal(first.totalBytes, expected.length)
  assert.deepEqual(Buffer.from(first.data, 'base64'), expected.subarray(0, 262144))
  const chunks: Buffer[] = []
  let offset = 0
  do {
    const slice = await get('unicode', `?offset=${offset}&limit=4093`)
    const bytes = Buffer.from(slice.data, 'base64')
    assert.ok(bytes.length <= 4093)
    assert.equal(slice.offset, offset)
    assert.equal(slice.nextOffset, offset + bytes.length)
    assert.equal(slice.totalBytes, expected.length)
    chunks.push(bytes)
    offset = slice.nextOffset
  } while (offset < expected.length)
  assert.deepEqual(Buffer.concat(chunks), expected)
  assert.deepEqual(await get('unicode', `?offset=${offset}`), {
    data: '', offset, nextOffset: offset, totalBytes: offset,
  })
  const appended = '追加🚀'
  db.prepare('UPDATE tasks SET log = log || ? WHERE id = ?').run(appended, 'unicode')
  const resumed = await get('unicode', `?offset=${offset}`)
  assert.deepEqual(Buffer.from(resumed.data, 'base64'), Buffer.from(appended))
  assert.equal(resumed.nextOffset, offset + Buffer.byteLength(appended))
  assert.equal(resumed.totalBytes, resumed.nextOffset)
  for (const id of ['unicode', 'empty', 'null']) {
    const totalBytes = id === 'unicode' ? resumed.totalBytes : 0
    for (const start of [totalBytes, totalBytes + 10, 2147483648, 4294967296, Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual(await get(id, `?offset=${start}&limit=1`), {
        data: '', offset: start, nextOffset: start, totalBytes,
      })
    }
  }
  for (const id of ['empty', 'null']) {
    assert.deepEqual(await get(id), { data: '', offset: 0, nextOffset: 0, totalBytes: 0 })
  }
  assert.equal(typeof (await get('missing', '', 404)).error, 'string')
  for (const name of ['offset', 'limit']) {
    for (const value of ['', '-1', '+1', ' 1', '1 ', '1.0', '1e2', '0x10', 'NaN', 'Infinity', '9007199254740992', '1x']) {
      assert.equal(typeof (await get('unicode', `?${name}=${encodeURIComponent(value)}`, 400)).error, 'string')
    }
    for (const suffix of ['=1&' + name + '=1', '[x]=1', '[]=1']) {
      await get('unicode', '?' + name + suffix, 400)
    }
  }
  await get('unicode', '?limit=0', 400)
  await get('unicode', '?limit=262145', 400)
  const one = await get('unicode', '?offset=2&limit=1')
  assert.deepEqual(Buffer.from(one.data, 'base64'), expected.subarray(2, 3))
})
