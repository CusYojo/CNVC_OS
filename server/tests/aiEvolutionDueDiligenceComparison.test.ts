import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { compareEvolutionDueDiligence } from '../src/runtime/evolution/evolutionDueDiligenceComparison.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'
import { EVOLUTION_REQUIRED_CHECKS } from '../src/contracts/aiEvolutionEvaluationContract.js'
import { previewEvolutionSkillComparison } from '../src/services/aiEvolutionSkillComparisonPreview.js'

test('comparison retains report files and prevents an optimistic reviewer from overriding a failed native render', async () => {
  let renderFails = false
  const stored: Buffer[] = []
  const sample = { project: { name: 'test' }, content: { title: 'report', executiveSummary: '', sections: [], highlights: [], risks: [], missing: [] },
    evidence: { project: { name: 'test', legal_entity: 'test', cutoff_date: '2026-09-07', currency: 'CNY' }, facts: [] },
    sourceCutoffDate: '2026-09-07', diligenceScope: {}, sectionTitles: [] }
  const baseline = { capabilityId: 'skill', instructions: 'baseline', references: [], dependencies: [], toolPermissionHash: 'a'.repeat(64) }
  const config: Parameters<typeof compareEvolutionDueDiligence>[0] = {
    baseline, candidate: { ...baseline, instructions: 'candidate' }, samples: [{ id: 'sample', input: sample, materialHashes: [] }],
    control: { signal: new AbortController().signal, identity: { runId: 'run', attempt: 1, leaseToken: 1, inputHash: 'b'.repeat(64) }, assertCanContinue: async () => {} },
    store: { put: async (_run, bytes, kind) => { stored.push(Buffer.from(bytes)); const sha256 = createHash('sha256').update(bytes).digest('hex');
      return { storageKey: `${sha256}.bin`, sha256, bytes: bytes.length, kind } } },
    metric: { name: 'host-defined coverage', direction: 'higher', minimumImprovement: 1 }, suiteVersion: 'fixture-v1', modelId: 'model', modelVersion: 'fixed', maxOutputTokens: 1000,
    budget: { reserveModelTokens: async () => {}, recordModelUsage: async () => {} },
    generator: { profileHash: 'c'.repeat(64), generate: async ({ skill, sample }) => ({ contentType: 'application/json',
      content: Buffer.from(JSON.stringify({ schemaVersion: 1, sampleHash: evolutionContentHash(sample), skillHash: evolutionContentHash(skill),
        profileHash: 'c'.repeat(64), blockedReasons: [], rawPackage: { instruction: skill.instructions }, normalizedPackage: { reportMode: 'screening_public', report: {}, diligenceData: {} } })) }) },
    renderer: { rendererHash: 'd'.repeat(64), render: async () => ({ rendererHash: 'd'.repeat(64),
      checks: ['runtime', 'fields', 'content', 'narrative', 'build', 'format', 'pdf', 'pages'].map(id => ({ id, passed: !(renderFails && id === 'format'), exitCode: renderFails && id === 'format' ? 1 : 0, executionError: null })),
      files: ['report.docx', 'report.pdf', 'page-001.png'].map(name => { const content = Buffer.from(`fixture-${name}`); return {
        path: `render/${name}`, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), content } }),
    }) },
    assess: async ({ generated }) => ({ score: generated.rawPackage.instruction === 'candidate' ? 2 : 1,
      checks: EVOLUTION_REQUIRED_CHECKS.skill.map(id => ({ id, verdict: 'PASS', evidence: 'independent fixture review' })) }),
  }
  const first = await compareEvolutionDueDiligence(config)
  assert.equal(first.eligibleForApproval, true)
  assert.equal(first.artifacts.filter(row => row.kind === 'screenshot').length, 1)
  const report = JSON.parse(stored.at(-1)!.toString())
  assert.equal(report.comparisons[0].sides[0].supportingArtifacts.length, 4)
  const preview = await previewEvolutionSkillComparison({ runId: 'run', baseRef: first.baselineHash,
    manifest: { schemaVersion: 1, sourceHash: first.candidateHash, patchHash: 'a'.repeat(64), dependencyLockHash: 'b'.repeat(64), environment: 'test', artifacts: first.artifacts },
    evaluation: { hash: evolutionContentHash(first.evaluation), report: first.evaluation } },
  { read: async (_run, ref) => { const bytes = stored.find(content => createHash('sha256').update(content).digest('hex') === ref.sha256); assert.ok(bytes); return bytes } })
  assert.deepEqual(preview.samples[0].sides[0].downloads.map(row => row.label), ['生成输出', '原始与归一化数据包', 'report.docx', 'report.pdf', 'page-001.png'])
  assert.equal(preview.samples[0].sides[0].downloads[4].index, preview.samples[0].sides[1].downloads[4].index)
  renderFails = true
  const second = await compareEvolutionDueDiligence(config)
  assert.equal(second.eligibleForApproval, false)
  assert.equal(second.evaluation.checks.find(row => row.id === 'render')?.verdict, 'FAIL')
})
