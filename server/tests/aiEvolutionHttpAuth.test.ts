import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

test('real evolution routes enforce sessions, CSRF, Origin and disabled-account revocation', {
  skip: process.env.EVOLUTION_ISOLATED_HTTP_TEST !== 'true',
}, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '43318')
  assert.equal(process.env.DB_DATABASE, 'evolution_isolated_test')
  assert.equal(process.env.DB_FREFIX, 'evo_test_')
  const { requireAuth } = await import('../src/middleware/requireAuth.js')
  const { aiEvolutionRouter } = await import('../src/routes/aiEvolution.js')
  const { pool } = await import('../src/db/client.js')
  const { createAuthSession } = await import('../src/services/authService.js')
  const { errorHandler } = await import('../src/middleware/errorHandler.js')
  const owner = randomUUID()
  for (const [file, table] of [['0000_mysql_baseline.sql', 'users'], ['0011_add_auth_sessions.sql', 'auth_sessions']]) {
    const sql = (await readFile(`server/drizzle/${file}`, 'utf8')).match(new RegExp('CREATE TABLE `sbl_' + table + '` \\([\\s\\S]*?\\n\\);'))?.[0]
    assert.ok(sql)
    await pool.query(sql.replaceAll('`sbl_', '`evo_test_').replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '))
  }
  await pool.query('INSERT INTO evo_test_users (id,email,name,role,password_hash) VALUES (?,?,?,?,?)', [owner, `${owner}@example.invalid`, 'HTTP fixture', '投资经理', 'not-a-login-password'])
  const session = await createAuthSession({ userId: owner })
  const originalEnabled = process.env.AI_EVOLUTION_ENABLED
  process.env.AI_EVOLUTION_ENABLED = 'true'
  const app = express()
  app.use(express.json())
  app.use('/api/ai/evolution', requireAuth, aiEvolutionRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai/evolution`
    const id = '00000000-0000-4000-8000-000000000001'
    for (const [method, suffix] of [
      ['GET', 'skill-packages'], ['POST', 'skill-versions'], ['GET', 'skill-trial'], ['POST', 'skill-trial'],
      ['POST', 'skill-trial-plan'], ['POST', 'skill-trial-approval'], ['POST', 'skill-trial-rollback'],
      ['POST', 'skill-promotion-plan'], ['POST', 'skill-promotion-approval'], ['POST', 'skill-promotion'],
      ['POST', 'reevaluation-plan'], ['POST', 'reevaluation'],
      ['GET', 'release-targets'], ['POST', 'release-approval'], ['GET', 'release'], ['POST', 'release'],
      ['GET', 'skill-comparison'], ['GET', 'artifacts/0'],
    ]) {
      const response = await fetch(`${base}/candidates/${id}/${suffix}`, { method,
        headers: { Origin: 'https://untrusted.example', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}) })
      assert.equal(response.status, 401, `${method} ${suffix}`)
      assert.equal((await response.json()).code, 'AUTH_REQUIRED')
    }
    const cookie = `cybernaut_session=${session.sessionToken}`
    for (const suffix of ['skill-versions', 'skill-trial', 'skill-trial-plan', 'skill-trial-approval', 'skill-trial-rollback',
      'skill-promotion-plan', 'skill-promotion-approval', 'skill-promotion', 'reevaluation-plan', 'reevaluation',
      'release-approval', 'release']) {
      const endpoint = `${base}/candidates/${id}/${suffix}`
      const headers = { Cookie: cookie, 'Content-Type': 'application/json' }
      const missing = await fetch(endpoint, { method: 'POST', headers, body: '{}' })
      assert.equal(missing.status, 403); assert.equal((await missing.json()).code, 'CSRF_INVALID')
      const foreign = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': session.csrfToken, Origin: 'https://untrusted.example' }, body: '{}' })
      assert.equal(foreign.status, 403); assert.equal((await foreign.json()).code, 'ORIGIN_FORBIDDEN')
      const permitted = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': session.csrfToken }, body: '{}' })
      assert.equal(permitted.status, 400, suffix)
      assert.equal((await permitted.json()).code, 'INVALID_ARGUMENT')
    }
    const absent = await fetch(`${base}/candidates/${id}/skill-trial`, { headers: { Cookie: cookie } })
    assert.equal(absent.status, 404)
    const [candidateRows] = await pool.query('SELECT id,run_id FROM evo_test_ai_evolution_candidates WHERE status IN (?,?) LIMIT 1', ['rolled_back', 'approved'])
    const foreignCandidate = (candidateRows as { id: string; run_id: string }[])[0]
    assert.ok(foreignCandidate, 'Run aiEvolutionSkillVersionMysql.test.ts first to prepare an isolated candidate fixture')
    for (const suffix of ['', '/skill-comparison', '/skill-packages', '/skill-trial', '/artifacts/0']) {
      const response = await fetch(`${base}/candidates/${foreignCandidate.id}${suffix}`, { headers: { Cookie: cookie } })
      assert.equal(response.status, 404, `foreign candidate ${suffix}`)
      const payload = await response.json()
      assert.equal(payload.code, 'EVOLUTION_NOT_FOUND')
      assert.equal(JSON.stringify(payload).includes(foreignCandidate.run_id), false)
    }
    for (const suffix of ['', '/events', '/skill-comparison']) {
      const response = await fetch(`${base}/runs/${foreignCandidate.run_id}${suffix}`, { headers: { Cookie: cookie } })
      assert.equal(response.status, 404, `foreign run ${suffix}`)
      assert.equal((await response.json()).code, 'EVOLUTION_NOT_FOUND')
    }
    await pool.query('UPDATE evo_test_users SET status=? WHERE id=?', ['禁用', owner])
    const disabled = await fetch(`${base}/candidates/${id}/skill-trial`, { headers: { Cookie: cookie } })
    assert.equal(disabled.status, 401); assert.equal((await disabled.json()).code, 'AUTH_DISABLED')
  } finally {
    if (originalEnabled === undefined) delete process.env.AI_EVOLUTION_ENABLED
    else process.env.AI_EVOLUTION_ENABLED = originalEnabled
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await pool.query('DELETE FROM evo_test_auth_sessions WHERE user_id=?', [owner])
    await pool.query('DELETE FROM evo_test_users WHERE id=?', [owner])
    await pool.end()
  }
})
