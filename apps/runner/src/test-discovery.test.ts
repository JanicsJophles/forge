import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-discovery-'))
  try {
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'src', 'routes', 'nested'), { recursive: true })
    copyFileSync('scripts/run-tests.mjs', join(root, 'scripts/run-tests.mjs'))
    // Resolve the workspace's loader without installing dependencies in the fixture.
    symlinkSync(resolve('../../node_modules'), join(root, 'node_modules'), 'dir')
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function execute(root: string) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [join(root, 'scripts/run-tests.mjs')], {
    cwd: tmpdir(), env, encoding: 'utf8', timeout: 30_000,
  })
}

test('test gate discovers root and deeply nested tests and preserves failures', () => fixture(root => {
  for (const path of ['root.test.ts', 'routes/nested/deep.test.ts']) {
    writeFileSync(join(root, 'src', path), `import { test } from 'node:test'; test('${path}', () => {})`)
  }
  let result = execute(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /root\.test\.ts/)
  assert.match(result.stdout, /deep\.test\.ts/)
  writeFileSync(join(root, 'src', 'routes', 'nested', 'fail.test.ts'),
    `import { test } from 'node:test'; test('deliberate failure', () => { throw new Error('fixture failure') })`)
  result = execute(root)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /fixture failure/)
}))

test('test gate fails clearly when no tests exist', () => fixture(root => {
  const result = execute(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /No \.test\.ts files discovered under src/)
}))
