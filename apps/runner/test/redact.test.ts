import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact } from '../src/agent/redact.js'

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
  for (const plain of ['npm run build && npm test', 'git push -u origin HEAD', 'PATH=/usr/bin:/bin make',
    'NODE_ENV=production node dist/index.js', 'read the token handling in auth.ts', 'git@github.com:o/r.git',
    'https://github.com/o/r/pull/12']) {
    assert.equal(redact(plain), plain)
  }
})
