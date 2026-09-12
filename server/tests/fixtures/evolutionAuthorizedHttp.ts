import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'

async function prepareEvolutionBrowserFixture(): Promise<{ root: string; stop(): Promise<void> }> {
  const fixtureRoot = path.resolve('.runtime/evolution-ui')
  await mkdir(fixtureRoot, { recursive: true })
  await writeFile(path.join(fixtureRoot, 'skill-status.html'), '<main id="root"></main><script type="module" src="/\.runtime/evolution-ui/skill-status.js"></script>')
  await writeFile(path.join(fixtureRoot, 'skill-status.tsx'), `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { AiEvolutionSkillTrialStatus } from '../../src/components/ai-evolution/AiEvolutionSkillTrialStatus'
    const query = new URLSearchParams(location.search)
    createRoot(document.getElementById('root')!).render(React.createElement(AiEvolutionSkillTrialStatus, {
      candidateId: query.get('candidateId') || '', candidateHash: query.get('candidateHash') || ''
    }))
  `)
  await build({
    entryPoints: [path.join(fixtureRoot, 'skill-status.tsx')],
    outfile: path.join(fixtureRoot, 'skill-status.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent',
  })
  return { root: fixtureRoot, stop: () => rm(fixtureRoot, { recursive: true, force: true }) }
}

export async function verifyAuthorizedEvolutionHttp(input: { owner: string; capabilityId: string; conversationId: string; candidateId: string; root: string; projectId?: string }) {
  const { pool } = await import('../../src/db/client.js')
  for (const [file, table] of [['0000_mysql_baseline.sql', 'users'], ['0000_mysql_baseline.sql', 'chat_conversations'],
    ['0011_add_auth_sessions.sql', 'auth_sessions'], ['0004_add_agent_conversation_schema.sql', 'agent_messages'], ['0026_add_ai_capability_management.sql', 'ai_capabilities']]) {
    const statement = (await readFile(`server/drizzle/${file}`, 'utf8')).match(new RegExp('CREATE TABLE `sbl_' + table + '` \\([\\s\\S]*?\\n\\);'))?.[0]
    assert.ok(statement)
    await pool.query(statement.replaceAll('`sbl_', '`evo_test_').replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '))
  }
  const grantFile = path.join(input.root, 'http-skill-grants.json')
  const grant = { schemaVersion: 1, capabilities: [{ capabilityId: input.capabilityId, capabilityKey: 'draft-due-diligence-report',
    source: 'builtin', capabilityRevision: 1, grantRevision: 1, allowedUserIds: [input.owner],
    publication: { scopes: [input.projectId ? { type: 'project', key: input.projectId } : { type: 'user', key: input.owner }], maxTrialSeconds: 7200 } }] }
  const old = { enabled: process.env.AI_EVOLUTION_ENABLED, root: process.env.AI_EVOLUTION_ARTIFACT_ROOT, grants: process.env.AI_EVOLUTION_SKILLS_FILE }
  process.env.AI_EVOLUTION_ENABLED = 'true'; process.env.AI_EVOLUTION_ARTIFACT_ROOT = input.root; process.env.AI_EVOLUTION_SKILLS_FILE = grantFile
  await writeFile(grantFile, JSON.stringify(grant))
  await pool.query('INSERT INTO evo_test_users (id,email,name,role,password_hash) VALUES (?,?,?,?,?)', [input.owner, `${input.owner}@example.invalid`, 'HTTP owner', 'AI平台管理员', 'no-login-password'])
  if (input.projectId) {
    const { prepareEvolutionProjectSchema } = await import('./evolutionProjectSchema.js')
    await prepareEvolutionProjectSchema()
    await pool.query('INSERT INTO evo_test_projects (id,name,owner,owner_user_id,created_by) VALUES (?,?,?,?,?)',
      [input.projectId, 'isolated evolution project', 'HTTP owner', input.owner, input.owner])
  }
  await pool.query('INSERT INTO evo_test_chat_conversations (id,user_id,title,scope,messages) VALUES (?,?,?,?,?)', [input.conversationId, input.owner, 'fixture', 'global', JSON.stringify([{ id: 'fixture', role: 'user' }])])
  if (input.projectId) await pool.query('UPDATE evo_test_chat_conversations SET project_id=?,scope=? WHERE id=?', [input.projectId, 'project', input.conversationId])
  await pool.query('INSERT INTO evo_test_ai_capabilities (id,kind,capability_key,name,config,tool_names,dependency_names,allowed_roles) VALUES (?,?,?,?,?,?,?,?)',
    [input.capabilityId, 'skill', 'draft-due-diligence-report', 'fixture', '{}', '[]', '[]', '[]'])
  const { createAuthSession } = await import('../../src/services/authService.js')
  const { requireAuth } = await import('../../src/middleware/requireAuth.js')
  const { aiEvolutionRouter } = await import('../../src/routes/aiEvolution.js')
  const { errorHandler } = await import('../../src/middleware/errorHandler.js')
  const session = await createAuthSession({ userId: input.owner })
  const app = express(); app.use(express.json()); app.use('/api/ai/evolution', requireAuth, aiEvolutionRouter); app.use(errorHandler)
  const browserFixture = process.env.EVOLUTION_SKILL_BROWSER_TEST === 'true' ? await prepareEvolutionBrowserFixture() : null
  if (browserFixture) app.use('/.runtime/evolution-ui', express.static(browserFixture.root))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai/evolution/candidates/${input.candidateId}`
    const headers = { Cookie: `cybernaut_session=${session.sessionToken}` }
    if (input.projectId) {
      const { proposeAgentEvolution } = await import('../../src/services/agentAiEvolutionToolService.js')
      const [rows] = await pool.query('SELECT r.frozen_spec FROM evo_test_ai_evolution_runs r JOIN evo_test_ai_evolution_candidates c ON c.run_id=r.id WHERE c.id=?', [input.candidateId])
      const rawSpec = (rows as { frozen_spec: unknown }[])[0].frozen_spec
      const spec = typeof rawSpec === 'string' ? JSON.parse(rawSpec) : rawSpec as Record<string, unknown>
      spec.target = { ...spec.target, sampleIds: [randomUUID()] }
      const proposal = await proposeAgentEvolution(input.owner, input.conversationId, spec)
      assert.equal(proposal.spec.scope.type, 'project')
      assert.equal(proposal.spec.scope.key, input.projectId)
      const repeated = await proposeAgentEvolution(input.owner, input.conversationId, spec)
      assert.equal(repeated.id, proposal.id)
      await pool.query('UPDATE evo_test_chat_conversations SET messages=? WHERE id=?', [JSON.stringify([{ id: 'fixture', role: 'assistant' }]), input.conversationId])
      try {
        await assert.rejects(proposeAgentEvolution(input.owner, input.conversationId, spec), { code: 'EVOLUTION_SOURCE_FORBIDDEN' })
      } finally {
        await pool.query('UPDATE evo_test_chat_conversations SET messages=? WHERE id=?', [JSON.stringify([{ id: 'fixture', role: 'user' }]), input.conversationId])
      }
      await pool.query('UPDATE evo_test_chat_conversations SET messages=? WHERE id=?', [JSON.stringify([
        { id: 'fixture', role: 'user' }, { id: 'assistant-evidence', role: 'assistant' }]), input.conversationId])
      try {
        const withEvidence = await proposeAgentEvolution(input.owner, input.conversationId, { ...spec,
          sourceRefs: [...spec.sourceRefs, { type: 'message', id: 'assistant-evidence', conversationId: input.conversationId }] })
        assert.equal(withEvidence.spec.sourceRefs.length, 2)
      } finally {
        await pool.query('UPDATE evo_test_chat_conversations SET messages=? WHERE id=?', [JSON.stringify([{ id: 'fixture', role: 'user' }]), input.conversationId])
      }
      const [proposalRuns] = await pool.query('SELECT id FROM evo_test_ai_evolution_runs WHERE proposal_id=?', [proposal.id])
      assert.equal((proposalRuns as unknown[]).length, 0, 'chat proposal must not execute automatically')
      await writeFile(grantFile, JSON.stringify({ schemaVersion: 1, capabilities: [] }))
      try {
        await assert.rejects(proposeAgentEvolution(input.owner, input.conversationId, spec), { code: 'EVOLUTION_SCOPE_FORBIDDEN' })
      } finally { await writeFile(grantFile, JSON.stringify(grant)) }
      const foreignProjectId = randomUUID()
      await assert.rejects(proposeAgentEvolution(input.owner, input.conversationId, { ...spec, businessProjectId: foreignProjectId, scope: { type: 'project', key: foreignProjectId } }), { code: 'EVOLUTION_SCOPE_FORBIDDEN' })
    }
    for (const suffix of ['', '/skill-comparison', '/skill-packages', '/skill-trial']) {
      const response = await fetch(`${base}${suffix}`, { headers })
      assert.equal(response.status, 200, `${suffix}: ${await response.text()}`)
    }
    await writeFile(grantFile, JSON.stringify({ schemaVersion: 1, capabilities: [] }))
    const deniedPlan = await fetch(`${base}/skill-trial-plan`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      body: JSON.stringify({ versionId: input.candidateId, fallbackVersionId: input.owner, durationSeconds: 3600 }) })
    assert.equal(deniedPlan.status, 403)
    await writeFile(grantFile, JSON.stringify(grant))
    if (input.projectId) {
      await pool.query('UPDATE evo_test_projects SET owner_user_id=NULL,created_by=NULL WHERE id=?', [input.projectId])
      assert.equal((await fetch(base, { headers })).status, 403)
      await pool.query('UPDATE evo_test_projects SET owner_user_id=?,created_by=? WHERE id=?', [input.owner, input.owner, input.projectId])
      assert.equal((await fetch(base, { headers })).status, 200)
    }
    await pool.query('UPDATE evo_test_chat_conversations SET messages=? WHERE id=?', ['[]', input.conversationId])
    assert.equal((await fetch(base, { headers })).status, 403)
    await pool.query('UPDATE evo_test_chat_conversations SET messages=? WHERE id=?', [JSON.stringify([{ id: 'fixture', role: 'user' }]), input.conversationId])
    assert.equal((await fetch(base, { headers })).status, 200)
    const post = async (suffix: string, body: unknown, key?: string) => {
      const response = await fetch(`${base}/${suffix}`, { method: 'POST', headers: { ...headers,
        'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) })
      const payload = await response.json()
      assert.equal(response.status, 200, `${suffix}: ${JSON.stringify(payload)}`)
      return payload
    }
    const candidate = await (await fetch(base, { headers })).json()
    const packages = await (await fetch(`${base}/skill-packages`, { headers })).json()
    const versionIds: Record<string, string> = {}
    for (const item of packages.list) {
      const saved = await post('skill-versions', { candidateHash: candidate.contentHash, artifactIndex: item.artifactIndex })
      versionIds[item.side] = saved.versionId
      const repeated = await post('skill-versions', { candidateHash: candidate.contentHash, artifactIndex: item.artifactIndex })
      assert.equal(repeated.versionId, saved.versionId); assert.equal(repeated.duplicate, true)
    }
    await post('decision', { candidateHash: candidate.contentHash, evaluationHash: candidate.evaluation.hash,
      scope: candidate.scope, environment: candidate.manifest.environment, decision: 'approved' })
    const plan = await post('skill-trial-plan', { versionId: versionIds.candidate, fallbackVersionId: versionIds.baseline, durationSeconds: 3600 })
    const approval = await post('skill-trial-approval', { target: plan.target, candidateHash: plan.candidateHash, evaluationHash: plan.evaluationHash })
    const startKey = randomUUID()
    const starts = await Promise.all([1, 2, 3].map(() => post('skill-trial', { target: plan.target, approvalId: approval.approvalId }, startKey)))
    assert.equal(starts.filter(row => !row.duplicate).length, 1)
    assert.equal(new Set(starts.map(row => row.bindingId)).size, 1)
    const status = await (await fetch(`${base}/skill-trial`, { headers })).json()
    assert.equal(status.binding.matchesCandidate, true); assert.equal(status.binding.canRollback, true)
    if (input.projectId) {
      const { verifyProjectSkillConsumer } = await import('./evolutionProjectConsumer.js')
      await verifyProjectSkillConsumer({ projectId: input.projectId, capabilityId: input.capabilityId, versionId: versionIds.candidate, candidateId: input.candidateId })
    }
    if (process.env.EVOLUTION_SKILL_BROWSER_TEST === 'true') {
      const playwrightPath = 'file:///C:/Users/21749/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
      const { chromium } = await import(playwrightPath)
      const browser = await chromium.launch({ channel: 'msedge', headless: true })
      try {
        const origin = new URL(base).origin
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
        await context.addCookies([{ name: 'cybernaut_session', value: session.sessionToken, url: origin, httpOnly: true },
          { name: 'cybernaut_csrf', value: session.csrfToken, url: origin }])
        const page = await context.newPage()
        await page.goto(`${origin}/.runtime/evolution-ui/skill-status.html?candidateId=${input.candidateId}&candidateHash=${candidate.contentHash}`)
        await page.getByRole('button', { name: '查看正式生效方案' }).click()
        await page.getByRole('button', { name: '批准正式生效' }).click()
        await page.getByText('当前绑定使用此版本', { exact: true }).waitFor()
        await page.reload()
        await page.getByRole('button', { name: '恢复已登记的回退版本' }).click()
        await page.getByText('当前绑定使用其他版本', { exact: true }).waitFor()
        await page.screenshot({ path: path.join(input.root, 'real-browser-promotion-rollback.png') })
        const [history] = await pool.query('SELECT operation,revision FROM evo_test_ai_evolution_skill_binding_changes WHERE binding_id=? ORDER BY revision', [status.binding.bindingId])
        assert.deepEqual(JSON.parse(JSON.stringify(history)), [{ operation: 'trial', revision: 1 }, { operation: 'promotion', revision: 2 }, { operation: 'rollback', revision: 3 }])
        console.log(`PASS real browser + session + HTTP + MySQL promotion and rollback; evidence ${input.root}`)
      } finally { await browser.close() }
      return
    }
    const rollbackKey = randomUUID()
    let rollbackRevision = status.binding.revision
    if (process.env.EVOLUTION_SKILL_HTTP_PROMOTION_TEST === 'true') {
      const promotionPlan = await post('skill-promotion-plan', { bindingId: status.binding.bindingId })
      const promotionApproval = await post('skill-promotion-approval', promotionPlan)
      const promotionKey = randomUUID()
      const promoted = await Promise.all([1, 2, 3].map(() => post('skill-promotion', {
        target: promotionPlan.target, approvalId: promotionApproval.approvalId }, promotionKey)))
      assert.equal(promoted.filter(row => !row.duplicate).length, 1)
      assert.ok(promoted.every(row => row.revision === 2))
      rollbackRevision = 2
    }
    const rollbacks = await Promise.all([1, 2, 3].map(() => post('skill-trial-rollback', {
      bindingId: status.binding.bindingId, expectedRevision: rollbackRevision }, rollbackKey)))
    assert.equal(rollbacks.filter(row => !row.duplicate).length, 1)
    assert.ok(rollbacks.every(row => row.versionId === versionIds.baseline && row.revision === rollbackRevision + 1))
    const restored = await (await fetch(`${base}/skill-trial`, { headers })).json()
    assert.equal(restored.binding.matchesCandidate, false); assert.equal(restored.binding.canRollback, false)
    const [history] = await pool.query('SELECT operation,revision FROM evo_test_ai_evolution_skill_binding_changes WHERE binding_id=? ORDER BY revision', [status.binding.bindingId])
    assert.deepEqual(JSON.parse(JSON.stringify(history)), [{ operation: 'trial', revision: 1 },
      ...(rollbackRevision === 2 ? [{ operation: 'promotion', revision: 2 }] : []), { operation: 'rollback', revision: rollbackRevision + 1 }])
    console.log('PASS real HTTP registration, review, trial plan, approval, concurrent activation, status and concurrent rollback')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await browserFixture?.stop()
    await pool.query('DELETE FROM evo_test_auth_sessions WHERE user_id=?', [input.owner])
    await pool.query('DELETE FROM evo_test_chat_conversations WHERE id=?', [input.conversationId])
    await pool.query('DELETE FROM evo_test_ai_capabilities WHERE id=?', [input.capabilityId])
    if (input.projectId) await pool.query('DELETE FROM evo_test_projects WHERE id=?', [input.projectId])
    await pool.query('DELETE FROM evo_test_users WHERE id=?', [input.owner])
    for (const [key, value] of [['AI_EVOLUTION_ENABLED', old.enabled], ['AI_EVOLUTION_ARTIFACT_ROOT', old.root], ['AI_EVOLUTION_SKILLS_FILE', old.grants]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value
    }
  }
}
