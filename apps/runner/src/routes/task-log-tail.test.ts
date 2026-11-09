import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('log tailLines returns the last N lines, composes with format, validates strictly', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-tail-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { taskLogRouter } = await import('./task-log.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())
  const insert = db.prepare("INSERT INTO tasks (id, repo, branch, prompt, log) VALUES (?, '/fake', 'test', 'test', ?)")
  const trailing = 'line1\nline2\nline3\nline4\n'
  insert.run('lines', trailing)
  insert.run('notrail', 'alpha\nbeta\ngamma')
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
  const base = `http://127.0.0.1:${address.port}/tasks`
  async function getJson(id: string, query = '', status = 200) {
    const response = await fetch(`${base}/${id}/log${query}`)
    assert.equal(response.status, status, query)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    return response.json()
  }
  async function getRaw(id: string, query = '', status = 200) {
    const response = await fetch(`${base}/${id}/log${query}`)
    assert.equal(response.status, status, query)
    return response
  }

  // valid tail returns exactly the last N lines (default base64 JSON envelope)
  const two = await getJson('lines', '?tailLines=2')
  assert.deepEqual(Buffer.from(two.data, 'base64'), Buffer.from('line3\nline4\n'))
  assert.equal(two.totalBytes, Buffer.byteLength(trailing))
  assert.equal(two.nextOffset, two.totalBytes)
  assert.equal(two.offset, Buffer.byteLength('line1\nline2\n'))
  const one = await getJson('lines', '?tailLines=1')
  assert.deepEqual(Buffer.from(one.data, 'base64'), Buffer.from('line4\n'))

  // N larger than the available line count returns the whole log
  const all = await getJson('lines', '?tailLines=99')
  assert.deepEqual(Buffer.from(all.data, 'base64'), Buffer.from(trailing))
  assert.equal(all.offset, 0)
  assert.equal(all.nextOffset, all.totalBytes)

  // a log with no trailing newline still returns its final line
  assert.deepEqual(Buffer.from((await getJson('notrail', '?tailLines=1')).data, 'base64'), Buffer.from('gamma'))
  assert.deepEqual(Buffer.from((await getJson('notrail', '?tailLines=2')).data, 'base64'), Buffer.from('beta\ngamma'))

  // empty / null logs tail to nothing
  for (const id of ['empty', 'null']) {
    assert.deepEqual(await getJson(id, '?tailLines=3'), { data: '', offset: 0, nextOffset: 0, totalBytes: 0 })
  }

  // tailLines composes with format=text -> raw decoded tail with paging headers
  const rawTail = await getRaw('lines', '?tailLines=2&format=text')
  assert.equal(rawTail.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(rawTail.headers.get('x-total-bytes'), String(two.totalBytes))
  assert.equal(rawTail.headers.get('x-next-offset'), String(two.totalBytes))
  assert.deepEqual(Buffer.from(await rawTail.arrayBuffer()), Buffer.from('line3\nline4\n'))

  // invalid tailLines -> 400 (0, negatives, non-decimal, non-integer, unsafe, padded)
  for (const value of ['0', '-1', '+1', '1.0', '1e2', 'NaN', 'Infinity', 'abc', '', '0x10', '9007199254740992', ' 1', '1 ']) {
    assert.equal(typeof (await getJson('lines', `?tailLines=${encodeURIComponent(value)}`, 400)).error, 'string')
  }
  // repeated / structured tailLines -> 400
  for (const suffix of ['=1&tailLines=1', '[]=1', '[x]=1']) {
    await getJson('lines', '?tailLines' + suffix, 400)
  }

  // tailLines cannot be combined with the byte-slice params
  await getJson('lines', '?tailLines=2&offset=0', 400)
  await getJson('lines', '?tailLines=2&limit=10', 400)
  await getJson('lines', '?tailLines=2&offset=0&format=text', 400)

  // 404 for a missing task, in both encodings
  assert.equal(typeof (await getJson('missing', '?tailLines=2', 404)).error, 'string')
  assert.equal(typeof (await getJson('missing', '?tailLines=2&format=text', 404)).error, 'string')
})
