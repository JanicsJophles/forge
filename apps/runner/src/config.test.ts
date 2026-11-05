import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const names = ['PORT', 'MAX_CONCURRENT_TASKS', 'MIN_FREE_DISK_MB'] as const
const defaults = [5000, 2, 2048]

function loadConfig(value?: string) {
  const env = { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', ALLOWED_REPO_PATHS: '/tmp/repos' }
  for (const name of names) {
    delete env[name]
    if (value !== undefined) env[name] = value
  }
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    `const { config } = await import(${JSON.stringify(new URL('./config.ts', import.meta.url).href)});
     console.log(JSON.stringify([config.port, config.maxConcurrentTasks, config.minFreeDiskMb]));`,
  ], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return { values: JSON.parse(result.stdout.trim()), warnings: result.stderr }
}

test('unset numeric settings use defaults without warnings', () => {
  assert.deepEqual(loadConfig(), { values: defaults, warnings: '' })
})

test('positive integer settings are preserved without warnings', () => {
  assert.deepEqual(loadConfig('123'), { values: [123, 123, 123], warnings: '' })
})

for (const value of ['abc', '', '0', '-1', 'Infinity', '9'.repeat(400)]) {
  test(`invalid numeric settings fall back and name each variable (${value.slice(0, 16)})`, () => {
    const { values, warnings } = loadConfig(value)
    assert.deepEqual(values, defaults)
    for (const name of names) assert.ok(warnings.includes(`Invalid ${name};`))
    for (const parsed of values) assert.ok(Number.isInteger(parsed) && parsed > 0)
  })
}
