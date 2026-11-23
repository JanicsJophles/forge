import { spawn, type ChildProcess } from 'node:child_process'
import type { TaskCgroup } from './cgroup.js'

// Static trusted launcher code. It runs with a minimal environment and cannot access
// the target description until the parent has successfully attached it to a cgroup.
const LAUNCHER = `
const { spawn } = require('node:child_process');
const timer = setTimeout(() => process.exit(125), 10000);
process.once('disconnect', () => process.exit(125));
process.once('message', m => {
  clearTimeout(timer);
  if (!m || typeof m.exe !== 'string' || !Array.isArray(m.args) ||
      !m.args.every(x => typeof x === 'string') || typeof m.cwd !== 'string' ||
      !m.env || typeof m.env !== 'object' || Array.isArray(m.env) ||
      !Object.entries(m.env).every(([k,v]) => typeof k === 'string' && typeof v === 'string')) process.exit(125);
  let child;
  try { child = spawn(m.exe, m.args, { cwd: m.cwd, env: m.env, stdio: 'inherit' }); }
  catch (e) { console.error(e.message); process.exit(125); }
  child.on('error', e => { console.error(e.message); process.exit(125); });
  child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 125); });
});
`

export function spawnContained(
  cgroup: TaskCgroup,
  exe: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; uid?: number; gid?: number },
): ChildProcess {
  if (!exe || !options.cwd || args.some(a => typeof a !== 'string')) throw new Error('invalid contained launch')
  const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const child = spawn(process.execPath, ['-e', LAUNCHER], {
    cwd: '/', env: { PATH: '/usr/bin:/bin' }, uid: options.uid, gid: options.gid,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  try {
    if (!child.pid) throw new Error('contained launcher failed to start')
    cgroup.addPid(child.pid)
    child.send({ exe, args, cwd: options.cwd, env }, error => {
      if (error) { cgroup.killAll(); child.kill('SIGKILL') }
    })
  } catch (error) {
    child.kill('SIGKILL')
    cgroup.killAll()
    // A failed spawn can emit an asynchronous error even after this function throws.
    child.on('error', () => {})
    throw error
  }
  return child
}
