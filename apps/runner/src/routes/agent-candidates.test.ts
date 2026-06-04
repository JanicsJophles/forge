import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import express, { type Express } from 'express'
import request from 'supertest'

// The db module opens SQLite at DATA_DIR on import — point it at a throwaway
// temp dir and satisfy config's ALLOWED_REPO_PATHS guard BEFORE importing.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cand-test-'))
process.env.DATA_DIR = TMP
process.env.ALLOWED_REPO_PATHS = TMP
process.env.CAPTURE_ENABLED = 'false'

let app: Express

beforeAll(async () => {
  const { agentStateRouter } = await import('./agent-state.js')
  app = express()
  app.use(express.json())
  app.use(agentStateRouter)
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

const VALID_CANDIDATE = {
  source: 'testing-loop',
  originAgentId: 'forge-task-xyz',
  originRepo: '/srv/repos/rackmind-macos',
  symptom: 'unzip rejects a macOS-produced tar.gz on Linux',
  cause: 'bsdtar writes ._ AppleDouble metadata that breaks the Java zip reader',
  diagnosticSteps: ['observed End-of-central-directory error', 'inspected archive for ._ files'],
  fix: 'recreate the archive with AppleDouble suppressed',
  verifiedCommand: 'COPYFILE_DISABLE=1 tar --no-xattrs -czf bundle.tar.gz ./dist',
  deadEnds: [{ tried: 'tar -czf bundle.tar.gz ./dist', whyFailed: 'kept the ._ files' }],
  reproduction: { host: 'LXC 207', steps: ['tar', 'unzip'], reproducedOnRealInfra: true },
  severity: 'high',
  rawEvidence: '... log excerpt ...',
}

describe('POST /agent-candidates', () => {
  it('creates a candidate and fills server-side fields', async () => {
    const res = await request(app).post('/agent-candidates').send(VALID_CANDIDATE)
    expect(res.status).toBe(201)
    expect(res.body.candidateId).toMatch(/[0-9a-f-]{36}/)
    expect(res.body.status).toBe('new')
    expect(res.body.source).toBe('testing-loop')
    expect(res.body.verifiedCommand).toBe(VALID_CANDIDATE.verifiedCommand)
    expect(res.body.deadEnds).toHaveLength(1)
    expect(res.body.capturedAt).toBeTruthy()
    expect(res.body.reproduction.reproducedOnRealInfra).toBe(true)
  })

  it('rejects a candidate missing required fields', async () => {
    const res = await request(app).post('/agent-candidates').send({ source: 'testing-loop' })
    expect(res.status).toBe(400)
  })

  it('rejects an invalid source', async () => {
    const res = await request(app)
      .post('/agent-candidates')
      .send({ ...VALID_CANDIDATE, source: 'made-up' })
    expect(res.status).toBe(400)
  })
})

describe('GET /agent-candidates', () => {
  it('lists pending (status=new) candidates by default', async () => {
    await request(app).post('/agent-candidates').send(VALID_CANDIDATE)
    const res = await request(app).get('/agent-candidates')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThanOrEqual(1)
    expect(res.body.every((c: { status: string }) => c.status === 'new')).toBe(true)
    expect(res.body[0].source).toBe('testing-loop')
  })

  it('filters by source', async () => {
    const res = await request(app).get('/agent-candidates?source=web-harvest')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(0)
  })
})

describe('GET /agent-candidates/:id', () => {
  it('fetches a single candidate and 404s on unknown id', async () => {
    const created = await request(app).post('/agent-candidates').send(VALID_CANDIDATE)
    const id = created.body.candidateId
    const ok = await request(app).get(`/agent-candidates/${id}`)
    expect(ok.status).toBe(200)
    expect(ok.body.candidateId).toBe(id)

    const missing = await request(app).get('/agent-candidates/does-not-exist')
    expect(missing.status).toBe(404)
  })
})
