import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { test } from 'node:test'

const names = ['PORT', 'MAX_CONCURRENT_TASKS', 'MIN_FREE_DISK_MB'] as const
const defaults = [5000, 2, 2048]

function loadConfig(value?: string, setting?: typeof names[number]) {
  // Point at a directory that exists so the allowlist existence check stays
  // silent; this suite exercises numeric env parsing, not the allowlist.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/dev/null', ALLOWED_REPO_PATHS: os.tmpdir() }
  for (const name of names) {
    delete env[name]
    if (value !== undefined && (setting === undefined || setting === name)) env[name] = value
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

// 60 stays within every cap (PORT 65535, MAX_CONCURRENT_TASKS 64, MIN_FREE_DISK_MB huge).
test('positive integer settings are preserved without warnings', () => {
  assert.deepEqual(loadConfig('60'), { values: [60, 60, 60], warnings: '' })
})

for (const value of ['abc', '', '0', '-1', '+1', 'Infinity', '2workers', '1e3', '1.5', '1.0',
  ' 2', '2 ', '2\n', '\t2', '0x10', '１２', '9007199254740992', '9007199254740993', '9'.repeat(400)]) {
  test(`invalid numeric settings fall back and name each variable (${value.slice(0, 16)})`, () => {
    const { values, warnings } = loadConfig(value)
    assert.deepEqual(values, defaults)
    assert.equal(warnings, names.map((name, i) =>
      `[config] Invalid ${name}; using default ${defaults[i]}.\n`).join(''))
    for (const parsed of values) assert.ok(Number.isInteger(parsed) && parsed > 0)
  })
}

// Lexical policy: ASCII decimal digits only; leading zeros are allowed.
// Signs, whitespace, exponent notation and even integral fractions are rejected.
test('leading zeros preserve the decimal value without warnings', () => {
  assert.deepEqual(loadConfig('000060'), { values: [60, 60, 60], warnings: '' })
})

for (const [index, maximum] of [65535, 64,
  Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024))].entries()) {
  const name = names[index]
  for (const value of [1, maximum]) {
    test(`${name} preserves inclusive boundary ${value}`, () => {
      const expected = [...defaults]
      expected[index] = value
      assert.deepEqual(loadConfig(String(value), name), { values: expected, warnings: '' })
      if (name === 'MIN_FREE_DISK_MB') assert.ok(Number.isSafeInteger(value * 1024 * 1024))
    })
  }
  test(`${name} rejects the first integer above its maximum`, () => {
    assert.deepEqual(loadConfig(String(maximum + 1), name), {
      values: defaults,
      warnings: `[config] Invalid ${name}; using default ${defaults[index]}.\n`,
    })
  })
}
