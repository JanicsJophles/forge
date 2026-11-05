import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

async function collect(directory) {
  const files = await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collect(path)
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  }))
  return files.flat()
}

try {
  const files = (await collect(join(root, 'src'))).sort()
  if (files.length === 0) throw new Error('No .test.ts files discovered under src')

  const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
    cwd: root,
    stdio: 'inherit',
  })
  const forward = signal => child.kill(signal)
  const onInterrupt = () => forward('SIGINT')
  const onTerminate = () => forward('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  child.on('error', error => {
    console.error(`Unable to start tests: ${error.message}`)
    process.exitCode = 1
  })
  child.on('close', (code, signal) => {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
} catch (error) {
  console.error(`Test discovery failed: ${error.message}`)
  process.exitCode = 1
}
