import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerCommand, readOnlyEnv } from './provider.js'

test('claude writable mode keeps the permission bypass', () => {
  const { command, args } = providerCommand('claude', false)
  assert.equal(command, 'claude')
  assert.deepEqual(args, ['--dangerously-skip-permissions', '-p'])
})

test('claude read-only pins the isolating settings/tools flags', () => {
  const { command, args } = providerCommand('claude', true)
  assert.equal(command, 'claude')
  // No permission bypass remains.
  assert.ok(!args.includes('--dangerously-skip-permissions'))
  // Ignore all settings sources so a repo .claude/settings.json cannot re-enable tools.
  const ss = args.indexOf('--setting-sources')
  assert.ok(ss >= 0)
  assert.equal(args[ss + 1], '')
  // Only --mcp-config servers (none) are honored; repo .mcp.json is ignored.
  assert.ok(args.includes('--strict-mcp-config'))
  // Plan mode + explicit tool fencing.
  const pm = args.indexOf('--permission-mode')
  assert.equal(args[pm + 1], 'plan')
  const allowed = args[args.indexOf('--allowedTools') + 1]
  for (const tool of ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git status:*)']) {
    assert.ok(allowed.includes(tool), `allowedTools should include ${tool}`)
  }
  const disallowed = args[args.indexOf('--disallowedTools') + 1]
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    assert.ok(disallowed.includes(tool), `disallowedTools should include ${tool}`)
  }
  assert.equal(args[args.length - 1], '-p')
})

test('claude defaults to writable mode when readOnly is omitted', () => {
  assert.deepEqual(providerCommand('claude').args, ['--dangerously-skip-permissions', '-p'])
})

test('codex command is identical in both modes (read-only is enforced out-of-band)', () => {
  const writable = providerCommand('codex', false)
  const readonly = providerCommand('codex', true)
  assert.deepEqual(writable, { command: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'] })
  assert.deepEqual(readonly, writable)
})

test('unsupported provider throws', () => {
  // @ts-expect-error exercising the runtime guard with an invalid provider
  assert.throws(() => providerCommand('gpt'), /Unsupported agent provider/)
})

test('readOnlyEnv is an explicit allowlist that strips inherited tokens', () => {
  const saved = { ...process.env }
  try {
    process.env.GH_TOKEN = 'ghp_secret'
    process.env.GITHUB_TOKEN = 'gh_secret'
    process.env.ANTHROPIC_API_KEY = 'sk-secret'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-secret'
    process.env.OPENAI_API_KEY = 'oai-secret'
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret'
    process.env.LANG = 'en_US.UTF-8'

    const env = readOnlyEnv('/home/forge-ro', 'forge-ro', 'claude')

    assert.equal(env.HOME, '/home/forge-ro')
    assert.equal(env.USER, 'forge-ro')
    assert.equal(env.LOGNAME, 'forge-ro')
    assert.ok(env.PATH, 'PATH is passed through')
    assert.equal(env.LANG, 'en_US.UTF-8')
    // None of the inherited secrets leak through.
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY']) {
      assert.equal(env[k], undefined, `${k} must not leak into the read-only env`)
    }
    // The allowlist does not include arbitrary extra keys.
    const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'])
    for (const key of Object.keys(env)) {
      assert.ok(allowed.has(key), `unexpected key leaked into read-only env: ${key}`)
    }
  } finally {
    process.env = saved
  }
})

test('readOnlyEnv passes the provider auth-dir override only for the matching provider', () => {
  const claude = readOnlyEnv('/home/ro', 'ro', 'claude', { claudeConfigDir: '/etc/forge-ro/claude', codexHome: '/etc/forge-ro/codex' })
  assert.equal(claude.CLAUDE_CONFIG_DIR, '/etc/forge-ro/claude')
  assert.equal(claude.CODEX_HOME, undefined)

  const codex = readOnlyEnv('/home/ro', 'ro', 'codex', { claudeConfigDir: '/etc/forge-ro/claude', codexHome: '/etc/forge-ro/codex' })
  assert.equal(codex.CODEX_HOME, '/etc/forge-ro/codex')
  assert.equal(codex.CLAUDE_CONFIG_DIR, undefined)
})
