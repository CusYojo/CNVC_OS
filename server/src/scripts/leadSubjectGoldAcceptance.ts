import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { pool } from '../db/client.js'
import {
  prepareRadarAiCandidate,
  RADAR_SUBJECT_REVIEW_SYSTEM_PROMPT,
  validateRadarAiDecision,
} from '../services/radarAiReviewService.js'
import { runLeadSubjectAgentBatch } from '../services/leadSubjectAgentService.js'
import {
  LEAD_SUBJECT_AGENT_PROFILE_VERSION,
  LEAD_SUBJECT_AGENT_SCHEMA_VERSION,
  LEAD_SUBJECT_AGENT_TOOLSET_VERSION,
} from '../services/leadSubjectAgentService.js'

const GOLD_SHA256 = '8a2c8d78602cf40bd8fa74fc496775f0f8c271c5d10fe74876cfcdbd635998ba'

const expectedSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accepted'),
    subjectType: z.enum(['company', 'project', 'team', 'lab', 'paper']),
    subjectName: z.string().min(1),
    aliases: z.array(z.string().min(1)).optional(),
  }).strict(),
  z.object({ status: z.literal('not_accepted') }).strict(),
])

const goldSchema = z.object({
  version: z.string().min(1),
  description: z.string().min(1),
  thresholds: z.object({
    minOverallAccuracy: z.number().min(0).max(1),
    minPositiveRecall: z.number().min(0).max(1),
    minAcceptedPrecision: z.number().min(0).max(1),
    maxFalseAcceptRate: z.number().min(0).max(1),
    maxAverageCostUsd: z.number().nonnegative(),
    maxAverageDurationMs: z.number().positive(),
    maxTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
  }).strict(),
  cases: z.array(z.object({
    id: z.string().min(1),
    category: z.enum(['company', 'project', 'team', 'lab', 'paper', 'noise', 'ambiguous']),
    candidate: z.record(z.string(), z.unknown()),
    expected: expectedSchema,
  }).strict()).min(1),
}).strict()

const modelReviewSchema = z.object({
  candidateId: z.string().min(1),
  decision: z.enum(['accept', 'reject', 'review']),
  subjectType: z.enum(['company', 'project', 'team', 'lab', 'paper']).nullable(),
  subjectName: z.string(),
  legalName: z.string(),
  evidence: z.string(),
  translatedTitle: z.string(),
  translatedSummary: z.string(),
  confidence: z.coerce.number(),
  rejectReason: z.string(),
}).passthrough()

const modelResponseSchema = z.object({ reviews: z.array(modelReviewSchema) })

function normalized(value: string) {
  return value.normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, '').toLocaleLowerCase()
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 0
}

async function main() {
  const goldPath = path.resolve(process.cwd(), 'server/assets/lead-subject-gold-v1.json')
  const goldText = await readFile(goldPath, 'utf8')
  assert.equal(createHash('sha256').update(goldText).digest('hex'), GOLD_SHA256, 'gold set changed without a versioned gate update')
  const gold = goldSchema.parse(JSON.parse(goldText))
  const requiredCategories = ['company', 'project', 'team', 'lab', 'paper', 'noise', 'ambiguous'] as const
  for (const category of requiredCategories) {
    assert.ok(gold.cases.some((item) => item.category === category), `gold set is missing category: ${category}`)
  }
  assert.equal(new Set(gold.cases.map((item) => item.id)).size, gold.cases.length, 'gold case IDs must be unique')

  const modelArg = process.argv.find((value) => value.startsWith('--model='))?.slice('--model='.length)
  const model = modelArg || process.env.RADAR_AI_REVIEW_MODEL || process.env.LLM_MODEL || 'gpt-5.6-sol'
  const prepared = gold.cases.map((item) => ({ item, prepared: prepareRadarAiCandidate(item.candidate, model) }))
  const decisions = new Map<string, ReturnType<typeof validateRadarAiDecision>>()
  let inputTokens = 0
  let outputTokens = 0
  let costMicrousd = 0
  let durationMs = 0
  let maxTurns = 0
  let toolCalls = 0
  const batchSize = 5
  for (let index = 0; index < prepared.length; index += batchSize) {
    const batch = prepared.slice(index, index + batchSize)
    const execution = await runLeadSubjectAgentBatch({
      systemPrompt: RADAR_SUBJECT_REVIEW_SYSTEM_PROMPT,
      candidates: batch.map(({ prepared: candidate }) => ({
        candidateId: candidate.candidateId,
        promptText: candidate.promptText,
      })),
      model,
    })
    const response = modelResponseSchema.parse(execution.output)
    const byId = new Map(response.reviews.map((review) => [review.candidateId, review]))
    for (const entry of batch) {
      const raw = byId.get(entry.prepared.candidateId)
      assert.ok(raw, `model result is missing gold candidate: ${entry.item.id}`)
      decisions.set(entry.item.id, validateRadarAiDecision(
        raw,
        entry.prepared.sourceText,
        model,
        new Date().toISOString(),
        entry.prepared.isPaper,
      ))
    }
    inputTokens += execution.usage.inputTokens
    outputTokens += execution.usage.outputTokens
    costMicrousd += execution.costMicrousd
    durationMs += execution.durationMs
    maxTurns = Math.max(maxTurns, execution.numTurns)
    toolCalls += execution.toolCalls
  }

  let correct = 0
  let positiveCount = 0
  let correctPositive = 0
  let negativeCount = 0
  let falseAccepts = 0
  let falseRejects = 0
  let positiveReviews = 0
  let acceptedPredictions = 0
  let correctAcceptedPredictions = 0
  const results = gold.cases.map((item) => {
    const resolved = decisions.get(item.id)!
    const actual = resolved.decision
    if (resolved.status === 'accepted') acceptedPredictions += 1
    let passed = false
    if (item.expected.status === 'accepted') {
      positiveCount += 1
      const allowedNames = [item.expected.subjectName, ...(item.expected.aliases ?? [])].map(normalized)
      passed = resolved.status === 'accepted'
        && actual.subjectType === item.expected.subjectType
        && allowedNames.includes(normalized(actual.subjectName))
      if (passed) {
        correctPositive += 1
        correctAcceptedPredictions += 1
      }
      if (resolved.status === 'rejected') falseRejects += 1
      if (resolved.status === 'review') positiveReviews += 1
    } else {
      negativeCount += 1
      passed = resolved.status !== 'accepted'
      if (!passed) falseAccepts += 1
    }
    if (passed) correct += 1
    return {
      id: item.id,
      category: item.category,
      passed,
      expected: item.expected,
      actual: {
        status: resolved.status,
        decision: actual.decision,
        subjectType: actual.subjectType,
        subjectName: actual.subjectName,
        confidence: actual.confidence,
        rejectReason: actual.rejectReason,
      },
    }
  })

  const metrics = {
    cases: gold.cases.length,
    overallAccuracy: ratio(correct, gold.cases.length),
    positiveRecall: ratio(correctPositive, positiveCount),
    acceptedPrecision: ratio(correctAcceptedPredictions, acceptedPredictions),
    falseAcceptRate: ratio(falseAccepts, negativeCount),
    falseRejectRate: ratio(falseRejects, positiveCount),
    positiveReviewRate: ratio(positiveReviews, positiveCount),
    averageInputTokens: ratio(inputTokens, gold.cases.length),
    averageOutputTokens: ratio(outputTokens, gold.cases.length),
    averageCostUsd: ratio(costMicrousd, gold.cases.length) / 1_000_000,
    averageDurationMs: ratio(durationMs, gold.cases.length),
    maxTurns,
    toolCalls,
  }
  const thresholdChecks = {
    overallAccuracy: metrics.overallAccuracy >= gold.thresholds.minOverallAccuracy,
    positiveRecall: metrics.positiveRecall >= gold.thresholds.minPositiveRecall,
    acceptedPrecision: metrics.acceptedPrecision >= gold.thresholds.minAcceptedPrecision,
    falseAcceptRate: metrics.falseAcceptRate <= gold.thresholds.maxFalseAcceptRate,
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
      profileVersion: LEAD_SUBJECT_AGENT_PROFILE_VERSION,
      schemaVersion: LEAD_SUBJECT_AGENT_SCHEMA_VERSION,
      toolsetVersion: LEAD_SUBJECT_AGENT_TOOLSET_VERSION,
    },
    thresholds: gold.thresholds,
    thresholdChecks,
    metrics,
    usageComplete: inputTokens > 0 && outputTokens > 0,
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
