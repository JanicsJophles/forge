import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Load config.ts in a child with dotenv disabled and capture its stderr. The
// warning is emitted once at module load per bad ALLOWED_REPO_PATHS entry.
function loadWarnings(allowedRepoPaths: string): string {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('./config.ts', import.meta.url).href)});`,
  ], {
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: '/dev/null',
      ALLOWED_REPO_PATHS: allowedRepoPaths,
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stderr
}

test('existing directories in the allowlist produce no warning', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'forge-repo-warn-'))
  try {
    assert.equal(loadWarnings(dir), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing allowlist entry is named in a distinct warning', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'forge-repo-warn-'))
  const missing = path.join(dir, 'nope')
  try {
    const stderr = loadWarnings(missing)
    assert.ok(
      stderr.includes(`[config] ALLOWED_REPO_PATHS entry does not exist or is not a directory: ${missing}`),
      stderr,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file (not a directory) entry is warned about', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'forge-repo-warn-'))
  const file = path.join(dir, 'repo.txt')
  writeFileSync(file, 'not a directory')
  try {
    const stderr = loadWarnings(file)
    assert.ok(
      stderr.includes(`[config] ALLOWED_REPO_PATHS entry does not exist or is not a directory: ${file}`),
      stderr,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('each bad entry gets its own warning line; valid entries stay silent', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'forge-repo-warn-'))
  const missingA = path.join(dir, 'a')
  const missingB = path.join(dir, 'b')
  try {
    const stderr = loadWarnings(`${dir},${missingA},${missingB}`)
    const lines = stderr.split('\n').filter(line => line.includes('does not exist or is not a directory'))
    assert.equal(lines.length, 2, stderr)
    assert.ok(stderr.includes(missingA), stderr)
    assert.ok(stderr.includes(missingB), stderr)
    assert.ok(!stderr.includes(`directory: ${dir}\n`), stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
