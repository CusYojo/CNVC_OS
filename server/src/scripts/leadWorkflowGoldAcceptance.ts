import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { pool } from '../db/client.js'
import {
  leadWorkflowAgentContract,
  runLeadWorkflowAgent,
  type LeadWorkflowAgentProfile,
} from '../services/leadWorkflowAgentService.js'

const GOLD_SHA256 = '18048cae785e0722e2553982358f8cc4b287906e05fa577528fb3ed5cdbdca2a'

const goldSchema = z.object({
  version: z.string().min(1),
  description: z.string().min(1),
  thresholds: z.object({
    minContractAccuracy: z.number().min(0).max(1),
    minEvidenceBindingAccuracy: z.number().min(0).max(1),
    maxAverageCostUsd: z.number().nonnegative(),
    maxAverageDurationMs: z.number().positive(),
    maxTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
    maxAttemptsPerCase: z.number().int().min(1).max(2),
    maxRetryRate: z.number().min(0).max(1),
  }).strict(),
  cases: z.array(z.object({
    id: z.string().min(1),
    profile: z.enum(['lead-research-agent', 'lead-screening-agent', 'lead-enrichment-agent']),
    category: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    expected: z.record(z.string(), z.unknown()),
  }).strict()).min(6),
}).strict()

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 0
}

function objectArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

function text(value: unknown) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function numberExpectation(expected: Record<string, unknown>, key: string, fallback: number) {
  const value = Number(expected[key])
  return Number.isFinite(value) ? value : fallback
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

function expectedPatchArray(value: unknown) {
  return objectArray(value).map((item) => ({
    field: text(item.field),
    operation: text(item.operation),
    sourceId: text(item.sourceId),
  }))
}

function contractChecks(
  profile: LeadWorkflowAgentProfile,
  output: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  const checks: Record<string, boolean> = {}
  if (profile === 'lead-research-agent') {
    const facts = objectArray(output.facts)
    const conflicts = objectArray(output.conflicts)
    const gaps = Array.isArray(output.gaps) ? output.gaps : []
    checks.minFacts = facts.length >= numberExpectation(expected, 'minFacts', 0)
    checks.maxConflicts = conflicts.length <= numberExpectation(expected, 'maxConflicts', Number.POSITIVE_INFINITY)
    checks.minConflicts = conflicts.length >= numberExpectation(expected, 'minConflicts', 0)
    checks.minGaps = gaps.length >= numberExpectation(expected, 'minGaps', 0)
    const evidenceIds = new Set(facts.map((item) => text(item.sourceId)))
    checks.requiredEvidenceSourceIds = stringArray(expected.requiredEvidenceSourceIds).every((id) => evidenceIds.has(id))
    const requiredConflictSourceIds = stringArray(expected.requiredConflictSourceIds)
    checks.requiredConflictSourceIds = !requiredConflictSourceIds.length || conflicts.some((conflict) => {
      const ids = new Set(stringArray(conflict.sourceIds))
      return requiredConflictSourceIds.every((id) => ids.has(id))
    })
  } else if (profile === 'lead-screening-agent') {
    const evidence = objectArray(output.evidence)
    checks.decision = text(output.decision) === text(expected.decision)
    checks.minEvidence = evidence.length >= numberExpectation(expected, 'minEvidence', 0)
    checks.maxEvidence = evidence.length <= numberExpectation(expected, 'maxEvidence', Number.POSITIVE_INFINITY)
    const evidenceIds = new Set(evidence.map((item) => text(item.sourceId)))
    checks.requiredEvidenceSourceIds = stringArray(expected.requiredEvidenceSourceIds).every((id) => evidenceIds.has(id))
  } else {
    const patches = objectArray(output.patches)
    const conflicts = objectArray(output.conflicts)
    checks.maxPatches = patches.length <= numberExpectation(expected, 'maxPatches', Number.POSITIVE_INFINITY)
    const forbiddenPatchFields = new Set(stringArray(expected.forbiddenPatchFields))
    checks.forbiddenPatchFields = patches.every((patch) => !forbiddenPatchFields.has(text(patch.field)))
    checks.minConflicts = conflicts.length >= numberExpectation(expected, 'minConflicts', 0)
    checks.maxConflicts = conflicts.length <= numberExpectation(expected, 'maxConflicts', Number.POSITIVE_INFINITY)
    checks.requiredPatches = expectedPatchArray(expected.requiredPatches).every((required) => patches.some((patch) => (
      text(patch.field) === required.field
      && text(patch.operation) === required.operation
      && text(patch.sourceId) === required.sourceId
    )))
    const conflictFields = new Set(conflicts.map((item) => text(item.field)))
    checks.requiredConflictFields = stringArray(expected.requiredConflictFields).every((field) => conflictFields.has(field))
    const conflictSourceIds = new Set(conflicts.flatMap((item) => stringArray(item.sourceIds)))
    checks.requiredConflictSourceIds = stringArray(expected.requiredConflictSourceIds).every((id) => conflictSourceIds.has(id))
  }
  return checks
}

function evidenceBindingPassed(profile: LeadWorkflowAgentProfile, output: Record<string, unknown>, input: Record<string, unknown>) {
  const sources = new Map(objectArray(input.sources).map((source) => [
    text(source.sourceId),
    text(source.quote || source.snippet || source.excerpt),
  ]))
  const rows = profile === 'lead-research-agent'
    ? objectArray(output.facts)
    : profile === 'lead-screening-agent'
      ? objectArray(output.evidence)
      : objectArray(output.patches)
  return rows.every((row) => {
    const source = sources.get(text(row.sourceId))
    const quote = text(row.quote)
    return Boolean(source && quote && source.includes(quote))
  })
}

async function main() {
  const goldPath = path.resolve(process.cwd(), 'server/assets/lead-workflow-gold-v1.json')
  const goldText = await readFile(goldPath, 'utf8')
  assert.equal(
    createHash('sha256').update(goldText).digest('hex'),
    GOLD_SHA256,
    'workflow gold set changed without a versioned gate update',
  )
  const gold = goldSchema.parse(JSON.parse(goldText))
  assert.equal(new Set(gold.cases.map((item) => item.id)).size, gold.cases.length, 'workflow gold case IDs must be unique')
  for (const profile of ['lead-research-agent', 'lead-screening-agent', 'lead-enrichment-agent'] as const) {
    assert.ok(gold.cases.filter((item) => item.profile === profile).length >= 2, `${profile} requires positive and negative gold coverage`)
  }

  const modelArg = process.argv.find((value) => value.startsWith('--model='))?.slice('--model='.length)
  const model = modelArg || process.env.LLM_MODEL || 'gpt-5.6-sol'
  let inputTokens = 0
  let outputTokens = 0
  let costMicrousd = 0
  let durationMs = 0
  let maxTurns = 0
  let toolCalls = 0
  let retriedCases = 0
  const results: Array<Record<string, unknown>> = []

  for (const [index, item] of gold.cases.entries()) {
    console.error(`[lead-workflow-gold] running ${index + 1}/${gold.cases.length}: ${item.id}`)
    const prompt = `以下 JSON 是宿主受控工具生成的唯一输入。不得使用外部知识，不得调用任何工具。\n${JSON.stringify(item.input)}`
    const caseStartedAt = Date.now()
    let execution: Awaited<ReturnType<typeof runLeadWorkflowAgent>> | null = null
    let attempts = 0
    while (!execution && attempts < gold.thresholds.maxAttemptsPerCase) {
      attempts += 1
      try {
        execution = await runLeadWorkflowAgent({ profile: item.profile, prompt, model })
      } catch (error) {
        const retryable = (error as Error & { retryable?: boolean }).retryable === true
        if (!retryable || attempts >= gold.thresholds.maxAttemptsPerCase) throw error
        console.error(`[lead-workflow-gold] retrying ${item.id} after retryable attempt ${attempts}`)
      }
    }
    assert.ok(execution, `${item.id} completed without an execution result`)
    if (attempts > 1) retriedCases += 1
    const wallDurationMs = Date.now() - caseStartedAt
    const output = execution.output as Record<string, unknown>
    const checks = contractChecks(item.profile, output, item.expected)
    const contractPassed = Object.values(checks).every(Boolean)
    const bindingPassed = evidenceBindingPassed(item.profile, output, item.input)
    results.push({
      id: item.id,
      profile: item.profile,
      category: item.category,
      contractPassed,
      bindingPassed,
      checks,
      output,
      durationMs: execution.durationMs,
      costUsd: execution.costMicrousd / 1_000_000,
      turns: execution.numTurns,
      toolCalls: execution.toolCalls,
      attempts,
      wallDurationMs,
    })
    inputTokens += execution.usage.inputTokens
    outputTokens += execution.usage.outputTokens
    costMicrousd += execution.costMicrousd
    durationMs += wallDurationMs
    maxTurns = Math.max(maxTurns, execution.numTurns)
    toolCalls += execution.toolCalls
    console.error(`[lead-workflow-gold] completed ${item.id}: contract=${contractPassed}, binding=${bindingPassed}, durationMs=${execution.durationMs}`)
  }

  const metrics = {
    cases: results.length,
    contractAccuracy: ratio(results.filter((item) => item.contractPassed).length, results.length),
    evidenceBindingAccuracy: ratio(results.filter((item) => item.bindingPassed).length, results.length),
    averageInputTokens: ratio(inputTokens, results.length),
    averageOutputTokens: ratio(outputTokens, results.length),
    averageCostUsd: ratio(costMicrousd, results.length) / 1_000_000,
    averageDurationMs: ratio(durationMs, results.length),
    maxTurns,
    toolCalls,
    retriedCases,
    retryRate: ratio(retriedCases, results.length),
  }
  const thresholdChecks = {
    contractAccuracy: metrics.contractAccuracy >= gold.thresholds.minContractAccuracy,
    evidenceBindingAccuracy: metrics.evidenceBindingAccuracy >= gold.thresholds.minEvidenceBindingAccuracy,
    averageCostUsd: metrics.averageCostUsd <= gold.thresholds.maxAverageCostUsd,
    averageDurationMs: metrics.averageDurationMs <= gold.thresholds.maxAverageDurationMs,
    maxTurns: metrics.maxTurns <= gold.thresholds.maxTurns,
    toolCalls: metrics.toolCalls <= gold.thresholds.maxToolCalls,
    retryRate: metrics.retryRate <= gold.thresholds.maxRetryRate,
  }
  const ok = Object.values(thresholdChecks).every(Boolean)
  console.log(JSON.stringify({
    ok,
    goldVersion: gold.version,
    goldSha256: GOLD_SHA256,
    model,
    contracts: Object.fromEntries(
      (['lead-research-agent', 'lead-screening-agent', 'lead-enrichment-agent'] as const).map((profile) => {
        const contract = leadWorkflowAgentContract(profile)
        return [profile, {
          profileVersion: contract.profileVersion,
          promptVersion: contract.promptVersion,
          schemaVersion: contract.schemaVersion,
          skillVersion: contract.skillVersion,
          toolsetVersion: contract.toolsetVersion,
        }]
      }),
    ),
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
