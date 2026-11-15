import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixture } from './fixtures.js'

for (const scenario of ['good PR', 'missing PR', 'failing gate', 'deleted test', 'committed secret']) {
  const f = fixture()
  try {
    if (scenario === 'missing PR') f.missingPR()
    if (scenario === 'deleted test') { f.remove('example.test.ts'); f.commit() }
    if (scenario === 'committed secret') { f.write('key', '-----BEGIN PRIVATE KEY-----'); f.commit() }
    const report = await f.verify(scenario === 'failing gate' ? { gate: 'exit 1' } : {})
    assert.equal(report.verified, scenario === 'good PR', scenario)
    assert.equal(report.verdict, scenario === 'good PR' ? 'verified' : 'unverified', scenario)
    console.log(`PASS ${scenario}`)
  } finally { f.cleanup() }
}

// Exercise real runner completion, caps, GET/list and terminal stream replay.
const wire = spawnSync(process.execPath, ['--import', 'tsx', '--test',
  fileURLToPath(new URL('./storage.test.ts', import.meta.url))], { encoding: 'utf8' })
assert.equal(wire.status, 0, wire.stdout + wire.stderr)
console.log('PASS compatible wire statuses, failure reasons and capped reports')
