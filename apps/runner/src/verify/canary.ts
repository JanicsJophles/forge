import assert from 'node:assert/strict'
import { fixture } from './fixtures.js'

for (const scenario of ['good PR', 'missing PR', 'failing gate', 'deleted test', 'committed secret']) {
  const f = fixture()
  try {
    if (scenario === 'missing PR') f.missingPR()
    if (scenario === 'deleted test') { f.remove('example.test.ts'); f.commit() }
    if (scenario === 'committed secret') { f.write('key', '-----BEGIN PRIVATE KEY-----'); f.commit() }
    const report = await f.verify(scenario === 'failing gate' ? { gate: 'exit 1' } : {})
    assert.equal(report.verified, scenario === 'good PR', scenario)
    console.log(`PASS ${scenario}`)
  } finally { f.cleanup() }
}
