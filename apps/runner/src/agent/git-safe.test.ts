import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { filterNeutralizationFlags } from './git-safe.js'

test('filter enumeration rejects malformed repository configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-filter-test-'))
  try {
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, '.git', 'objects'))
    mkdirSync(join(dir, '.git', 'refs'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(dir, '.git', 'config'), '[broken\n')
    assert.throws(() => filterNeutralizationFlags(dir), /cannot enumerate git filters/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
