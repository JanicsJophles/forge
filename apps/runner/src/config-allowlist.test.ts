import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('repository allowlists compare real paths and fail closed', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'forge-allowlist-'))
  try {
    const allowed = path.join(temporary, 'repos')
    const nested = path.join(allowed, 'team', 'repo')
    const outside = path.join(temporary, 'outside')
    const sibling = path.join(temporary, 'repos-evil')
    const alias = path.join(temporary, 'alias')
    const missing = path.join(temporary, 'missing')
    mkdirSync(nested, { recursive: true })
    mkdirSync(outside)
    mkdirSync(sibling)
    symlinkSync(outside, path.join(allowed, 'escape'))
    symlinkSync(allowed, alias)
    symlinkSync(missing, path.join(allowed, 'dangling'))
    symlinkSync('loop', path.join(allowed, 'loop'))

    const cases: Array<[string, string, boolean]> = [
      [allowed, nested, true],
      [allowed, allowed, true],
      [allowed, path.join(allowed, 'escape'), false],
      [allowed, sibling, false],
      [allowed, path.join(allowed, '..', 'outside'), false],
      [alias, nested, true],
      [alias, path.join(alias, 'team', 'repo'), true],
      [alias, alias, true],
      [allowed, missing, false],
      [allowed, path.join(allowed, 'dangling'), false],
      [allowed, path.join(allowed, 'loop'), false],
      [missing, nested, false],
      [path.join(allowed, 'loop'), nested, false],
      [path.parse(temporary).root, nested, true],
      [path.parse(temporary).root, path.parse(temporary).root, true],
      [allowed, '', false],
    ]
    // Import config only in a child with dotenv disabled; no DB or real .env.
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `const { config, isRepoAllowed } = await import(${JSON.stringify(new URL('./config.ts', import.meta.url).href)});
       const cases = JSON.parse(process.env.FORGE_ALLOWLIST_CASES);
       console.log(JSON.stringify(cases.map(([root, candidate]) => {
         config.allowedRepoPaths = [root];
         return isRepoAllowed(candidate);
       })));`,
    ], {
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: '/dev/null',
        ALLOWED_REPO_PATHS: allowed,
        FORGE_ALLOWLIST_CASES: JSON.stringify(cases),
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const actual = JSON.parse(result.stdout.trim())
    cases.forEach(([root, candidate, expected], index) => {
      assert.equal(actual[index], expected, `${candidate} within ${root}`)
    })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
