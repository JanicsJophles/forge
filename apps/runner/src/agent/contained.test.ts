import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { spawnContained } from './contained.js'
import { createTaskCgroup, type TaskCgroup } from './cgroup.js'

const fake = (addPid: (pid: number) => void): TaskCgroup => ({ dir: '', addPid, killAll() { return true }, remove() {} })

test('attachment failure never starts the target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-barrier-'))
  const marker = join(dir, 'marker')
  try {
    assert.throws(() => spawnContained(fake(() => { throw new Error('attachment denied') }), process.execPath,
      ['-e', 'require("fs").writeFileSync(process.argv[1], "started")', marker], { cwd: dir, env: {} }), /attachment denied/)
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(existsSync(marker), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('launcher starts target only after attachment', async () => {
  let attached = false
  const child = spawnContained(fake(() => { attached = true }), process.execPath, ['-e', 'process.stdout.write("started")'], { cwd: '/', env: {} })
  assert.equal(attached, true)
  let output = ''
  child.stdout!.on('data', chunk => { output += chunk })
  const [code] = await once(child, 'close')
  assert.equal(code, 0)
  assert.equal(output, 'started')
})

test('cgroup kills a setsid descendant holding stdout', { skip: process.env.FORGE_TEST_CGROUP !== '1' }, async () => {
  const group = createTaskCgroup(`test-${process.pid}`)
  assert.ok(group, 'requires a writable delegated cgroup v2 with cgroup.kill')
  try {
    const child = spawnContained(group, process.execPath, ['-e', `
      const {spawn} = require('child_process');
      const p = spawn('/usr/bin/setsid', [process.execPath, '-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'});
      p.on('spawn', () => { console.log(p.pid); setTimeout(()=>process.exit(0), 100); });
    `], { cwd: '/', env: {} })
    let output = ''
    child.stdout!.on('data', chunk => { output += chunk })
    await once(child, 'exit')
    const pid = Number(output.trim())
    assert.ok(pid > 0)
    group.killAll()
    await Promise.race([once(child, 'close'), new Promise((_, reject) => setTimeout(() => reject(new Error('stdout remained open')), 3000))])
    // A killed orphan may briefly remain a zombie until its reaper collects it.
    const { readFileSync } = await import('node:fs')
    try { assert.equal(readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2], 'Z') } catch (e: any) { if (e.code !== 'ENOENT') throw e }
  } finally { group.killAll(); group.remove() }
})

test('cancelling the blocked launcher prevents the target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cancel-'))
  const marker = join(dir, 'marker')
  try {
    const child = spawnContained(fake(pid => { process.kill(pid, 'SIGKILL') }), process.execPath,
      ['-e', 'require("fs").writeFileSync(process.argv[1], "started")', marker], { cwd: dir, env: {} })
    child.on('error', () => {})
    await once(child, 'close')
    assert.equal(existsSync(marker), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('a teardown permission failure disables further read-only launches', {
  skip: process.getuid?.() !== 0 || process.env.FORGE_TEST_CGROUP !== '1',
}, () => {
  const moduleUrl = new URL('./cgroup.ts', import.meta.url).href
  const script = `
    const { createTaskCgroup, containmentAvailable } = await import(${JSON.stringify(moduleUrl)});
    const group = createTaskCgroup('failure-' + process.pid);
    if (!group) throw new Error('requires delegated cgroup');
    process.setgroups([]); process.setgid(65534); process.setuid(65534);
    console.log(JSON.stringify({ dir: group.dir, killed: group.killAll(), failure: group.failure, available: containmentAvailable() }));
  `
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8', env: { PATH: '/usr/local/bin:/usr/bin:/bin', READONLY_CGROUP_PARENT: process.env.READONLY_CGROUP_PARENT },
  })
  const result = JSON.parse(output)
  try {
    assert.equal(result.killed, false)
    assert.match(result.failure, /teardown failed/)
    assert.equal(result.available, false)
  } finally { rmdirSync(result.dir) }
})
