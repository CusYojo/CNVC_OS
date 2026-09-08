import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { parseEvolutionDueDiligenceSample } from '../src/runtime/evolution/evolutionDueDiligenceSample.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'

test('report samples retain full input and reject mixed identity, duplicate facts and nonexistent source references', async () => {
  const evidence = JSON.parse(await readFile('server/tests/fixtures/evolution-due-diligence/evidence.json', 'utf8'))
  const sample = { project: { name: evidence.project.name, companyName: evidence.project.legal_entity }, evidence,
    sourceCutoffDate: evidence.project.cutoff_date, diligenceScope: {}, sectionTitles: ['公司与股权'],
    content: { title: '测试报告', executiveSummary: '测试科技已公开披露公司信息。', executiveSummarySourceIndexes: [0],
      sections: [], highlights: [], risks: [], missing: [] } }
  assert.equal(evolutionContentHash(parseEvolutionDueDiligenceSample(sample)), evolutionContentHash(sample))
  assert.throws(() => parseEvolutionDueDiligenceSample({ ...sample, project: { ...sample.project, name: 'other project' } }), { code: 'EVOLUTION_SAMPLE_SUITE_INVALID' })
  assert.throws(() => parseEvolutionDueDiligenceSample({ ...sample, sourceCutoffDate: 'changed' }), { code: 'EVOLUTION_SAMPLE_SUITE_INVALID' })
  assert.throws(() => parseEvolutionDueDiligenceSample({ ...sample, evidence: { ...evidence, facts: [...evidence.facts, ...evidence.facts] } }), { code: 'EVOLUTION_SAMPLE_SUITE_INVALID' })
  assert.throws(() => parseEvolutionDueDiligenceSample({ ...sample, content: { ...sample.content, executiveSummarySourceIndexes: [99] } }), { code: 'EVOLUTION_SAMPLE_SUITE_INVALID' })
  assert.throws(() => parseEvolutionDueDiligenceSample({ ...sample, content: { ...sample.content, executiveSummary: 'a'.repeat(90000) } }), { code: 'EVOLUTION_SAMPLE_SUITE_INVALID' })
  assert.throws(() => parseEvolutionDueDiligenceSample({ ...sample, unexpected: 'silently strip this' }))
})
