import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root: string

before(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-procgroup-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise(r => setTimeout(r, 25))
  }
}

// This proves the exact kernel contract killTask() relies on: a read-only agent is
// spawned with { detached: true } so it leads its own process group, and cancel/close
// sends SIGTERM to the WHOLE group via process.kill(-pid). A naive proc.kill() would
// only hit the leader and leave backgrounded children (setsid/nohup/&) running.
test('a detached leader killed by negative pid takes its grandchild down with it', async () => {
  const gpidFile = join(root, 'grandchild.pid')

  // Leader (own group) backgrounds a long-lived grandchild and records its pid,
  // then waits — so the grandchild only dies if the GROUP is signalled.
  const leader = spawn(
    'sh',
    ['-c', `sleep 300 & echo $! > "${gpidFile}"; wait`],
    { detached: true, stdio: 'ignore' }
  )
  assert.equal(typeof leader.pid, 'number')

  await waitFor(() => existsSync(gpidFile) && readFileSync(gpidFile, 'utf8').trim() !== '')
  const grandchildPid = Number(readFileSync(gpidFile, 'utf8').trim())
  assert.ok(grandchildPid > 0)
  await waitFor(() => alive(grandchildPid))

  // The mechanism under test: signal the entire group with a negative pid.
  process.kill(-(leader.pid as number), 'SIGTERM')

  await waitFor(() => !alive(grandchildPid))
  assert.equal(alive(grandchildPid), false, 'grandchild must die with the group, not outlive the leader')
})
