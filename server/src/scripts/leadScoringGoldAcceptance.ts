import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { pool } from '../db/client.js'
import { scoreWithAgentDetailed } from '../services/inProcessAiWorkflowService.js'
import {
  LEAD_SCORING_AGENT_PROFILE_VERSION,
  LEAD_SCORING_AGENT_SCHEMA_VERSION,
  LEAD_SCORING_AGENT_TOOLSET_VERSION,
} from '../services/leadScoringAgentService.js'

const GOLD_SHA256 = '0f6e3d8ab5665fdbafd250c5286c5e38757d2b9c5ffa9fd3428707c31bfd1103'

const goldSchema = z.object({
  version: z.string().min(1),
  description: z.string().min(1),
  thresholds: z.object({
    minRangeAccuracy: z.number().min(0).max(1),
    minOrderingAccuracy: z.number().min(0).max(1),
    maxMeanAbsoluteMidpointDeviation: z.number().nonnegative(),
    maxAverageCostUsd: z.number().nonnegative(),
    maxAverageDurationMs: z.number().positive(),
    maxTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
    minPairSeparation: z.number().nonnegative(),
  }).strict(),
  cases: z.array(z.object({
    id: z.string().min(1),
    workflow: z.enum(['score-project', 'score-paper']),
    pair: z.string().min(1),
    quality: z.enum(['high', 'low']),
    expected: z.object({ minTotal: z.number().min(0).max(100), maxTotal: z.number().min(0).max(100) }).strict(),
    input: z.record(z.string(), z.unknown()),
  }).strict()).min(2),
}).strict()

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 0
}

async function main() {
  const goldPath = path.resolve(process.cwd(), 'server/assets/lead-scoring-gold-v1.json')
  const goldText = await readFile(goldPath, 'utf8')
  assert.equal(createHash('sha256').update(goldText).digest('hex'), GOLD_SHA256, 'scoring gold set changed without a versioned gate update')
  const gold = goldSchema.parse(JSON.parse(goldText))
  assert.equal(new Set(gold.cases.map((item) => item.id)).size, gold.cases.length, 'scoring gold case IDs must be unique')
  for (const workflow of ['score-project', 'score-paper'] as const) {
    const cases = gold.cases.filter((item) => item.workflow === workflow)
    assert.ok(cases.some((item) => item.quality === 'high'), `${workflow} gold set is missing a high-quality case`)
    assert.ok(cases.some((item) => item.quality === 'low'), `${workflow} gold set is missing a low-quality case`)
  }

  const modelArg = process.argv.find((value) => value.startsWith('--model='))?.slice('--model='.length)
  const model = modelArg || process.env.SCORE_MODEL || process.env.LLM_MODEL || 'gpt-5.6-sol'
  let inputTokens = 0
  let outputTokens = 0
  let costMicrousd = 0
  let durationMs = 0
  let maxTurns = 0
  let toolCalls = 0
  const results: Array<{
    id: string
    workflow: 'score-project' | 'score-paper'
    pair: string
    quality: 'high' | 'low'
    expected: { minTotal: number; maxTotal: number }
    actualTotal: number
    verdict: string
    dimensionCount: number
    dimensions: Array<{ key: string; score: number; max: number }>
    rangePassed: boolean
  }> = []

  for (const [index, item] of gold.cases.entries()) {
    console.error(`[lead-scoring-gold] running ${index + 1}/${gold.cases.length}: ${item.id}`)
    const scored = await scoreWithAgentDetailed(item.workflow, item.input, {
      primaryModel: model,
      fallbackModel: model,
    })
    const rangePassed = scored.result.total >= item.expected.minTotal && scored.result.total <= item.expected.maxTotal
    const expectedDimensionCount = item.workflow === 'score-project' ? 7 : 5
    assert.equal(scored.result.dimensions.length, expectedDimensionCount, `${item.id} routed to an invalid dimension contract`)
    results.push({
      id: item.id,
      workflow: item.workflow,
      pair: item.pair,
      quality: item.quality,
      expected: item.expected,
      actualTotal: scored.result.total,
      verdict: scored.result.verdict,
      dimensionCount: scored.result.dimensions.length,
      dimensions: scored.result.dimensions.map((dimension) => ({ key: dimension.key, score: dimension.score, max: dimension.max })),
      rangePassed,
    })
    inputTokens += scored.execution.usage.inputTokens
    outputTokens += scored.execution.usage.outputTokens
    costMicrousd += scored.execution.costMicrousd
    durationMs += scored.execution.durationMs
    maxTurns = Math.max(maxTurns, scored.execution.numTurns)
    toolCalls += scored.execution.toolCalls
    console.error(`[lead-scoring-gold] completed ${item.id}: total=${scored.result.total}, durationMs=${scored.execution.durationMs}`)
  }

  const pairs = [...new Set(results.map((item) => item.pair))].map((pair) => {
    const high = results.find((item) => item.pair === pair && item.quality === 'high')
    const low = results.find((item) => item.pair === pair && item.quality === 'low')
    assert.ok(high && low, `scoring gold pair must contain high and low cases: ${pair}`)
    const separation = high.actualTotal - low.actualTotal
    return { pair, high: high.actualTotal, low: low.actualTotal, separation, passed: separation >= gold.thresholds.minPairSeparation }
  })
  const midpointDeviation = results.reduce((sum, item) => {
    const midpoint = (item.expected.minTotal + item.expected.maxTotal) / 2
    return sum + Math.abs(item.actualTotal - midpoint)
  }, 0)
  const metrics = {
    cases: results.length,
    rangeAccuracy: ratio(results.filter((item) => item.rangePassed).length, results.length),
    orderingAccuracy: ratio(pairs.filter((item) => item.passed).length, pairs.length),
    meanAbsoluteMidpointDeviation: ratio(midpointDeviation, results.length),
    averageInputTokens: ratio(inputTokens, results.length),
    averageOutputTokens: ratio(outputTokens, results.length),
    averageCostUsd: ratio(costMicrousd, results.length) / 1_000_000,
    averageDurationMs: ratio(durationMs, results.length),
    maxTurns,
    toolCalls,
  }
  const thresholdChecks = {
    rangeAccuracy: metrics.rangeAccuracy >= gold.thresholds.minRangeAccuracy,
    orderingAccuracy: metrics.orderingAccuracy >= gold.thresholds.minOrderingAccuracy,
    midpointDeviation: metrics.meanAbsoluteMidpointDeviation <= gold.thresholds.maxMeanAbsoluteMidpointDeviation,
    averageCostUsd: metrics.averageCostUsd <= gold.thresholds.maxAverageCostUsd,
    averageDurationMs: metrics.averageDurationMs <= gold.thresholds.maxAverageDurationMs,
    maxTurns: metrics.maxTurns <= gold.thresholds.maxTurns,
    toolCalls: metrics.toolCalls <= gold.thresholds.maxToolCalls,
  }
  const ok = Object.values(thresholdChecks).every(Boolean)
  console.log(JSON.stringify({
    ok,
    goldVersion: gold.version,
    goldSha256: GOLD_SHA256,
    model,
    contracts: {
      profileVersion: LEAD_SCORING_AGENT_PROFILE_VERSION,
      schemaVersion: LEAD_SCORING_AGENT_SCHEMA_VERSION,
      toolsetVersion: LEAD_SCORING_AGENT_TOOLSET_VERSION,
      projectStandardVersion: '1.0',
      paperStandardVersion: 'paper-v1',
    },
    thresholds: gold.thresholds,
    thresholdChecks,
    metrics,
    usageComplete: inputTokens > 0 && outputTokens > 0,
    pairs,
    results,
  }, null, 2))
  if (!ok) process.exitCode = 2
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await pool.end()
})
