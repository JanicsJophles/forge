import assert from 'node:assert/strict'
import { readFileSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express, { Router } from 'express'
import ts from 'typescript'

// Run the route with fake DB/query/stat dependencies; no native SQLite or live DB.
const source = readFileSync(new URL('./metrics.ts', import.meta.url), 'utf8')
const routeCode = ts.transpile(source.replace(/^import .*\n/gm, '').replace(/export /g, ''), {
  target: ts.ScriptTarget.ES2022,
})

test('SQLite disk metric resolves symlinks and isolates unavailable volumes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-metrics-data-')))
  const repo = join(root, 'repo')
  const data = join(root, 'data')
  mkdirSync(repo)
  mkdirSync(data)
  const database = join(data, 'forge.db')
  writeFileSync(database, '')
  const alias = join(repo, 'linked.db')
  symlinkSync(database, alias)
  const db = { name: alias }
  const failed = new Set<string>()
  const reads: string[] = []
  const stat = (path: string) => {
    reads.push(path)
    if (failed.has(path)) throw new Error('unavailable')
    assert.ok(path === repo || path === data)
    return (path === repo ? 120 : 45) * 1048576 + 123
  }
  const router = new Function('Router', 'dirname', 'realpathSync', 'db', 'config',
    'freeDiskBytes', 'countActiveProcs', 'countActiveTasks', 'oldestRunningTaskAgeSeconds',
    `${routeCode}\nreturn metricsRouter`)(Router, dirname, realpathSync, db,
      { allowedRepoPaths: [repo], maxConcurrentTasks: 3 }, stat, () => 1, () => 2, () => 30)
  const server = express().use(router).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const scrape = async () => {
      reads.length = 0
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`)
      assert.equal(response.status, 200)
      const [type, ...params] = response.headers.get('content-type')!.split(';').map(s => s.trim().toLowerCase())
      assert.equal(type, 'text/plain')
      assert.ok(params.includes('version=0.0.4'))
      assert.ok(params.every(p => p === 'version=0.0.4' || p === 'charset=utf-8'))
      const body = await response.text()
      for (const [name, value] of Object.entries({ active_tasks: 1, queued_or_running: 2,
        max_concurrent_tasks: 3, oldest_running_task_age_seconds: 30 })) {
        assert.match(body, new RegExp(`^forge_${name} ${value}$`, 'm'))
      }
      assert.match(body, /^forge_uptime_seconds \d+$/m)
      assert.ok(!body.includes(root))
      assert.ok(!body.includes('{'))
      return body
    }
    const gauge = (body: string, name: string, value: number) => {
      assert.match(body, new RegExp(`^# HELP ${name} .+$`, 'm'))
      assert.ok(body.includes(`# TYPE ${name} gauge\n${name} ${value}\n`))
    }
    let body = await scrape()
    gauge(body, 'forge_free_disk_mb', 120)
    gauge(body, 'forge_data_free_disk_mb', 45)
    assert.deepEqual(reads, [repo, data])

    failed.add(repo)
    body = await scrape()
    assert.ok(!body.includes('forge_free_disk_mb'))
    gauge(body, 'forge_data_free_disk_mb', 45)

    failed.clear()
    failed.add(data)
    body = await scrape()
    gauge(body, 'forge_free_disk_mb', 120)
    assert.ok(!body.includes('forge_data_free_disk_mb'))

    failed.clear()
    db.name = join(root, 'missing.db')
    body = await scrape()
    gauge(body, 'forge_free_disk_mb', 120)
    assert.ok(!body.includes('forge_data_free_disk_mb'))
    assert.deepEqual(reads, [repo])

    failed.add(repo)
    body = await scrape()
    assert.ok(!body.includes('forge_free_disk_mb'))
    assert.ok(!body.includes('forge_data_free_disk_mb'))
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
