import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { captureEvolutionSkill } from '../src/runtime/evolution/evolutionSkillSnapshot.js'
import { saveEvolutionSkillPackage } from '../src/runtime/evolution/evolutionSkillPackage.js'
import { evaluateEvolutionSkill } from '../src/runtime/evolution/evolutionSkillEvaluation.js'
import { AiEvolutionArtifactStore } from '../src/services/aiEvolutionArtifactStore.js'
import { getAiSkillDirectory, getAiSkillRoot } from '../src/services/aiSkillService.js'
import { previewEvolutionSkillComparison } from '../src/services/aiEvolutionSkillComparisonPreview.js'
import { EVOLUTION_REQUIRED_CHECKS } from '../src/contracts/aiEvolutionEvaluationContract.js'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'
import { evolutionSkillTrialTarget } from '../src/services/aiEvolutionSkillTrialPolicy.js'
import { createEvolutionSkillApplicationService } from '../src/services/aiEvolutionSkillApplicationService.js'
import { listEvolutionSkillPackages } from '../src/services/aiEvolutionSkillPackageList.js'
import { createSkillExpiryWorker } from '../src/services/aiEvolutionSkillExpiryService.js'
import { evolutionSkillPromotionTarget } from '../src/services/aiEvolutionSkillPromotionPolicy.js'

test('isolated MySQL registers immutable packages once and reads actual candidate evaluation hash',
  { skip: process.env.EVOLUTION_ISOLATED_MYSQL_TEST !== 'true' }, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1'); assert.equal(process.env.DB_PORT, '43318')
  assert.equal(process.env.DB_DATABASE, 'evolution_isolated_test'); assert.equal(process.env.DB_USERNAME, 'evolution_test'); assert.equal(process.env.DB_FREFIX, 'evo_test_')
  const { pool } = await import('../src/db/client.js')
  const { MySqlAiEvolutionRepository } = await import('../src/repositories/mysql/mysqlAiEvolutionRepository.js')
  const { MySqlAiEvolutionCandidateRepository } = await import('../src/repositories/mysql/mysqlAiEvolutionCandidateRepository.js')
  const { MySqlAiEvolutionSkillVersionRepository } = await import('../src/repositories/mysql/mysqlAiEvolutionSkillVersionRepository.js')
  const { MySqlAiEvolutionSkillBindingRepository } = await import('../src/repositories/mysql/mysqlAiEvolutionSkillBindingRepository.js')
  const { MySqlAiEvolutionSkillApplicationRepository } = await import('../src/repositories/mysql/mysqlAiEvolutionSkillApplicationRepository.js')
  try {
    const migration = await readFile('server/drizzle/0106_add_ai_evolution_skill_applications.sql', 'utf8')
    await pool.query(migration.replaceAll('`sbl_', '`evo_test_').replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '))
    const [pending] = await pool.query("SELECT id FROM evo_test_ai_evolution_runs WHERE status NOT IN ('failed','succeeded','cancelled')")
    assert.equal((pending as unknown[]).length, 0)
    const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-version-mysql-')), store = new AiEvolutionArtifactStore(root)
    const owner = randomUUID(), capabilityId = randomUUID()
    const snapshot = await captureEvolutionSkill({ capabilityId, capabilityKey: 'draft-due-diligence-report',
      directory: getAiSkillDirectory('draft-due-diligence-report'), allowedRoot: getAiSkillRoot(), toolNames: [], dependencyNames: [], config: {} })
    const candidate = { ...snapshot.version, instructions: snapshot.version.instructions + '\n保留来源。' }
    const runs = new MySqlAiEvolutionRepository(), candidates = new MySqlAiEvolutionCandidateRepository(), versions = new MySqlAiEvolutionSkillVersionRepository()
    const conversationId = randomUUID()
    const projectId = process.env.EVOLUTION_SKILL_PROJECT_HTTP_TEST === 'true' ? randomUUID() : undefined
    const spec: EvolutionSpec = { schemaVersion: 1, kind: 'skill', title: 'fixture', objective: 'fixture', sourceRefs: [{ type: 'message', id: 'fixture', conversationId }],
      scope: projectId ? { type: 'project', key: projectId } : { type: 'user', key: owner }, businessProjectId: projectId,
      questions: [], acceptanceCriteria: ['fixture'], budget: { maxModelTokens: 10000, maxDurationSeconds: 600, maxRepairRounds: 0 },
      target: { type: 'skill', capabilityId, baseContentHash: snapshot.contentHash, sampleIds: ['sample'] } }
    const proposal = await runs.createProposal(owner, spec, randomUUID())
    const queued = await runs.enqueue(owner, proposal.id, proposal.revision, proposal.specHash, randomUUID())
    const run = (await runs.claimNext('version-test', 60, new Date(), 'skill'))!; assert.equal(run.id, queued.id)
    const identity = { runId: run.id, attempt: run.attempt, leaseToken: run.leaseToken, inputHash: run.inputHash }
    const result = await evaluateEvolutionSkill({ baseline: snapshot.version, candidate, samples: [{ id: 'sample', input: 'fixture', materialHashes: [] }],
      runtime: { modelId: 'fixture', modelVersion: 'fixture', promptHash: 'fixture', rendererVersion: 'fixture' }, suiteVersion: 'fixture',
      control: { identity, signal: new AbortController().signal, assertCanContinue: async () => {} }, store,
      metric: { name: 'fixture', direction: 'higher', minimumImprovement: 1 },
      run: async ({ skill }) => ({ content: Buffer.from(skill.instructions), contentType: 'text/plain' }),
      assess: async ({ output }) => ({ score: output.content.toString() === candidate.instructions ? 2 : 1,
        checks: EVOLUTION_REQUIRED_CHECKS.skill.map(id => ({ id, verdict: 'PASS', evidence: 'fixture only' })) }) })
    const saved = await saveEvolutionSkillPackage({ runId: run.id, snapshot, version: candidate }, store)
    const baselinePackage = await saveEvolutionSkillPackage({ runId: run.id, snapshot, version: snapshot.version }, store)
    const manifest = { schemaVersion: 1 as const, sourceHash: result.candidateHash, patchHash: 'a'.repeat(64), dependencyLockHash: 'b'.repeat(64),
      environment: 'fixture', artifacts: [...result.artifacts, saved.artifact, baselinePackage.artifact] }
    const packageList = await listEvolutionSkillPackages({ runId: run.id, baseRef: snapshot.contentHash, manifest }, store)
    assert.deepEqual(packageList.map(row => row.side), ['candidate', 'baseline'])
    assert.equal(manifest.artifacts[packageList[0].artifactIndex].sha256, saved.artifact.sha256)
    await runs.transition(identity, 'executing'); await runs.transition(identity, 'evaluating')
    const completed = await candidates.completeRun(identity, { baseRef: snapshot.contentHash, summary: 'fixture', manifest, evaluation: result.evaluation })
    const persisted = (await candidates.findForOwner(owner, completed.id))!
    if (process.env.EVOLUTION_SKILL_HTTP_FLOW_TEST === 'true') {
      const { verifyAuthorizedEvolutionHttp } = await import('./fixtures/evolutionAuthorizedHttp.js')
      await verifyAuthorizedEvolutionHttp({ owner, capabilityId, conversationId, candidateId: completed.id, root, projectId })
      return
    }
    assert.equal((await previewEvolutionSkillComparison({ ...persisted.candidate,
      evaluation: { hash: persisted.evaluation.evaluationHash, report: persisted.evaluation.report } }, store)).samples.length, 1)
    let registrationChecks = 0
    await assert.rejects(versions.registerCandidatePackage(owner, completed.id, saved.artifact, store, async () => {
      await pool.query('SELECT 1')
      if (++registrationChecks === 2) throw Error('registration source revoked')
    }), /registration source revoked/)
    const [notRegistered] = await pool.query('SELECT id FROM evo_test_ai_evolution_skill_versions WHERE candidate_id=?', [completed.id])
    assert.equal((notRegistered as unknown[]).length, 0)
    assert.equal(registrationChecks, 2)
    const registrations = await Promise.all([1, 2, 3].map(() => versions.registerCandidatePackage(owner, completed.id, saved.artifact, store)))
    assert.equal(new Set(registrations.map(row => row.versionId)).size, 1)
    assert.equal(registrations.filter(row => !row.duplicate).length, 1)
    assert.equal((await versions.findForOwner(owner, registrations[0].versionId))?.contentHash, saved.contentHash)
    assert.equal(await versions.findForOwner(randomUUID(), registrations[0].versionId), null)
    await assert.rejects(versions.registerCandidatePackage(randomUUID(), completed.id, saved.artifact, store), { code: 'EVOLUTION_NOT_FOUND' })
    await assert.rejects(versions.registerCandidatePackage(owner, completed.id, { ...saved.artifact, bytes: 0 }, store), { code: 'EVOLUTION_SKILL_PACKAGE_INVALID' })
    const baselineVersion = await versions.registerCandidatePackage(owner, completed.id, baselinePackage.artifact, store)
    await candidates.decide(owner, completed.id, { candidateHash: completed.contentHash, evaluationHash: completed.evaluationHash,
      scope: spec.scope, environment: manifest.environment, decision: 'approved', expiresAt: new Date(Date.now() + 600000) })
    const target = evolutionSkillTrialTarget({ capabilityId, versionId: registrations[0].versionId, fallbackVersionId: baselineVersion.versionId,
      expectedRevision: 0, scope: spec.scope, trialExpiresAt: new Date(Date.now() + 3600000).toISOString() })
    const actor = { userId: owner, enabled: true, targetEnvironmentGrant: true }
    const approval = await candidates.recordReleaseApproval(completed.id, { actor, currentBaseRef: snapshot.contentHash,
      candidateHash: completed.contentHash, evaluationHash: completed.evaluationHash, scope: spec.scope,
      targetEnvironment: target.environment, expiresAt: new Date(Date.now() + 600000) })
    const bindings = new MySqlAiEvolutionSkillBindingRepository()
    assert.equal(await bindings.findForScope(capabilityId, { type: 'user', key: owner }), null)
    const activate = { target, actor, approvalId: approval.approvalId, idempotencyKey: randomUUID(), maxTrialSeconds: 7200, expectedCandidateId: completed.id }
    await assert.rejects(bindings.activateTrial({ ...activate, expectedCandidateId: randomUUID() }, store), { code: 'EVOLUTION_RELEASE_BINDING' })
    await assert.rejects(bindings.activateTrial({ ...activate, actor: { ...actor, targetEnvironmentGrant: false } }, store), { code: 'EVOLUTION_RELEASE_FORBIDDEN' })
    const outcomes = await Promise.all([1, 2, 3].map(() => bindings.activateTrial(activate, store)))
    assert.equal(new Set(outcomes.map(outcome => outcome.bindingId)).size, 1)
    assert.equal(outcomes.filter(outcome => !outcome.duplicate).length, 1)
    assert.equal(outcomes[0].revision, 1)
    assert.equal((await bindings.findForScope(capabilityId, { type: 'user', key: owner }))?.activeVersionId, target.versionId)
    assert.equal(await bindings.findForScope(capabilityId, { type: 'project', key: owner }), null)
    await assert.rejects(bindings.activateTrial({ ...activate, target: evolutionSkillTrialTarget({ capabilityId,
      versionId: target.versionId, fallbackVersionId: target.fallbackVersionId, expectedRevision: 1, scope: target.scope, trialExpiresAt: target.trialExpiresAt }) }, store),
      { code: 'EVOLUTION_IDEMPOTENCY_CONFLICT' })
    await assert.rejects(bindings.activateTrial({ ...activate, idempotencyKey: randomUUID() }, store), { code: 'EVOLUTION_RELEASE_APPROVAL_REQUIRED' })
    const [bound] = await pool.query('SELECT active_version_id,fallback_version_id,revision FROM evo_test_ai_evolution_skill_bindings WHERE id=?', [outcomes[0].bindingId])
    assert.deepEqual(JSON.parse(JSON.stringify(bound)), [{ active_version_id: target.versionId, fallback_version_id: target.fallbackVersionId, revision: 1 }])
    const [history] = await pool.query('SELECT id FROM evo_test_ai_evolution_skill_binding_changes WHERE binding_id=?', [outcomes[0].bindingId])
    assert.equal((history as unknown[]).length, 1)
    const scopeInput = { capabilityId, scope: target.scope }
    const authorize = async (selection: { ownerUserId: string }) => { await pool.query('SELECT 1'); assert.equal(selection.ownerUserId, owner) }
    const frozen = await bindings.resolveForScope(scopeInput, authorize, store)
    assert.equal(frozen?.snapshot.versionId, target.versionId)
    assert.equal(frozen?.snapshot.reason, 'active')
    const applications = new MySqlAiEvolutionSkillApplicationRepository()
    const context = { ownerUserId: owner, taskId: randomUUID(), taskType: 'chat', conversationId: randomUUID(), businessProjectId: null }
    const taskSnapshot = { schemaVersion: 1, entries: [{ capabilityId, status: 'selected', selection: frozen!.snapshot }] }
    const frozenTasks = await Promise.all([1, 2, 3].map(() => applications.freeze(context, taskSnapshot)))
    assert.equal(new Set(frozenTasks.map(task => task.id)).size, 1)
    await assert.rejects(applications.freeze({ ...context, taskType: 'report' }, taskSnapshot), { code: 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT' })
    const emptyContext = { ...context, taskId: randomUUID() }
    await applications.freeze(emptyContext, { schemaVersion: 1, entries: [] })
    assert.equal((await applications.freeze(emptyContext, taskSnapshot)).snapshot.entries.length, 0)
    const expired = await bindings.resolveForScope(scopeInput, authorize, store, new Date(target.trialExpiresAt))
    assert.equal(expired?.snapshot.versionId, target.fallbackVersionId)
    assert.equal(expired?.snapshot.reason, 'trial_expired')
    let artifactRead = false
    await assert.rejects(bindings.resolveForScope(scopeInput, async () => { throw Error('source access revoked') },
      { read: async () => { artifactRead = true; throw Error('must not read') } }), /source access revoked/)
    assert.equal(artifactRead, false)
    assert.equal(await bindings.resolveForScope({ capabilityId, scope: { type: 'user', key: randomUUID() } }, authorize, store), null)
    const rollback = { bindingId: outcomes[0].bindingId, expectedRevision: 1, actor, idempotencyKey: randomUUID(), expectedActiveHash: saved.contentHash }
    if (process.env.EVOLUTION_SKILL_PROMOTION_TEST === 'true') {
      const promotionTarget = evolutionSkillPromotionTarget({ bindingId: rollback.bindingId, capabilityId,
        versionId: target.versionId, fallbackVersionId: target.fallbackVersionId, expectedRevision: 1, scope: target.scope })
      const current = (await candidates.findForOwner(owner, completed.id))!
      const approval = await candidates.recordReleaseApproval(completed.id, { actor, operation: 'skill_promotion',
        candidateHash: current.candidate.contentHash, evaluationHash: current.evaluation.evaluationHash,
        scope: spec.scope, currentBaseRef: baselineVersion.contentHash, targetEnvironment: promotionTarget.environment,
        expiresAt: new Date(Date.now() + 60000) })
      const promote = { actor, target: promotionTarget, approvalId: approval.approvalId, expectedCandidateId: completed.id, idempotencyKey: randomUUID() }
      await assert.rejects(bindings.promoteTrial(promote, { read: async () => { throw Error('missing promotion artifact') } }), /missing promotion artifact/)
      const promoted = await Promise.all([1, 2, 3].map(() => bindings.promoteTrial(promote, store)))
      assert.equal(promoted.filter(row => !row.duplicate).length, 1)
      assert.ok(promoted.every(row => row.revision === 2 && row.versionId === target.versionId))
      const permanent = await bindings.findForPublisher(owner, rollback.bindingId)
      assert.equal(permanent?.trialExpiresAt, null)
      assert.equal(permanent?.fallbackVersionId, target.fallbackVersionId)
      assert.equal(await bindings.expireTrial(rollback.bindingId, store, new Date(target.trialExpiresAt)), null)
      const reverted = await bindings.rollbackTrial({ ...rollback, expectedRevision: 2 }, store)
      assert.equal(reverted.versionId, target.fallbackVersionId)
      assert.equal(reverted.revision, 3)
      console.log('PASS promotion concurrency, expiry exclusion and retained fallback rollback')
      return
    }
    assert.equal((await bindings.findForPublisher(owner, rollback.bindingId))?.revision, 1)
    assert.equal(await bindings.findForPublisher(randomUUID(), rollback.bindingId), null)
    await assert.rejects(bindings.rollbackTrial({ ...rollback, expectedActiveHash: '0'.repeat(64) }, store), { code: 'EVOLUTION_RELEASE_BINDING' })
    await assert.rejects(bindings.rollbackTrial({ ...rollback, expectedRevision: 2 }, store), { code: 'EVOLUTION_REVISION_CONFLICT' })
    await assert.rejects(bindings.rollbackTrial(rollback, { read: async () => { throw Error('missing fallback artifact') } }), /missing fallback artifact/)
    const restored = await Promise.all([1, 2, 3].map(() => bindings.rollbackTrial(rollback, store)))
    assert.equal(restored.filter(row => !row.duplicate).length, 1)
    assert.ok(restored.every(row => row.revision === 2 && row.versionId === baselineVersion.versionId))
    const [after] = await pool.query('SELECT active_version_id,fallback_version_id,trial_expires_at,revision FROM evo_test_ai_evolution_skill_bindings WHERE id=?', [rollback.bindingId])
    assert.deepEqual(JSON.parse(JSON.stringify(after)), [{ active_version_id: baselineVersion.versionId, fallback_version_id: null, trial_expires_at: null, revision: 2 }])
    assert.equal((await candidates.findForOwner(owner, completed.id))!.candidate.status, 'rolled_back')
    assert.equal(frozen?.snapshot.versionId, target.versionId, 'an already selected task snapshot is not rewritten by rollback')
    assert.equal((await bindings.resolveForScope(scopeInput, authorize, store))?.snapshot.versionId, baselineVersion.versionId)
    const expiryBindingId = randomUUID()
    const deadline = new Date(Date.now() + 60000)
    await pool.query(`INSERT INTO evo_test_ai_evolution_skill_bindings
      (id,capability_id,scope_type,scope_key,active_version_id,fallback_version_id,trial_expires_at,revision,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?)`, [expiryBindingId, capabilityId, 'user', randomUUID(), target.versionId,
      baselineVersion.versionId, deadline, 1, owner])
    assert.equal(await bindings.expireTrial(expiryBindingId, store, new Date(deadline.getTime() - 1)), null)
    assert.ok(!(await bindings.listExpired(new Date(deadline.getTime() - 1))).some(row => row.id === expiryBindingId))
    assert.ok((await bindings.listExpired(deadline)).some(row => row.id === expiryBindingId))
    await assert.rejects(bindings.expireTrial(expiryBindingId, { read: async () => { throw Error('missing expiry fallback') } }, deadline), /missing expiry fallback/)
    assert.equal((await bindings.findForPublisher(owner, expiryBindingId))?.revision, 1)
    const expirations = await Promise.all([1, 2, 3].map(() => bindings.expireTrial(expiryBindingId, store, deadline)))
    assert.equal(expirations.filter(result => result && !result.duplicate).length, 1)
    const expiredBinding = await bindings.findForPublisher(owner, expiryBindingId)
    assert.equal(expiredBinding?.activeVersionId, baselineVersion.versionId)
    assert.equal(expiredBinding?.trialExpiresAt, null)
    assert.equal(expiredBinding?.revision, 2)
    assert.equal(await bindings.expireTrial(expiryBindingId, store, deadline), null)
    assert.ok(!(await bindings.listExpired(deadline)).some(row => row.id === expiryBindingId))
    const [expiryHistory] = await pool.query('SELECT operation,revision FROM evo_test_ai_evolution_skill_binding_changes WHERE binding_id=?', [expiryBindingId])
    assert.deepEqual(JSON.parse(JSON.stringify(expiryHistory)), [{ operation: 'expiry', revision: 2 }])
    const scheduledId = randomUUID()
    await pool.query(`INSERT INTO evo_test_ai_evolution_skill_bindings
      (id,capability_id,scope_type,scope_key,active_version_id,fallback_version_id,trial_expires_at,revision,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?)`, [scheduledId, capabilityId, 'user', randomUUID(), target.versionId,
      baselineVersion.versionId, new Date(Date.now() - 1000), 1, owner])
    let finished!: () => void
    let failed!: (error: unknown) => void
    const completion = new Promise<void>((resolve, reject) => { finished = resolve; failed = reject })
    // Other retained runs use different temporary artifact roots; this fixture owns only scheduledId.
    const scheduler = createSkillExpiryWorker({ listExpired: async (now, cursor) => (await bindings.listExpired(now, cursor)).filter(row => row.id === scheduledId),
      expire: async (id, now) => { const result = await bindings.expireTrial(id, store, now); if (id === scheduledId) finished(); return result },
      onError: failed }, 20)
    const timeout = setTimeout(() => failed(Error('scheduled expiry timed out')), 5000)
    try {
      scheduler.start()
      await completion
    } finally { clearTimeout(timeout); await scheduler.stop() }
    const scheduledBinding = await bindings.findForPublisher(owner, scheduledId)
    assert.equal(scheduledBinding?.activeVersionId, baselineVersion.versionId)
    assert.equal(scheduledBinding?.trialExpiresAt, null)
    assert.equal(scheduledBinding?.revision, 2)
    const afterRollback = (await bindings.resolveForScope(scopeInput, authorize, store))!
    const retained = await applications.freeze(context, { schemaVersion: 1, entries: [{ capabilityId, status: 'selected', selection: afterRollback.snapshot }] })
    assert.deepEqual(retained.snapshot, taskSnapshot)
    const resumed = await applications.read(context, authorize, store)
    assert.equal(resumed?.packages[0].versionId, target.versionId)
    assert.equal(resumed?.packages[0].bundle.version.instructions, candidate.instructions)
    assert.equal((await applications.read(emptyContext, authorize, store))?.packages.length, 0)
    await assert.rejects(applications.read({ ...context, conversationId: randomUUID() }, authorize, store), { code: 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT' })
    let staleRead = false
    await assert.rejects(applications.read(context, async () => { throw Error('revoked saved source') },
      { read: async () => { staleRead = true; throw Error('must not read') } }), /revoked saved source/)
    assert.equal(staleRead, false)
    assert.equal(await applications.read({ ...context, ownerUserId: randomUUID() }, authorize, store), null)
    const applySkill = createEvolutionSkillApplicationService({ applications, bindings, store,
      authorizeContext: async ctx => { assert.equal(ctx.ownerUserId, owner) },
      authorizeSource: async (_ctx, source) => authorize(source),
      authorizeRetry: async (ctx, original) => {
        assert.equal(ctx.ownerUserId, original.ownerUserId)
        assert.equal(original.taskId, context.taskId)
      } })
    const inherited = await applySkill({ ...context, taskId: randomUUID() }, [capabilityId], [scopeInput.scope], context.taskId)
    assert.equal(inherited.packages[0].versionId, target.versionId)
    assert.equal(inherited.packages[0].runtime.version.instructions, candidate.instructions)
    assert.ok(Buffer.from(inherited.packages[0].runtime.files.find(file => file.path === 'SKILL.md')!.contentBase64, 'base64')
      .toString().endsWith('保留来源。'))
    const newTask = await applySkill({ ...context, taskId: randomUUID() }, [capabilityId], [scopeInput.scope])
    assert.equal(newTask.packages[0].versionId, baselineVersion.versionId)
    assert.equal(newTask.packages[0].runtime.version.instructions, snapshot.version.instructions)
    const baselineContext = { ...context, taskId: randomUUID() }
    const baselineEntry = { capabilityId, status: 'baseline', ownerUserId: owner, sourceTaskId: run.id,
      contentHash: baselinePackage.contentHash, packageHash: baselinePackage.packageHash, artifact: baselinePackage.artifact }
    await applications.freeze(baselineContext, { schemaVersion: 1, entries: [baselineEntry] })
    const baselineRead = await applications.read(baselineContext, async () => { throw Error('Builtin baseline is not an evolution source run') }, store)
    assert.equal(baselineRead?.packages[0].bundle.version.instructions, snapshot.version.instructions)
    const baselineRetry = { ...context, taskId: randomUUID() }
    const retryBaseline = createEvolutionSkillApplicationService({ applications, bindings, store,
      authorizeContext: async ctx => { assert.equal(ctx.ownerUserId, owner) }, authorizeSource: async () => { throw Error('Unexpected evolution source') },
      authorizeRetry: async (_ctx, original) => { assert.equal(original.taskId, baselineContext.taskId) } })
    const inheritedBaseline = await retryBaseline(baselineRetry, [capabilityId], [scopeInput.scope], baselineContext.taskId)
    assert.equal(inheritedBaseline.packages[0].runtime.contentHash, snapshot.contentHash)
    assert.deepEqual(inheritedBaseline.snapshot.entries, [baselineEntry])
    await assert.rejects(applications.freeze({ ...context, taskId: randomUUID() }, { schemaVersion: 1,
      entries: [{ ...baselineEntry, ownerUserId: randomUUID() }] }), { code: 'EVOLUTION_SCOPE_FORBIDDEN' })
    console.log(JSON.stringify({ root, versionId: registrations[0].versionId, candidateId: completed.id }))
  } finally { await pool.end() }
})
