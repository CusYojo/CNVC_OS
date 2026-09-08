import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createEvolutionDueDiligenceEvaluator } from '../src/runtime/evolution/evolutionDueDiligenceEvaluator.js'
import { captureEvolutionSkill } from '../src/runtime/evolution/evolutionSkillSnapshot.js'
import { DockerEvolutionEnvironment } from '../src/runtime/evolution/dockerEvolutionEnvironment.js'
import { freezeEvolutionSkillSampleSuite } from '../src/runtime/evolution/evolutionSkillSampleSuite.js'
import { parseEvolutionDueDiligenceSample } from '../src/runtime/evolution/evolutionDueDiligenceSample.js'
import { getAiSkillDirectory, getAiSkillRoot } from '../src/services/aiSkillService.js'
import { AiEvolutionArtifactStore } from '../src/services/aiEvolutionArtifactStore.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'
import { createEvolutionSkillExecutor } from '../src/runtime/evolution/evolutionSkillExecutor.js'
import { EvolutionRunCoordinator } from '../src/runtime/evolution/evolutionRunCoordinator.js'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'
import { parseEvolutionSkillPackage } from '../src/runtime/evolution/evolutionSkillPackage.js'

test('composed evaluator executes visible and hidden baselines/candidates in real Docker and retains failed reports',
  { skip: process.env.EVOLUTION_SKILL_RENDER_DOCKER_TEST !== 'true', timeout: 360000 }, async () => {
  const image = process.env.EVOLUTION_SKILL_RENDER_IMAGE!
  assert.match(image, /^sha256:[a-f0-9]{64}$/)
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-dd-comparison-'))
  const store = new AiEvolutionArtifactStore(path.join(root, 'artifacts'))
  const capabilityId = randomUUID(), userId = randomUUID()
  const fixture = async (name: string) => JSON.parse(await readFile(`server/tests/fixtures/evolution-due-diligence/${name}.json`, 'utf8'))
  const evidence = await fixture('evidence'), report = await fixture('report'), diligenceData = await fixture('diligence-data')
  const snapshot = await captureEvolutionSkill({ capabilityId, capabilityKey: 'draft-due-diligence-report',
    directory: getAiSkillDirectory('draft-due-diligence-report'), allowedRoot: getAiSkillRoot(), toolNames: [], dependencyNames: [], config: {} })
  const samples = freezeEvolutionSkillSampleSuite({ schemaVersion: 1, suiteId: 'docker-comparison-fixture', capabilityId, allowedUserIds: [userId],
    samples: [false, true].map(hidden => {
      const input = { project: { name: evidence.project.name, companyName: evidence.project.legal_entity }, evidence,
        sourceCutoffDate: evidence.project.cutoff_date, diligenceScope: {}, sectionTitles: ['公司与股权'],
        content: { title: hidden ? 'HIDDEN_INPUT_CASE' : 'VISIBLE_INPUT_CASE', executiveSummary: '', sections: [], highlights: [], risks: [], missing: [] } }
      return { id: hidden ? 'hidden' : 'visible', hidden, input, inputHash: evolutionContentHash(input), materialHashes: [evolutionContentHash(evidence)],
        rules: ['sources', 'required_fields', 'scope', 'regression'].map(gate => ({ id: gate, gate,
          text: gate === 'scope' ? 'HOST_ONLY_RUBRIC' : '测试科技有限公司', expectation: gate === 'scope' ? 'absent' : 'present', weight: 1 })) }
    }) }, parseEvolutionDueDiligenceSample)
  let generationCalls = 0, visionCalls = 0, hiddenCalls = 0, settled = 0, reserved = 0
  const environment = new DockerEvolutionEnvironment(undefined, image)
  const evaluator = await createEvolutionDueDiligenceEvaluator({ image, samples, snapshot, environment, store,
    maxOutputTokens: 1000, metric: { name: 'fixture coverage', direction: 'higher', minimumImprovement: 1 },
    route: { modelId: 'fixture', providerId: 'fixture', model: 'fixture', baseUrl: 'https://example.test/v1', apiKey: 'fixture', timeoutMs: 1000 },
    fetchImpl: async (_url, init) => {
      const body = String(init?.body)
      assert.equal(body.includes('HOST_ONLY_RUBRIC'), false, 'host rubric must never enter a model prompt')
      const request = JSON.parse(body)
      const vision = request.input.some((message: { content: { type: string }[] }) => message.content.some(part => part.type === 'input_image'))
      if (vision) visionCalls++
      else { generationCalls++; if (body.includes('HIDDEN_INPUT_CASE')) hiddenCalls++ }
      return new Response(JSON.stringify({ output_text: JSON.stringify(vision ? { verdict: 'FAIL', evidence: 'fixture review identifies incomplete contents' }
        : { reportMode: 'screening_public', report, diligenceData }), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }))
    } })
  const control = { identity: { runId: randomUUID(), attempt: 1, leaseToken: 1, inputHash: 'a'.repeat(64) },
    signal: new AbortController().signal, assertCanContinue: async () => {} }
  let closeDatabase: (() => Promise<void>) | undefined
  try {
    const evaluationInput = { ownerUserId: userId, baseline: snapshot.version,
      candidate: { ...snapshot.version, instructions: snapshot.version.instructions + '\n保持证据约束。' }, sampleIds: ['visible'], control,
      budget: { reserveModelTokens: async () => { reserved++ }, recordModelUsage: async () => { settled++ } } }
    let result: Awaited<ReturnType<typeof evaluator.evaluate>> | undefined
    if (process.env.EVOLUTION_SKILL_QUEUE_TEST === 'true') {
      assert.equal(process.env.DB_HOST, '127.0.0.1'); assert.equal(process.env.DB_PORT, '43318')
      assert.equal(process.env.DB_DATABASE, 'evolution_isolated_test'); assert.equal(process.env.DB_USERNAME, 'evolution_test')
      assert.equal(process.env.DB_FREFIX, 'evo_test_')
      const { pool } = await import('../src/db/client.js'); closeDatabase = () => pool.end()
      const { MySqlAiEvolutionRepository } = await import('../src/repositories/mysql/mysqlAiEvolutionRepository.js')
      const { MySqlAiEvolutionCandidateRepository } = await import('../src/repositories/mysql/mysqlAiEvolutionCandidateRepository.js')
      const [pending] = await pool.query("SELECT id FROM evo_test_ai_evolution_runs WHERE status NOT IN ('failed','succeeded','cancelled')")
      assert.equal((pending as unknown[]).length, 0, 'test database must have no other pending jobs')
      const runs = new MySqlAiEvolutionRepository(), candidates = new MySqlAiEvolutionCandidateRepository()
      const spec: EvolutionSpec = { schemaVersion: 1, kind: 'skill', title: '隔离技能队列测试', objective: '验证失败报告保存',
        scope: { type: 'user', key: userId }, sourceRefs: [{ type: 'message', id: 'fixture' }], questions: [], acceptanceCriteria: ['保留失败产物'],
        budget: { maxDurationSeconds: 300, maxModelTokens: 1000000, maxRepairRounds: 0 },
        target: { type: 'skill', capabilityId, baseContentHash: snapshot.contentHash, sampleIds: ['visible'] } }
      const proposal = await runs.createProposal(userId, spec, randomUUID())
      const queued = await runs.enqueue(userId, proposal.id, proposal.revision, proposal.specHash, randomUUID())
      const executor = createEvolutionSkillExecutor({ runs, candidates, artifacts: store, modelId: 'fixture',
        executionProfileHash: evaluator.profileHash, environment: image,
        authorize: async run => { assert.equal(run.id, queued.id); return { version: snapshot.version, authorizationHash: 'f'.repeat(64) } },
        develop: async () => ({ text: JSON.stringify({ summary: 'fixture candidate', instructions: evaluationInput.candidate.instructions,
          references: snapshot.version.references }), totalTokens: 21 }),
        evaluate: async args => {
          result = await evaluator.evaluate({ ...args, budget: {
            reserveModelTokens: async amount => { await args.budget.reserveModelTokens(amount); reserved++ },
            recordModelUsage: async (usage, amount) => { await args.budget.recordModelUsage(usage, amount); settled++ },
          } }); return result
        } })
      const coordinator = new EvolutionRunCoordinator(runs, 'skill-queue-fixture', async (run, actualControl) => {
        control.identity = actualControl.identity
        return executor(run, actualControl)
      }, evaluator.terminate, 'skill')
      await coordinator.tick()
      const persisted = (await runs.findRun(userId, queued.id))!
      assert.equal(persisted.status, 'failed')
      assert.equal(persisted.error?.code, 'EVOLUTION_REPAIR_BUDGET_EXHAUSTED')
      assert.equal(persisted.modelTokens, 21 + (generationCalls + visionCalls) * 15)
      assert.equal((persisted.checkpoint?.evaluation as { verdict: string }).verdict, 'FAIL')
      assert.equal(await candidates.latestIdForProposal(userId, proposal.id), null)
      await writeFile(path.join(root, 'persisted-run.json'), JSON.stringify(persisted, null, 2))
    } else result = await evaluator.evaluate(evaluationInput)
    assert.ok(result)
    assert.equal(generationCalls, 4); assert.equal(hiddenCalls, 2)
    assert.ok(visionCalls > 0); assert.equal(settled, generationCalls + visionCalls); assert.equal(reserved, settled)
    assert.equal(result.eligibleForApproval, false)
    const packages = []
    for (const artifact of result.artifacts.filter(row => row.kind === 'content')) {
      const bytes = await store.read(control.identity.runId, artifact)
      if (bytes[0] !== 123) continue
      const data = JSON.parse(bytes.toString())
      if (data.runtimeSnapshot) packages.push(parseEvolutionSkillPackage(data))
    }
    assert.deepEqual(packages.map(bundle => bundle.contentHash), [result.baselineHash, result.candidateHash])
    assert.ok(packages.every(bundle => bundle.runtimeSnapshot.packageHash === snapshot.packageHash))
    const saved = JSON.parse((await store.read(control.identity.runId, result.artifacts.filter(row => row.kind === 'report').at(-1)!)).toString())
    assert.deepEqual(saved.comparisons.map((sample: { sampleId: string }) => sample.sampleId), ['visible', 'hidden'])
    assert.ok(saved.comparisons.every((sample: { sides: { assessment: { checks: { id: string; verdict: string }[] } }[] }) =>
      sample.sides.every(side => side.assessment.checks.some(check => check.id === 'render' && check.verdict === 'FAIL'))))
    await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ root, runId: control.identity.runId, generationCalls, hiddenCalls, visionCalls, verdict: result.evaluation.verdict }))
  } finally { try { await evaluator.terminate(control.identity) } finally { await closeDatabase?.() } }
})
