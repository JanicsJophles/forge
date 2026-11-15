import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fixture, policy } from './fixtures.js'
import { enforceCaps, resolveLimits } from './caps.js'

const scenarios: [string, (f: ReturnType<typeof fixture>) => void, boolean][] = [
  ['good PR', () => {}, true],
  ['missing PR', f => f.missingPR(), false],
  ['wrong PR head', f => f.pr({ headRefOid: 'wrong' }), false],
  ['closed PR', f => f.pr({ state: 'CLOSED' }), false],
  ['non draft PR', f => f.pr({ isDraft: false }), false],
  ['missing remote branch', f => { f.git('push', 'origin', '--delete', 'feature') }, false],
  ['deleted test', f => { f.remove('example.test.ts'); f.commit() }, false],
  ['justified deleted test', f => { f.remove('example.test.ts'); f.commit(); f.pr({ body: 'test-change: obsolete suite' }) }, true],
  ['new skip', f => { f.write('example.test.ts', "test.skip('works', () => {})\n"); f.commit() }, false],
  ['secret', f => { f.write('key.txt', '-----BEGIN PRIVATE KEY-----\n'); f.commit() }, false],
  ['env file', f => { f.write('.env.production', 'A=B\n'); f.commit() }, false],
  ['workflow', f => { f.write('.github/workflows/build.yml', 'name: build\n'); f.commit() }, false],
]
for (const [name, setup, expected] of scenarios) test(name, async () => {
  const f = fixture()
  try { setup(f); assert.equal((await f.verify()).verified, expected) } finally { f.cleanup() }
})
test('gate captures real exit and tail, file fallback, timeout', async () => {
  const f = fixture()
  try {
    let r = await f.verify({ gate: 'echo gate-failed; exit 7' })
    assert.equal(r.verified, false)
    assert.equal(r.gate?.exit, 7)
    assert.match(r.gate!.tail, /gate-failed/)
    f.write('.forge/gate', 'echo success')
    assert.equal((await f.verify()).gate?.exit, 0)
    r = await f.verify({ gate: 'sleep 10' }, { ...policy, gateTimeoutMs: 30 })
    assert.equal(r.gate?.exit, 124)
  } finally { f.cleanup() }
})
test('PR opt out and absent claim', async () => {
  const f = fixture()
  try {
    f.missingPR()
    assert.equal((await f.verify({ verify: false })).verified, true)
    assert.equal((await f.verify({ prompt: 'Change a file' })).verified, true)
    assert.equal((await f.verify({ output: 'done' })).verified, false)
  } finally { f.cleanup() }
})
test('removed cases and assertions are reported, dependencies warn, custom rules block', async () => {
  const f = fixture()
  try {
    f.write('example.test.ts', '// empty\n')
    f.write('package.json', '{"dependencies":{"new-package":"1.0.0"}}')
    f.commit()
    const r = await f.verify()
    assert.equal(r.verified, true)
    for (const name of ['removed test case', 'removed assertions', 'dependencies']) assert.ok(r.checks.some(c => c.name === name && !c.ok && c.warning))
    assert.equal((await f.verify({}, { ...policy, forbiddenPatterns: ['empty'] })).verified, false)
  } finally { f.cleanup() }
})
test('missing base fails closed', async () => {
  const f = fixture()
  try { assert.equal((await f.verify({ base: 'missing' })).verified, false) } finally { f.cleanup() }
})
for (const kind of ['untracked secret', 'modified test', 'gate mutation']) test(`${kind} cannot bypass committed diff inspection`, async () => {
  const f = fixture()
  try {
    if (kind === 'untracked secret') f.write('private-key', '-----BEGIN PRIVATE KEY-----\n')
    if (kind === 'modified test') f.write('example.test.ts', "test.skip('works', () => {})\n")
    const report = await f.verify(kind === 'gate mutation' ? { gate: 'echo changed >> feature.txt' } : {})
    assert.equal(report.verified, false)
    assert.equal(report.checks.find(c => c.name === 'working tree')?.ok, false)
  } finally { f.cleanup() }
})
test('request caps cannot exceed owner maximum', () => {
  const limits = { maxWallMinutes: 1, maxOutputBytes: 100 }
  assert.throws(() => resolveLimits({ repo: '', prompt: '', maxOutputBytes: 101 }, limits, limits))
  assert.throws(() => resolveLimits({ repo: '', prompt: '', maxWallMinutes: NaN }, limits, limits))
  assert.equal(resolveLimits({ repo: '', prompt: '', maxOutputBytes: 10 }, limits, limits).maxOutputBytes, 10)
})
for (const kind of ['wall', 'output']) test(`${kind} cap terminates process group`, async () => {
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => process.stdout.write("abcdef"), 5)'], { detached: true })
  let reason = ''
  const caps = enforceCaps(proc, { maxWallMinutes: kind === 'wall' ? 0.002 : 1, maxOutputBytes: kind === 'output' ? 3 : 100000 }, r => { reason = r })
  proc.stdout.on('data', data => caps.consume(data))
  await new Promise<void>(resolve => proc.on('close', () => resolve()))
  caps.dispose()
  assert.match(reason, kind === 'wall' ? /wall time/ : /output/)
})
test('branch claims, allowlists and workflow permission', async () => {
  const f = fixture()
  try {
    f.write('.github/workflows/build.yml', 'name: build\n')
    f.write('package.json', '{"dependencies":{"allowed":"1.0.0"}}')
    f.commit()
    const r = await f.verify({ output: 'Created branch: `feature`', allowedDependencies: ['allowed'] }, { ...policy, allowWorkflows: true })
    assert.equal(r.verified, true)
    assert.ok(r.checks.find(c => c.name === 'dependencies')?.ok)
  } finally { f.cleanup() }
})
test('cap escalates when agent ignores SIGTERM', async () => {
  const proc = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { detached: true })
  let reason = ''
  const caps = enforceCaps(proc, { maxWallMinutes: 1, maxOutputBytes: 1 }, r => { reason = r })
  proc.stdout.on('data', data => caps.consume(data))
  const signal = await new Promise<string | null>(resolve => proc.on('close', (_code, signal) => resolve(signal)))
  caps.dispose()
  assert.match(reason, /output/)
  assert.equal(signal, 'SIGKILL')
})
test('justified skips pass and gate output is bounded without losing exit status', async () => {
  const f = fixture()
  try {
    f.write('example.test.ts', "it.only('works', () => { expect(true).toBe(true) })\n")
    f.commit()
    f.pr({ body: 'test-change: isolate a reproduced failure for review' })
    const r = await f.verify({ gate: `node -e 'process.stdout.write("a".repeat(40000)); process.exitCode = 9'` })
    assert.ok(r.checks.find(c => c.name === 'test skip')?.ok)
    assert.equal(r.gate?.exit, 9)
    assert.equal(r.gate?.tail.length, 16384)
    assert.equal(r.verified, false)
  } finally { f.cleanup() }
})
