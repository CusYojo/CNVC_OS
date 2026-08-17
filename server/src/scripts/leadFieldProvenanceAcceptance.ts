import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { assertSchemaReady } from '../db/migrate.js'
import { knowledgeChunks, leads } from '../db/schema.js'
import {
  applyLeadFieldPolicy,
  initialLeadFieldProvenance,
  leadFieldProvenanceMap,
  leadFieldPriority,
} from '../services/leadFieldProvenance.js'
import { mergeRadarFundingRounds, mergeRadarSources, mergeUniqueValues } from '../services/leadRadarMerge.js'
import { saveLeadScoring } from '../services/aiSummaryService.js'

const checks: string[] = []
const fixtureId = randomUUID()
const manualValues = {
  name: '字段来源验收项目',
  companyName: '字段来源验收有限公司',
  industry: '人工行业',
  source: '人工录入',
  summary: '人工摘要不得被模型覆盖',
  team: '人工团队不得被模型覆盖',
  businessRegion: '华北',
  businessRegionSource: '人工核验',
  businessRegionConfidence: '高',
  fundingRounds: [{ round: 'A轮', amount: '人工金额' }],
  highlights: ['人工亮点'],
  risks: ['人工风险'],
  sources: [{ title: '人工来源', url: 'https://example.invalid/manual' }],
}
const manualProvenance = initialLeadFieldProvenance(manualValues, 'manual')

assert.equal(leadFieldPriority(manualProvenance, 'team'), 100)
assert.equal(leadFieldPriority(manualProvenance, 'summary'), 100)
checks.push('manual-create-records-highest-priority-field-provenance')

const pureExisting: Record<string, unknown> = { ...manualValues, fieldProvenance: manualProvenance }
const purePatch = applyLeadFieldPolicy(pureExisting, {
  team: 'AI 团队',
  summary: 'AI 摘要',
  businessRegion: '华东',
  businessRegionSource: '模型注册地址',
  businessRegionConfidence: '中',
  fundingRounds: mergeRadarFundingRounds(manualValues.fundingRounds, [{ round: 'B轮', amount: 'AI金额' }]),
  highlights: mergeUniqueValues(manualValues.highlights, ['AI亮点']),
  sources: mergeRadarSources(manualValues.sources, [{ title: 'AI来源', url: 'https://example.invalid/ai' }]),
  scoring: { total: 88 },
  score: 88,
}, 'ai_scoring', {
  additiveFields: ['fundingRounds', 'highlights', 'sources'],
  alwaysReplaceFields: ['scoring', 'score'],
  linkedFields: [['businessRegion', 'businessRegionSource', 'businessRegionConfidence']],
  operation: 'machine_refresh',
})
assert.equal(purePatch.team, undefined)
assert.equal(purePatch.summary, undefined)
assert.equal(purePatch.businessRegion, undefined)
assert.equal(purePatch.businessRegionSource, undefined)
assert.equal(purePatch.businessRegionConfidence, undefined)
assert.deepEqual(purePatch.fundingRounds, [manualValues.fundingRounds[0], { round: 'B轮', amount: 'AI金额' }])
assert.deepEqual(purePatch.highlights, ['人工亮点', 'AI亮点'])
assert.equal(purePatch.score, 88)
assert.equal(purePatch.fieldProvenance?.score?.sourceType, 'ai_scoring')
assert.equal(purePatch.fieldProvenance?.score?.priority, 40)
checks.push('ai-refresh-cannot-overwrite-manual-scalars-and-can-only-append-arrays')

const migratedMachinePatch = applyLeadFieldPolicy({
  scoring: { total: 10 },
  fieldProvenance: {
    '*': {
      sourceType: 'legacy_import', priority: 90, origins: ['legacy_import'], operation: 'preserve_existing',
    },
  },
}, { scoring: { total: 88 } }, 'ai_scoring', {
  alwaysReplaceFields: ['scoring'],
  operation: 'machine_refresh',
})
assert.equal(migratedMachinePatch.fieldProvenance?.scoring?.sourceType, 'ai_scoring')
assert.equal(migratedMachinePatch.fieldProvenance?.scoring?.priority, 40)
checks.push('machine-owned-refresh-replaces-legacy-wildcard-ownership')

const publicPatch = applyLeadFieldPolicy({
  businessRegion: '华南',
  fieldProvenance: initialLeadFieldProvenance({ businessRegion: '华南' }, 'radar'),
}, { businessRegion: '华东' }, 'public_intel', { operation: 'machine_refresh' })
assert.equal(publicPatch.businessRegion, '华东')
checks.push('higher-priority-evidence-can-refresh-lower-priority-machine-field')

try {
  await assertSchemaReady()
  const [coverage] = await db.select({
    total: sql<number>`COUNT(*)`,
    missing: sql<number>`SUM(CASE WHEN JSON_EXTRACT(${leads.fieldProvenance}, '$.\"*\".priority') IS NULL THEN 1 ELSE 0 END)`,
  }).from(leads)
  assert.equal(Number(coverage?.missing || 0), 0)
  checks.push('all-migrated-leads-have-default-field-priority-metadata')

  await db.insert(leads).values({
    id: fixtureId,
    ...manualValues,
    fieldProvenance: manualProvenance,
  })
  const updated = await saveLeadScoring(fixtureId, {
    total: 88,
    whatIsIt: '模型新摘要',
    structuredTeam: [{ name: '模型团队', title: '创始人' }],
    fundingRoundsResearched: [{ round: 'B轮', amount: '模型金额' }],
    highlights: ['模型亮点'],
    risks: ['模型风险'],
    researchSources: [{ title: '模型来源', url: 'https://example.invalid/scoring' }],
    registry: { registeredAddress: '上海市浦东新区' },
  }, 88, { ingest: false })
  assert(updated)
  assert.equal(updated.team, manualValues.team)
  assert.equal(updated.summary, manualValues.summary)
  assert.equal(updated.businessRegion, manualValues.businessRegion)
  assert.deepEqual(updated.fundingRounds, [...manualValues.fundingRounds, { round: 'B轮', amount: '模型金额' }])
  assert.deepEqual(updated.highlights, [...manualValues.highlights, '模型亮点'])
  assert.deepEqual(updated.risks, [...manualValues.risks, '模型风险'])
  assert.equal(updated.score, 88)
  const updatedProvenance = leadFieldProvenanceMap(updated.fieldProvenance)
  assert.equal(updatedProvenance.team?.priority, 100)
  assert.equal(updatedProvenance.score?.sourceType, 'ai_scoring')
  assert.equal(updatedProvenance.score?.priority, 40)
  assert.deepEqual(updatedProvenance.highlights?.origins, ['manual', 'ai_scoring'])
  checks.push('real-mysql-rescoring-preserves-manual-scalars-and-appends-evidenced-arrays')
} finally {
  await db.delete(knowledgeChunks).where(and(eq(knowledgeChunks.scope, 'lead'), eq(knowledgeChunks.refId, fixtureId))).catch(() => undefined)
  await db.delete(leads).where(eq(leads.id, fixtureId)).catch(() => undefined)
}

const [residue] = await db.select({ count: sql<number>`COUNT(*)` }).from(leads).where(eq(leads.id, fixtureId))
assert.equal(Number(residue?.count || 0), 0)
checks.push('acceptance-fixture-residue-zero')
console.log(JSON.stringify({ ok: true, checks, migratedLeadCount: Number((await db.select({ count: sql<number>`COUNT(*)` }).from(leads))[0]?.count || 0), fixtureResidue: 0 }))
await pool.end()
