import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'
import type { EvolutionCandidateManifest, EvolutionEvaluationReport } from '../src/contracts/aiEvolutionEvaluationContract.js'

test('isolated MySQL: idempotency, ownership, revision races, frozen execution and cancellation', {
  skip: process.env.EVOLUTION_ISOLATED_MYSQL_TEST !== 'true',
}, async () => {
  // This suite never consumes a user's configured database or loads .env.
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '43318')
  assert.equal(process.env.DB_DATABASE, 'evolution_isolated_test')
  assert.equal(process.env.DB_USERNAME, 'evolution_test')
  assert.equal(process.env.DB_FREFIX, 'evo_test_')
  const { pool } = await import('../src/db/client.js')
  const { MySqlAiEvolutionRepository } = await import('../src/repositories/mysql/mysqlAiEvolutionRepository.js')
  try {
    const migration = (await Promise.all(['0098_add_ai_evolution_tasks.sql', '0099_add_ai_evolution_model_calls.sql', '0100_add_ai_evolution_candidates.sql', '0101_add_ai_experience_versions.sql'].map((file) => readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8')))).join('\n')
    for (const statement of migration.replace(/^--.*$/gm, '').replaceAll('`sbl_', '`evo_test_').split(';').map((s) => s.trim()).filter(Boolean)) {
      await pool.query(statement.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '))
    }
    const [timeColumns] = await pool.query("SHOW COLUMNS FROM evo_test_ai_evolution_runs LIKE 'time_accounted_at'")
    if (Array.isArray(timeColumns) && timeColumns.length === 0) {
      const timeMigration = await readFile(new URL('../drizzle/0102_add_ai_evolution_time_accounting.sql', import.meta.url), 'utf8')
      for (const statement of timeMigration.replaceAll('`sbl_', '`evo_test_').split(';').map((value) => value.trim()).filter(Boolean)) await pool.query(statement)
    }
    const repo = new MySqlAiEvolutionRepository()
    const [purposeColumns] = await pool.query("SHOW COLUMNS FROM evo_test_ai_evolution_approvals LIKE 'purpose'")
    if (Array.isArray(purposeColumns) && purposeColumns.length === 0) {
      const releaseMigration = await readFile(new URL('../drizzle/0103_add_ai_evolution_release_approval.sql', import.meta.url), 'utf8')
      for (const statement of releaseMigration.replaceAll('`sbl_', '`evo_test_').split(';').map((value) => value.trim()).filter(Boolean)) await pool.query(statement)
    }
    const [checkColumns] = await pool.query("SHOW COLUMNS FROM evo_test_ai_evolution_applications LIKE 'check_execution'")
    if (Array.isArray(checkColumns) && checkColumns.length === 0) {
      await pool.query((await readFile(new URL('../drizzle/0104_add_ai_experience_check_execution.sql', import.meta.url), 'utf8')).replaceAll('`sbl_', '`evo_test_'))
    }
    // Fixed ephemeral database only; remove earlier runs so queue-claim races are deterministic.
    const [activeRuns] = await pool.query("SELECT id FROM evo_test_ai_evolution_runs WHERE status NOT IN ('failed','succeeded','cancelled')")
    assert.equal((activeRuns as unknown[]).length, 0, 'Refuse to clear the isolated database while evolution work is active')
    const skillMigration = await readFile(new URL('../drizzle/0105_add_ai_evolution_skill_versions.sql', import.meta.url), 'utf8')
    for (const statement of skillMigration.replaceAll('`sbl_', '`evo_test_').split(';').map(value => value.trim()).filter(Boolean)) {
      await pool.query(statement.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '))
    }
    await pool.query((await readFile(new URL('../drizzle/0106_add_ai_evolution_skill_applications.sql', import.meta.url), 'utf8'))
      .replaceAll('`sbl_', '`evo_test_').replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '))
    await pool.query((await readFile(new URL('../drizzle/0107_add_ai_evolution_release_jobs.sql', import.meta.url), 'utf8'))
      .replaceAll('`sbl_', '`evo_test_').replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '))
    for (const table of ['ai_evolution_release_jobs', 'ai_evolution_skill_applications', 'ai_evolution_skill_binding_changes', 'ai_evolution_skill_bindings', 'ai_evolution_skill_versions', 'ai_evolution_applications', 'ai_experience_versions', 'ai_experiences', 'ai_evolution_approvals', 'ai_evolution_evaluations', 'ai_evolution_candidates', 'ai_evolution_model_calls', 'ai_evolution_events', 'ai_evolution_audits', 'ai_evolution_runs', 'ai_evolution_proposals']) {
      await pool.query(`DELETE FROM evo_test_${table}`)
    }
    const userId = randomUUID()
    const spec: EvolutionSpec = {
      schemaVersion: 1, kind: 'experience', title: '来源规则', objective: '金额必须有来源',
      sourceRefs: [{ type: 'message', id: randomUUID() }], scope: { type: 'user', key: userId },
      acceptanceCriteria: ['无来源标记待核验'], questions: [],
      budget: { maxDurationSeconds: 600, maxModelTokens: 10000, maxRepairRounds: 3 },
      target: { type: 'experience', rule: '无来源标记待核验', taskTypes: ['chat'], exceptions: [], replacesVersionIds: [] },
    }
    const key = randomUUID()
    const creates = await Promise.all(Array.from({ length: 5 }, () => repo.createProposal(userId, spec, key)))
    assert.equal(new Set(creates.map((row) => row.id)).size, 1)
    const proposal = creates[0]
    await assert.rejects(repo.createProposal(userId, { ...spec, title: '不同内容' }, key), { code: 'EVOLUTION_IDEMPOTENCY_CONFLICT' })
    assert.equal(await repo.findProposal(randomUUID(), proposal.id), null)
    const edits = await Promise.allSettled([
      repo.editProposal(userId, proposal.id, 1, { ...spec, title: '版本 A' }),
      repo.editProposal(userId, proposal.id, 1, { ...spec, title: '版本 B' }),
    ])
    assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1)
    const updated = (await repo.findProposal(userId, proposal.id))!
    const executeKey = randomUUID()
    const queued = await Promise.all(Array.from({ length: 3 }, () => repo.enqueue(userId, proposal.id, updated.revision, updated.specHash, executeKey)))
    assert.equal(new Set(queued.map((row) => row.id)).size, 1)
    assert.deepEqual(queued[0].frozenSpec, updated.spec)
    assert.equal(await repo.claimNext('code-only', 60, new Date(), 'code'), null)
    assert.equal(await repo.claimNext('skill-only', 60, new Date(), 'skill'), null)
    await assert.rejects(repo.editProposal(userId, proposal.id, updated.revision + 1, spec), { code: 'EVOLUTION_REVISION_CONFLICT' })
    const cancelled = await repo.requestCancel(userId, queued[0].id)
    assert.equal(cancelled.status, 'queued')
    assert.ok(cancelled.cancelRequestedAt)
    await repo.requestCancel(userId, queued[0].id)
    const events = await repo.listEvents(userId, queued[0].id, 0)
    assert.deepEqual(events.map((event) => [event.sequence, event.eventType]), [[1, 'queued'], [2, 'cancel_requested']])
    assert.equal((await repo.listEvents(userId, queued[0].id, 1)).length, 1)
    await assert.rejects(repo.listEvents(randomUUID(), queued[0].id, 0), { code: 'EVOLUTION_NOT_FOUND' })
    const [auditRows] = await pool.query('SELECT action FROM evo_test_ai_evolution_audits WHERE proposal_id = ?', [proposal.id])
    assert.equal((auditRows as unknown[]).length, 4)
    assert.equal(await repo.claimNext('cancelled-queue-worker'), null)
    assert.equal((await repo.findRun(userId, queued[0].id))!.status, 'cancelled')

    const nextProposal = await repo.createProposal(userId, spec, randomUUID())
    const nextRun = await repo.enqueue(userId, nextProposal.id, 1, nextProposal.specHash, randomUUID())
    const now = new Date()
    const claims = await Promise.all(Array.from({ length: 5 }, (_, i) => repo.claimNext(`worker-${i}`, 30, now)))
    assert.equal(claims.filter(Boolean).length, 1)
    const claim = claims.find(Boolean)!
    assert.equal(claim.id, nextRun.id)
    const identity = { runId: claim.id, attempt: claim.attempt, leaseToken: claim.leaseToken, inputHash: claim.inputHash }
    await Promise.all(Array.from({ length: 3 }, () => repo.bindExecutionProfile(identity, 'f'.repeat(64), now)))
    assert.equal((await repo.listEvents(userId, claim.id, 0)).filter((event) => event.eventType === 'execution_profile_bound').length, 1)
    await assert.rejects(repo.bindExecutionProfile(identity, 'e'.repeat(64), now), { code: 'EVOLUTION_EXECUTION_PROFILE_CHANGED' })
    await assert.rejects(repo.bindExecutionProfile({ ...identity, leaseToken: 0 }, 'f'.repeat(64), now), { code: 'EVOLUTION_STALE_EXECUTOR' })
    await repo.transition(identity, 'executing', { stage: 'source_prepared' }, now)
    const reservations = await Promise.all(Array.from({ length: 3 }, () => repo.reserveModelCall(identity, 'round-0', 'c'.repeat(64), 6000, now)))
    assert.equal(reservations.filter((item) => item.mayInvoke).length, 1)
    assert.equal(new Set(reservations.map((item) => item.reservationId)).size, 1)
    await assert.rejects(repo.reserveModelCall(identity, 'round-1', 'd'.repeat(64), 5000, now), { code: 'EVOLUTION_BUDGET_EXCEEDED' })
    await repo.settleModelCall(identity, reservations[0].reservationId, 2000, now)
    assert.equal((await repo.findRun(userId, claim.id))!.modelTokens, 2000)
    const unknownCall = await repo.reserveModelCall(identity, 'round-1', 'd'.repeat(64), 7000, now)
    await repo.settleModelCall(identity, unknownCall.reservationId, null, now)
    assert.equal((await repo.findRun(userId, claim.id))!.modelTokens, null)
    await assert.rejects(repo.reserveModelCall(identity, 'round-2', 'e'.repeat(64), 2000, now), { code: 'EVOLUTION_BUDGET_EXCEEDED' })
    await assert.rejects(repo.settleModelCall(identity, reservations[0].reservationId, 1000, now), { code: 'EVOLUTION_USAGE_CONFLICT' })
    await assert.rejects(repo.transition({ ...identity, leaseToken: 0 }, 'evaluating', null, now), { code: 'EVOLUTION_STALE_EXECUTOR' })
    assert.equal((await repo.heartbeat(identity, 30, now)).cancelRequested, false)
    const expired = new Date(now.getTime() + 31_000)
    await assert.rejects(repo.heartbeat(identity, 30, expired), { code: 'EVOLUTION_STALE_EXECUTOR' })
    const recoveryEnvironment = process.env.EVOLUTION_RECOVERY_DOCKER_TEST === 'true'
      ? new (await import('../src/runtime/evolution/dockerEvolutionEnvironment.js')).DockerEvolutionEnvironment() : null
    if (recoveryEnvironment) {
      assert.equal(await recoveryEnvironment.available(), true)
      await recoveryEnvironment.create(identity)
    }
    assert.deepEqual(await repo.revokeExpired(expired, 'code'), [])
    assert.deepEqual(await repo.revokeExpired(expired, 'skill'), [])
    const revoked = await repo.revokeExpired(expired, 'experience')
    assert.equal(revoked.length, 1)
    assert.equal((await repo.listPendingTermination()).length, 1)
    assert.equal((await repo.listPendingTermination('code')).length, 0)
    assert.equal((await repo.listPendingTermination('skill')).length, 0)
    assert.equal((await repo.listPendingTermination('experience')).length, 1)
    assert.equal((await repo.findRun(userId, claim.id))!.status, 'executing')
    await assert.rejects(repo.transition(identity, 'evaluating', null, expired), { code: 'EVOLUTION_STALE_EXECUTOR' })
    if (recoveryEnvironment) {
      try {
        const { EvolutionRunCoordinator } = await import('../src/runtime/evolution/evolutionRunCoordinator.js')
        const recovered = new EvolutionRunCoordinator(new MySqlAiEvolutionRepository(), 'restarted-worker',
          async () => { throw Error('No queued work should be executed during this recovery scenario') },
          (lease) => recoveryEnvironment.terminate(lease))
        await recovered.tick()
        await assert.rejects(repo.transition(identity, 'evaluating', null, expired), { code: 'EVOLUTION_STALE_EXECUTOR' })
        console.log('RECOVERY_VERIFIED reconstructed coordinator cleaned real Docker environment; stale result rejected')
      } finally { await recoveryEnvironment.terminate(identity) }
    } else await repo.confirmTermination(claim.id, revoked[0].leaseToken, expired)
    assert.equal((await repo.findRun(userId, claim.id))!.status, 'interrupted')
    assert.equal((await repo.listPendingTermination()).length, 0)
    const beforeResume = (await repo.findRun(userId, claim.id))!
    await Promise.all(Array.from({ length: 3 }, () => repo.resumeInterrupted(userId, claim.id, claim.attempt)))
    const resumed = (await repo.claimNext('resume-worker'))!
    assert.equal(resumed.id, claim.id)
    assert.equal(resumed.attempt, claim.attempt + 1)
    assert.equal(resumed.elapsedSeconds, beforeResume.elapsedSeconds)
    assert.equal(resumed.modelTokens, beforeResume.modelTokens)
    const resumedIdentity = { runId: resumed.id, attempt: resumed.attempt, leaseToken: resumed.leaseToken, inputHash: resumed.inputHash }
    await repo.bindExecutionProfile(resumedIdentity, 'f'.repeat(64))
    await assert.rejects(repo.bindExecutionProfile(resumedIdentity, 'e'.repeat(64)), { code: 'EVOLUTION_EXECUTION_PROFILE_CHANGED' })
    await assert.rejects(repo.reserveModelCall(resumedIdentity, 'resumed-call', 'a'.repeat(64), 2000), { code: 'EVOLUTION_BUDGET_EXCEEDED' })
    await assert.rejects(repo.resumeInterrupted(userId, claim.id, claim.attempt), { code: 'EVOLUTION_REVISION_CONFLICT' })
    await repo.requestCancel(userId, claim.id)
    const resumeRevoked = await repo.revokeRun(resumedIdentity, { code: 'EVOLUTION_CANCEL_REQUESTED', message: 'test cancellation' })
    await repo.confirmTermination(claim.id, resumeRevoked.leaseToken)
    const timedSpec = { ...spec, budget: { ...spec.budget, maxDurationSeconds: 30 } }
    const timedProposal = await repo.createProposal(userId, timedSpec, randomUUID())
    await repo.enqueue(userId, timedProposal.id, 1, timedProposal.specHash, randomUUID())
    const startedAt = new Date()
    const timedRun = (await repo.claimNext('time-worker', 60, startedAt))!
    const timedIdentity = { runId: timedRun.id, attempt: timedRun.attempt, leaseToken: timedRun.leaseToken, inputHash: timedRun.inputHash }
    await repo.heartbeat(timedIdentity, 60, new Date(startedAt.getTime() + 1500))
    await repo.transition(timedIdentity, 'executing', null, new Date(startedAt.getTime() + 1900))
    assert.equal((await repo.findRun(userId, timedRun.id))!.elapsedSeconds, 1)
    const exhausted = new Date(startedAt.getTime() + 30500)
    assert.equal((await repo.heartbeat(timedIdentity, 60, exhausted)).durationExceeded, true)
    await assert.rejects(repo.reserveModelCall(timedIdentity, 'after-duration', 'a'.repeat(64), 1, exhausted), { code: 'EVOLUTION_DURATION_EXCEEDED' })
    await repo.transition(timedIdentity, 'failed', null, new Date(startedAt.getTime() + 31500))
    assert.equal((await repo.findRun(userId, timedRun.id))!.elapsedSeconds, 31)
    assert.equal((await repo.findRun(userId, timedRun.id))!.timeAccountedAt, null)
    const { MySqlAiEvolutionCandidateRepository } = await import('../src/repositories/mysql/mysqlAiEvolutionCandidateRepository.js')
    const candidateRepo = new MySqlAiEvolutionCandidateRepository()
    const resultProposal = await repo.createProposal(userId, spec, randomUUID())
    await repo.enqueue(userId, resultProposal.id, 1, resultProposal.specHash, randomUUID())
    const resultRun = (await repo.claimNext('result-worker', 60))!
    const resultIdentity = { runId: resultRun.id, attempt: resultRun.attempt, leaseToken: resultRun.leaseToken, inputHash: resultRun.inputHash }
    await repo.transition(resultIdentity, 'executing')
    const retainedCheckpoint = { schemaVersion: 1, kind: 'skill', candidateHash: 'a'.repeat(64), artifacts: [{ storageKey: 'fixture/report' }] }
    await repo.saveCheckpoint(resultIdentity, retainedCheckpoint, 0)
    await repo.transition(resultIdentity, 'evaluating')
    assert.deepEqual((await repo.findRun(userId, resultRun.id))!.checkpoint, retainedCheckpoint)
    const manifest: EvolutionCandidateManifest = { schemaVersion: 1, sourceHash: 'a'.repeat(64), patchHash: 'b'.repeat(64), dependencyLockHash: 'c'.repeat(64), environment: 'isolated-test',
      artifacts: [{ storageKey: 'fixture/content', sha256: 'd'.repeat(64), bytes: 1, kind: 'content' }, { storageKey: 'fixture/report', sha256: 'e'.repeat(64), bytes: 1, kind: 'report' }] }
    const evaluation: EvolutionEvaluationReport = { suiteVersion: 'test-experience-v1', candidateHash: manifest.sourceHash, verdict: 'PASS', checks: ['source', 'scope', 'conflict', 'version'].map((id) => ({ id, verdict: 'PASS', evidence: 'test-fixture-assertion' })) }
    const completion = { baseRef: 'new', summary: '规则候选', manifest, evaluation }
    await assert.rejects(candidateRepo.completeRun(resultIdentity, { ...completion, evaluation: { ...evaluation, checks: [] } }), { code: 'EVOLUTION_EVALUATION_INCOMPLETE' })
    assert.equal((await repo.findRun(userId, resultRun.id))!.status, 'evaluating')
    const result = await candidateRepo.completeRun(resultIdentity, completion)
    assert.equal(result.status, 'awaiting_approval')
    assert.equal((await repo.findRun(userId, resultRun.id))!.status, 'succeeded')
    assert.equal(await candidateRepo.findForOwner(randomUUID(), result.id), null)
    const approval = { candidateHash: result.contentHash, evaluationHash: result.evaluationHash, scope: spec.scope, environment: manifest.environment, decision: 'approved' as const, expiresAt: new Date(Date.now() + 60_000) }
    await assert.rejects(candidateRepo.decide(userId, result.id, { ...approval, candidateHash: 'f'.repeat(64) }), { code: 'EVOLUTION_APPROVAL_BINDING' })
    const reviewApproval = await candidateRepo.decide(userId, result.id, approval)
    assert.equal(reviewApproval.status, 'approved')
    assert.equal((await candidateRepo.findForOwner(userId, result.id))!.candidate.status, 'approved')
    const runtimeIdentity = { schemaVersion: 1 as const, baseCommit: 'a'.repeat(40), patchHash: 'b'.repeat(64), lockHash: 'c'.repeat(64),
      serverEntrySha256: 'd'.repeat(64), webEntrySha256: 'e'.repeat(64) }
    const releaseContext = { actor: { userId, enabled: true, targetEnvironmentGrant: true }, currentBaseRef: 'new', targetEnvironment: 'test-release-target',
      receipt: { releaseId: 'new-release', candidateHash: result.contentHash, previousReleaseId: 'old-release',
        candidateIdentity: runtimeIdentity, previousIdentity: { ...runtimeIdentity, serverEntrySha256: 'f'.repeat(64) } } }
    await assert.rejects(candidateRepo.claimRelease(reviewApproval.approvalId, releaseContext), { code: 'EVOLUTION_RELEASE_APPROVAL_REQUIRED' })
    const releaseApproval = await candidateRepo.recordReleaseApproval(result.id, { ...releaseContext,
      candidateHash: result.contentHash, evaluationHash: result.evaluationHash, scope: spec.scope, expiresAt: new Date(Date.now() + 60_000) })
    await assert.rejects(candidateRepo.readClaimedRelease(releaseApproval.approvalId, userId, releaseContext.targetEnvironment), { code: 'EVOLUTION_RELEASE_BINDING' })
    await assert.rejects(candidateRepo.claimRelease(releaseApproval.approvalId, { ...releaseContext, currentBaseRef: 'changed' }), { code: 'EVOLUTION_REEVALUATION_REQUIRED' })
    const releaseClaims = await Promise.allSettled(Array.from({ length: 3 }, () => candidateRepo.claimRelease(releaseApproval.approvalId, releaseContext)))
    assert.equal(releaseClaims.filter((item) => item.status === 'fulfilled').length, 3)
    assert.equal(releaseClaims.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof candidateRepo.claimRelease>>> => item.status === 'fulfilled')
      .filter(item => !item.value.duplicate).length, 1)
    assert.equal((await candidateRepo.findForOwner(userId, result.id))!.candidate.status, 'activating')
    const recoveredClaim = await candidateRepo.readClaimedRelease(releaseApproval.approvalId, userId, releaseContext.targetEnvironment)
    assert.deepEqual(recoveredClaim.receipt, releaseContext.receipt)
    assert.equal(recoveredClaim.status, 'activating')
    await assert.rejects(candidateRepo.readClaimedRelease(releaseApproval.approvalId, randomUUID(), releaseContext.targetEnvironment), { code: 'EVOLUTION_NOT_FOUND' })
    await assert.rejects(candidateRepo.readClaimedRelease(releaseApproval.approvalId, userId, 'other-target'), { code: 'EVOLUTION_RELEASE_BINDING' })
    await pool.query('UPDATE evo_test_ai_evolution_approvals SET expires_at=? WHERE id=?', [new Date(Date.now() - 60_000), releaseApproval.approvalId])
    assert.deepEqual((await candidateRepo.readClaimedRelease(releaseApproval.approvalId, userId, releaseContext.targetEnvironment)).receipt, releaseContext.receipt)
    await pool.query("UPDATE evo_test_ai_evolution_events SET payload=JSON_SET(payload,'$.receipt.candidateHash',?) WHERE run_id=? AND event_type='release_claimed'", ['f'.repeat(64), recoveredClaim.runId])
    try {
      await assert.rejects(candidateRepo.readClaimedRelease(releaseApproval.approvalId, userId, releaseContext.targetEnvironment), { code: 'EVOLUTION_RELEASE_BINDING' })
    } finally {
      await pool.query("UPDATE evo_test_ai_evolution_events SET payload=JSON_SET(payload,'$.receipt.candidateHash',?) WHERE run_id=? AND event_type='release_claimed'", [releaseContext.receipt.candidateHash, recoveredClaim.runId])
    }
    await assert.rejects(candidateRepo.completeRelease(releaseApproval.approvalId, userId, { ...releaseContext.receipt, releaseId: 'other-release' }, 'active'), { code: 'EVOLUTION_RELEASE_BINDING' })
    assert.equal((await candidateRepo.completeRelease(releaseApproval.approvalId, userId, releaseContext.receipt, 'rolled_back')).duplicate, false)
    assert.equal((await candidateRepo.completeRelease(releaseApproval.approvalId, userId, releaseContext.receipt, 'rolled_back')).duplicate, true)
    assert.equal((await candidateRepo.readClaimedRelease(releaseApproval.approvalId, userId, releaseContext.targetEnvironment)).status, 'rolled_back')
    await assert.rejects(candidateRepo.completeRelease(releaseApproval.approvalId, userId, releaseContext.receipt, 'active'), { code: 'EVOLUTION_RELEASE_STATE' })
    const { MySqlAiExperienceRepository } = await import('../src/repositories/mysql/mysqlAiExperienceRepository.js')
    const experiences = new MySqlAiExperienceRepository()
    const experienceProposal = await repo.createProposal(userId, spec, randomUUID())
    const saved = await experiences.savePersonal(userId, experienceProposal.id, 1, experienceProposal.specHash)
    assert.deepEqual(await experiences.savePersonal(userId, experienceProposal.id, 1, experienceProposal.specHash), saved)
    const personal = await experiences.listPersonal(userId)
    assert.equal(personal.length, 1)
    assert.equal(personal[0].experience.activeVersionId, saved.versionId)
    assert.deepEqual(await experiences.listPersonal(randomUUID()), [])
    const applicationInput = { userId, taskId: 'chat-turn-1', taskType: 'chat', snapshot: { versions: [saved.versionId] } }
    const application = await experiences.recordApplication(applicationInput)
    assert.equal(application.checkStatus, 'not_checked')
    await assert.rejects(experiences.recordApplication({ ...applicationInput, snapshot: { versions: [] } }), { code: 'EVOLUTION_APPLICATION_FROZEN' })
    await experiences.disablePersonal(userId, saved.experienceId, 1)
    assert.equal((await experiences.listPersonal(userId))[0].experience.status, 'disabled')
    assert.deepEqual((await experiences.recordApplication(applicationInput)).snapshot, { versions: [saved.versionId] })
  } finally {
    await pool.end()
  }
})
