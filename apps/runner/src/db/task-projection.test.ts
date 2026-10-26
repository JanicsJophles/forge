import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decodeTail } from './task-projection.js'

test('decodeTail passes ASCII through unchanged', () => {
  assert.equal(decodeTail(Buffer.from('hello world')), 'hello world')
})

test('decodeTail strips leading UTF-8 continuation bytes from a mid-codepoint tail', () => {
  // '€' encodes as E2 82 AC. A byte-suffix that begins partway through it starts
  // with the continuation bytes 82 AC, which decodeTail must drop before the
  // next whole codepoint ('ok') so the result is valid UTF-8.
  const tail = Buffer.concat([Buffer.from([0x82, 0xac]), Buffer.from('ok')])
  assert.equal(decodeTail(tail), 'ok')
})

test('decodeTail returns an empty string for an empty buffer', () => {
  assert.equal(decodeTail(Buffer.alloc(0)), '')
})
