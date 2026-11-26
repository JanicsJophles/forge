import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'

// Spawn -> watchdog -> settled status, through the real runTask with a fake `claude` that speaks stream-json.
// The agent must run as a non-root account, so this is skipped when the suite runs as root.
const asRoot = userInfo().uid === 0

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const say = event => process.stdout.write(JSON.stringify(event) + '\\n')
say({ type: 'system', subtype: 'init', model: 'fake-model' })
if (process.env.FAKE_MODE === 'stall') {
  // A Bash tool call: a poll loop in its own process group whose condition never comes true. Then silence.
  const loop = spawn('bash', ['-c', 'until false; do sleep 0.2; done'], { detached: true, stdio: 'ignore' })
  fs.writeFileSync(process.env.FAKE_PID_FILE, String(loop.pid))
  setInterval(() => {}, 1000)
} else {
  // A legitimate long build: quiet gaps shorter than the stall limit, total run far longer than it.
  let n = 0
  const timer = setInterval(() => {
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'build step ' + ++n }] } })
    if (n === 12) {
      clearInterval(timer)
      say({ type: 'result', subtype: 'success', result: 'built', num_turns: 1, duration_ms: 3000 })
      process.exit(0)
    }
  }, 250)
}
`

let mod: {
  runTask: typeof import('../src/agent/runner.js').runTask
  insertTask: typeof import('../src/db/queries.js').insertTask
  getTask: typeof import('../src/db/queries.js').getTask
}
let repo: string
let dir: string

before(async () => {
  if (asRoot) return
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'forge-runner-watchdog-')))
  repo = path.join(dir, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', '-q', repo])
  const fake = path.join(dir, 'fake-claude')
  await writeFile(fake, FAKE_CLAUDE)
  await chmod(fake, 0o755)
  Object.assign(process.env, {
    DATA_DIR: path.join(dir, 'data'),
    ALLOWED_REPO_PATHS: dir,
    CLAUDE_RUN_USER: userInfo().username,
    FORGE_CLAUDE_COMMAND: fake,
    FORGE_KILL_GRACE_MS: '1000',
    AUTO_COMMIT: 'false',
  })
  const runner = await import('../src/agent/runner.js')
  const queries = await import('../src/db/queries.js')
  mod = { runTask: runner.runTask, insertTask: queries.insertTask, getTask: queries.getTask }
})

async function run(id: string, overrides: { stallMinutes?: number; exitGraceMinutes?: number }) {
  const task = {
    id, provider: 'claude' as const, autoCommit: false, repo, branch: 'main', prompt: 'test',
    status: 'queued' as const, log: '', createdAt: new Date().toISOString(), ...overrides,
  }
  mod.insertTask(task)
  const emitter = new EventEmitter()
  const done = new Promise(resolve => emitter.once('done', resolve))
  await mod.runTask(task, emitter)
  await done
  return mod.getTask(id) as { status: string; errorMessage?: string; error_message?: string; log: string }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test('a silent agent is killed by the watchdog, with its detached poll loop, and the task fails', { skip: asRoot }, async () => {
  const pidFile = path.join(dir, 'loop.pid')
  process.env.FAKE_MODE = 'stall'
  process.env.FAKE_PID_FILE = pidFile
  const started = Date.now()
  const task = await run('stall-1', { stallMinutes: 0.02, exitGraceMinutes: 0 }) // 1.2 s
  const loopPid = Number((await readFile(pidFile, 'utf8')).trim())
  assert.equal(task.status, 'failed')
  assert.match(String(task.errorMessage ?? task.error_message), /^watchdog: no agent output for/)
  assert.match(task.log, /\[forge\] watchdog: no agent output/)
  assert.ok(Date.now() - started < 15_000)
  assert.equal(alive(loopPid), false, 'the poll loop in its own process group was killed too')
})

test('a long build that keeps printing is never killed and completes', { skip: asRoot }, async () => {
  process.env.FAKE_MODE = 'busy'
  // Stall limit 0.6 s; the build runs ~3 s with output every 0.25 s.
  const task = await run('busy-1', { stallMinutes: 0.01, exitGraceMinutes: 0.01 })
  assert.equal(task.status, "completed", task.log)
  assert.doesNotMatch(task.log, /\[forge\] watchdog/)
  assert.match(task.log, /\[claude\] finished: success/)
})
