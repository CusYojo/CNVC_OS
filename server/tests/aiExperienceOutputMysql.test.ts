import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createAiExperienceCheckBudget } from '../src/services/aiExperienceCheckBudget.js'
import { completeAiExperienceCheck } from '../src/services/aiExperienceCompletion.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'

test('isolated MySQL preserves the first output-check binding under concurrent retries', { skip: process.env.EVOLUTION_ISOLATED_MYSQL_TEST !== 'true' }, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '43318')
  assert.equal(process.env.DB_DATABASE, 'evolution_isolated_test')
  assert.equal(process.env.DB_FREFIX, 'evo_test_')
  const { pool } = await import('../src/db/client.js')
  const { MySqlAiExperienceRepository } = await import('../src/repositories/mysql/mysqlAiExperienceRepository.js')
  try {
    const [columns] = await pool.query("SHOW COLUMNS FROM evo_test_ai_evolution_applications LIKE 'check_execution'")
    if (Array.isArray(columns) && columns.length === 0) {
      await pool.query((await readFile(new URL('../drizzle/0104_add_ai_experience_check_execution.sql', import.meta.url), 'utf8')).replaceAll('`sbl_', '`evo_test_'))
    }
    const repository = new MySqlAiExperienceRepository(), userId = randomUUID(), taskId = randomUUID()
    const snapshot = { schemaVersion: 1, taskType: 'chat', businessProjectId: null,
      loaded: [{ versionId: 'version', experienceId: 'experience', contentHash: 'hash', rule: '标注未知信息', exceptions: [] }], excluded: [] }
    const application = await repository.recordApplication({ userId, taskId, taskType: 'chat', snapshot })
    assert.equal(application.checkStatus, 'not_checked')
    const result = { schemaVersion: 1, snapshotHash: evolutionContentHash(snapshot), outputHash: evolutionContentHash({ output: '尚无证据' }),
      checkerVersion: 'isolated-test-v1', verdict: 'PASS', checks: [{ versionId: 'version', verdict: 'PASS', explanation: '标明证据缺口', excerpts: ['尚无证据'] }] }
    await assert.rejects(repository.recordOutputCheck(userId, taskId, { ...result, checks: [{ ...result.checks[0], verdict: 'FAIL' }] }))
    await assert.rejects(repository.recordOutputCheck(userId, taskId, { ...result, checks: [{ ...result.checks[0], versionId: 'foreign-version' }] }), { code: 'EVOLUTION_OUTPUT_CHECK_EVIDENCE' })
    await assert.rejects(repository.recordOutputCheck(userId, taskId, { ...result, verdict: 'NOT_RUN', checks: [] }), { code: 'EVOLUTION_OUTPUT_CHECK_EVIDENCE' })
    assert.equal((await repository.findApplication(userId, taskId))?.checkStatus, 'not_checked')
    const binding = { snapshotHash: result.snapshotHash, outputHash: result.outputHash, checkerVersion: result.checkerVersion, maxTokens: 1000 }
    const reservations = await Promise.all(Array.from({ length: 3 }, () => repository.reserveOutputCheck(userId, taskId, binding, 500)))
    assert.equal(reservations.filter(value => value.mayInvoke).length, 1)
    assert.equal(new Set(reservations.map(value => value.reservationId)).size, 1)
    const restarted = createAiExperienceCheckBudget(new MySqlAiExperienceRepository(), userId, taskId, binding)
    await assert.rejects(restarted.reserveModelTokens(500), { code: 'EVOLUTION_MODEL_CALL_UNCERTAIN' })
    await assert.rejects(repository.recordOutputCheck(userId, taskId, result), { code: 'EVOLUTION_OUTPUT_CHECK_CONFLICT' })
    await repository.settleOutputCheck(userId, taskId, reservations[0].reservationId, null)
    assert.equal((await repository.findApplication(userId, taskId))?.checkExecution?.actualTokens, null)
    const rows = await Promise.all(Array.from({ length: 3 }, () => repository.recordOutputCheck(userId, taskId, result)))
    assert.ok(rows.every(row => row.id === application.id && row.checkStatus === 'PASS'))
    await assert.rejects(repository.recordOutputCheck(userId, taskId, { ...result, outputHash: 'b'.repeat(64) }), { code: 'EVOLUTION_OUTPUT_CHECK_CONFLICT' })
    await assert.rejects(repository.recordOutputCheck(userId, taskId, { ...result, snapshotHash: 'c'.repeat(64) }), { code: 'EVOLUTION_APPLICATION_CORRUPT' })
    await assert.rejects(repository.recordOutputCheck(randomUUID(), taskId, result), { code: 'EVOLUTION_NOT_FOUND' })
    assert.deepEqual((await repository.findApplication(userId, taskId))?.checkResult, result)
    const overBudgetTask = randomUUID()
    await repository.recordApplication({ userId, taskId: overBudgetTask, taskType: 'chat', snapshot })
    const budget = createAiExperienceCheckBudget(repository, userId, overBudgetTask, binding)
    await budget.reserveModelTokens(500)
    await assert.rejects(budget.recordModelUsage(1500, 500), { code: 'EVOLUTION_BUDGET_EXCEEDED' })
    await assert.rejects(repository.recordOutputCheck(userId, overBudgetTask, result), { code: 'EVOLUTION_OUTPUT_CHECK_CONFLICT' })
    const exceeded = await repository.findApplication(userId, overBudgetTask)
    assert.equal(exceeded?.checkExecution?.actualTokens, 1500)
    assert.equal(exceeded?.checkResult, null)
    const completedTask = randomUUID()
    await repository.recordApplication({ userId, taskId: completedTask, taskType: 'chat', snapshot })
    let calls = 0
    const completion = { repository, userId, taskId: completedTask, output: '尚无证据', maxTokens: 64000,
      route: { modelId: 'test-model', model: 'reviewer', providerId: 'provider', baseUrl: 'https://example.test/v1', apiKey: 'test-secret', timeoutMs: 1000 },
      assertAuthorized: async () => {}, fetchImpl: (async () => {
        calls++
        return new Response(JSON.stringify({ output: [{ content: [{ text: JSON.stringify({ checks: result.checks }) }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }))
      }) as typeof fetch }
    const checked = await completeAiExperienceCheck(completion)
    assert.equal(checked.checkStatus, 'PASS')
    assert.equal(checked.checkExecution?.actualTokens, 30)
    assert.equal((await completeAiExperienceCheck(completion)).id, checked.id)
    assert.equal(calls, 1)
    await assert.rejects(completeAiExperienceCheck({ ...completion, output: '另一个输出' }), { code: 'EVOLUTION_OUTPUT_CHECK_CONFLICT' })
  } finally { await pool.end() }
})
