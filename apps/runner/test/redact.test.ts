import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, redactUnbounded } from '../src/agent/redact.js'

const SECRET = 'Zq9vX2kLm8Np4Rt6Yw1A'

test('credential shapes are masked', () => {
  const cases = [
    `git clone https://x-access-token:${SECRET}@github.com/o/r.git`,
    `git push https://${SECRET}@github.com/o/r.git`,
    `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com`,
    `curl -H 'authorization: token ${SECRET}'`,
    `curl --header "Authorization:${SECRET}"`,
    `wget --header="Bearer ${SECRET}"`,
    `PGPASSWORD=${SECRET} psql -h db`,
    `export GITHUB_TOKEN="${SECRET}"`,
    `OPENAI_API_KEY='${SECRET}' node x.js`,
    `CLIENT_SECRET=${SECRET}`,
    `GH_PAT=${SECRET} gh pr list`,
    `aws --profile x AWS_SECRET_ACCESS_KEY=${SECRET}`,
    `{"password": "${SECRET}"}`,
    `{'api_key': '${SECRET}'}`,
    `--password=${SECRET}`,
    `mysql --password ${SECRET} db`,
    `gh auth login --with-token --token ${SECRET}`,
    `tool --api-key "${SECRET}"`,
    `curl -u admin:${SECRET} https://h`,
    `curl --user 'admin:${SECRET}' https://h`,
    `curl -H "X-Api-Key: ${SECRET}"`,
    `curl -H 'X-Internal-Key:${SECRET}'`,
    `curl -H "X-Auth-Token: ${SECRET}"`,
    `curl -H "Cookie: session=${SECRET}"`,
    `the api key is 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a`,
    `secret: QWxhZGRpbjpvcGVuIHNlc2FtZQ==QWxhZGRpbjpvcGVuIHNlc2FtZQ==`,
  ]
  for (const c of cases) assert.ok(!redact(c).includes(SECRET), `${c} -> ${redact(c)}`)
})

test('well-known token formats are masked anywhere', () => {
  const tokens = [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'sk-proj-abcdefghijklmnop',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'gho_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0abcdefghijklmnopqrstuv',
    'xoxb-1234567890-abcdefghij',
    'xoxp-1234567890-abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ]
  for (const t of tokens) assert.ok(!redact(`value ${t} here`).includes(t), t)
})

test('ordinary text is left alone', () => {
  for (const plain of ['npm run build && npm test', 'git push -u origin HEAD', 'git commit --author "A <a@b.c>"',
    'GIT_AUTHOR_NAME=bot git commit', 'curl -H "X-Request-Id: 1234" https://h', 'sha 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a', 'PATH=/usr/bin:/bin make',
    'NODE_ENV=production node dist/index.js', 'read the token handling in auth.ts', 'git@github.com:o/r.git',
    'https://github.com/o/r/pull/12']) {
    assert.equal(redact(plain), plain)
  }
})

test('the result is cut after redaction, and a secret straddling the cut is never partly shown', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  for (let cut = 1; cut < 140; cut += 7) {
    const text = 'x'.repeat(cut) + ' ' + jwt + ' tail ' + 'y'.repeat(2000)
    const out = redact(text, cut + 40)
    assert.ok(out.length <= cut + 40)
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9.eyJ'), out)
    assert.ok(!out.includes('dozjgNry'), out)
  }
  const long = `TOKEN=${'s'.repeat(5000)}`
  assert.ok(!redact(long, 100).includes('sss'))
  assert.equal(redact('short', 100), 'short')
})

// Inputs built to make a backtracking pattern quadratic, one or more per rule.
const ADVERSARIAL: Record<string, string> = {
  nameValue: 'a-'.repeat(1 << 20),
  nameValueSpaced: ' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.repeat(1 << 15),
  openQuote: 'TOKEN="'.repeat(300000),
  flags: ' --password'.repeat(190000),
  url: 'a://'.repeat(1 << 19),
  urlUserinfo: '://' + 'a'.repeat(1 << 21),
  authorization: 'authorization: '.repeat(140000),
  header: ' x-api-key'.repeat(210000),
  headerColons: ' x-a:'.repeat(420000),
  bearer: 'bearer '.repeat(300000),
  jsonKey: '"a'.repeat(1 << 20),
  jsonKeyTokens: '"token_token_token'.repeat(116000),
  jsonQuotes: '"a"'.repeat(700000),
  bareAfterWord: 'key: '.repeat(420000),
  jwt: 'eyJ'.repeat(700000),
  jwtDots: 'eyJaaaaa.'.repeat(233000),
  known: 'sk-'.repeat(700000),
  ghp: 'ghp_'.repeat(520000),
  akia: 'AKIA'.repeat(520000),
  newlines: '\n'.repeat(1 << 21),
  quoteRun: '"' + 'a'.repeat(1 << 21),
  quoteTokenRun: '"' + 'token'.repeat(420000),
  plainAssignments: ' a=b'.repeat(1 << 19),
  secretAssignments: ' TOKEN=b'.repeat(1 << 18),
  spaces: ' '.repeat(1 << 21),
}

// Best of three, so a GC pause or a busy CPU (test files run in parallel) is not mistaken for a slow pattern.
function fastest(fn: () => unknown): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    fn()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

test('every rule stays linear, and redact() bounds its work on any input', () => {
  redact('warm up TOKEN=x https://a:b@c')
  for (const [name, input] of Object.entries(ADVERSARIAL)) {
    assert.ok(input.length >= 1_900_000, `${name} is ${input.length}`)
    // The rules themselves: a quadratic pattern takes hundreds of ms on 64 KB; linear ones take a few ms.
    const slice = input.slice(0, 64 * 1024)
    let ms = fastest(() => redactUnbounded(slice))
    assert.ok(ms < 50, `${name} (64 KB, rules only): ${ms.toFixed(1)} ms`)
    // What callers use, on the full 2 MB.
    ms = fastest(() => redact(input))
    assert.ok(ms < 50, `${name} (2 MB): ${ms.toFixed(1)} ms`)
    assert.ok(redact(input).length <= 64 * 1024)
  }
})
