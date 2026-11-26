import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { killTree, listProcesses, processTree, pidsWithCwdIn } from '../src/agent/proctree.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

async function waitForFile(file: string, ms = 5000): Promise<string> {
  const end = Date.now() + ms
  for (;;) {
    try {
      const text = (await readFile(file, 'utf8')).trim()
      if (text) return text
    } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`)
    await sleep(50)
  }
}

// Like Claude Code's Bash tool: the agent (a node process) starts a shell in a NEW process group (detached =
// setsid) and keeps running. Signalling only the agent's group would miss it.
async function agentWithDetachedShell(shell: string): Promise<{ agent: ReturnType<typeof spawn>; shellPid: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'forge-proctree-'))
  const pidFile = path.join(dir, 'pid')
  const script = `
    const { spawn } = require('node:child_process')
    const fs = require('node:fs')
    const child = spawn('bash', ['-c', ${JSON.stringify(shell)}], { detached: true, stdio: 'ignore' })
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
    setInterval(() => {}, 1000)
  `
  const agent = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
  const shellPid = Number(await waitForFile(pidFile))
  return { agent, shellPid }
}

test('the tree walk finds a descendant that leads its own process group', async () => {
  const { agent, shellPid } = await agentWithDetachedShell('until false; do sleep 0.2; done')
  try {
    const procs = listProcesses()
    const shell = procs.find(p => p.pid === shellPid)
    assert.ok(shell, 'shell is running')
    assert.equal(shell.pgid, shellPid, 'shell leads its own group')
    assert.notEqual(shell.pgid, procs.find(p => p.pid === agent.pid)?.pgid)
    assert.ok(processTree(agent.pid as number, procs).some(p => p.pid === shellPid))
  } finally {
    await killTree(agent.pid, 1000)
  }
})

test('killTree kills a polling loop in its own process group, and its sleep child', async () => {
  const { agent, shellPid } = await agentWithDetachedShell('until false; do sleep 0.2; done')
  const left = await killTree(agent.pid, 2000)
  assert.deepEqual(left, [])
  assert.equal(alive(agent.pid as number), false)
  assert.equal(alive(shellPid), false, 'the detached poll loop died with the agent')
})

test('killTree kills a self-matching `pgrep -f` loop that could never end on its own', async t => {
  // 7aa9a962 on 2026-11-25: `until ! pgrep -f atlas-check.sh` matches its own command line, so it loops forever.
  const marker = `forge-selfmatch-${process.pid}-${Date.now()}`
  const { agent, shellPid } = await agentWithDetachedShell(`until ! pgrep -f ${marker} >/dev/null; do sleep 0.2; done`)
  try {
    await sleep(1000)
    if (!alive(shellPid)) {
      // A sandbox that hides other processes from pgrep (macOS seatbelt) ends the loop at once.
      t.skip('pgrep cannot see processes in this environment')
      return
    }
    await killTree(agent.pid, 2000)
    assert.equal(alive(shellPid), false)
  } finally {
    await killTree(agent.pid, 500)
  }
})

test('killTree escalates to SIGKILL for a shell that ignores SIGTERM', async () => {
  const { agent, shellPid } = await agentWithDetachedShell("trap '' TERM; until false; do sleep 0.2; done")
  const left = await killTree(agent.pid, 500)
  assert.deepEqual(left, [])
  assert.equal(alive(shellPid), false)
})

test('pidsWithCwdIn finds processes working inside a directory (Linux /proc)', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'forge-cwd-'))
  const child = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' })
  try {
    await sleep(100)
    assert.ok(pidsWithCwdIn(dir).includes(child.pid as number))
    assert.equal(pidsWithCwdIn(path.join(dir, 'nope')).length, 0)
  } finally {
    child.kill('SIGKILL')
  }
})
