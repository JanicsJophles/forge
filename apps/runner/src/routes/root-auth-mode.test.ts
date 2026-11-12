import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Request, Response } from 'express'
import { config } from '../config.js'
import { rootRouter } from './root.js'

const sentinel = 'sentinel-credential-<private>&never-render'

test('landing route renders static authentication modes without exposing credentials', () => {
  const original = config.authToken
  try {
    for (const token of [sentinel, undefined]) {
      Object.assign(config, { authToken: token })
      let html = ''
      const response = {
        type(value: string) {
          assert.equal(value, 'html')
          return this
        },
        send(value: string) { html = value },
      } as unknown as Response
      // Invoke the registered GET handler with a response fake: no listener,
      // authentication service, database or provider operations are needed.
      const route = rootRouter.stack.find(layer => layer.route?.path === '/')!.route!
      route.stack[0].handle({} as Request, response, () => assert.fail('unexpected next'))
      const statement = html.match(/<p id="mutation-auth-mode">([\s\S]*?)<\/p>/)![1]
      if (token) {
        assert.match(statement, /Mutations \(launches, retries and cancellations\) require a bearer token\./)
        assert.doesNotMatch(statement, /authentication is disabled/)
      } else {
        assert.match(statement, /Mutation authentication is disabled\./)
        assert.doesNotMatch(statement, /require a bearer token/)
      }
      assert.match(statement, /href="\/dashboard">dashboard<\/a> for task actions/)
      assert.match(statement, /Read views remain accessible\./)
      assert.ok(!html.includes(sentinel))
      assert.ok(!html.includes('sentinel-credential-'))
      const reads = [...html.matchAll(/readJson\('([^']+)'/g)].map(match => match[1])
      assert.ok(reads.includes('/health'))
      assert.ok(reads.includes('/tasks?limit=5'))
      assert.ok(reads.every(url => ['/health', '/tasks?limit=5', '/tasks/stats'].includes(url)))
    }
  } finally {
    Object.assign(config, { authToken: original })
  }
})
