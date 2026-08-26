import assert from 'node:assert/strict'
import {
  computeLeadRatingV3,
  leadRatingGradeForScore,
  leadRatingStatusFor,
  LEAD_RATING_DIMENSIONS,
  LEAD_RATING_V3_WORKFLOW,
  validateSnapshotBoundLeadRatingApplicability,
  validateSnapshotBoundLeadRatingEvidence,
} from '../services/leadRatingV3Service.js'
import { scoreWithAgentDetailed, type LeadScoringAgentRunner } from '../services/inProcessAiWorkflowService.js'

function modelOutput(input: {
  score?: number
  nullKeys?: string[]
  evidenceLevel?: 'E1' | 'E2' | 'E3'
  redFlags?: string[]
  conflicts?: string[]
} = {}) {
  const score = input.score ?? 8.5
  const nullKeys = new Set(input.nullKeys ?? [])
  const evidenceLevel = input.evidenceLevel ?? 'E1'
  return {
    project: { name: '验收项目', industry: '先进制造', stage: 'A轮' },
    rating: { one_sentence_judgment: '基于现有证据形成的阶段性判断。', core_tags: ['工程化'], recommended_action: '有条件推进' },
    evidence_summary: {
      confirmed_facts: ['已有可验证产品资料'], unverified_company_claims: [],
      conflicting_information: input.conflicts ?? [], critical_missing_information: [],
    },
    dimension_scores: LEAD_RATING_DIMENSIONS.map((dimension) => ({
      key: dimension.key,
      dimension: dimension.dimension,
      score: nullKeys.has(dimension.key) ? null : score,
      assessment: nullKeys.has(dimension.key) ? '现有资料不足以评估。' : '现有证据支持该维度判断。',
      key_evidence: nullKeys.has(dimension.key) ? [] : [{ content: '验收用不可变输入证据', evidence_level: evidenceLevel }],
      risks_or_gaps: nullKeys.has(dimension.key) ? ['需要补充资料'] : [],
    })),
    investment_thesis: [], key_risks: [], failure_scenario: [],
    investment_red_flags: input.redFlags ?? [],
    transaction_value: {
      valuation_information_available: false, terms_information_available: false,
      assessment: '当前评级未纳入融资估值与交易条款影响，不能据此直接判断本轮交易价格是否具备吸引力。',
    },
    due_diligence: { P0: [], P1: [], P2: [] },
    rating_system_improvements: [],
  }
}

for (const [score, grade] of [
  [90, 'A+'], [89.9, 'A'], [85, 'A'], [84.9, 'A-'], [80, 'A-'],
  [79.9, 'B+'], [75, 'B+'], [74.9, 'B'], [70, 'B'], [69.9, 'B-'],
  [65, 'B-'], [64.9, 'C+'], [60, 'C+'], [59.9, 'C'], [50, 'C'], [49.9, 'C-'],
] as const) assert.equal(leadRatingGradeForScore(score), grade, `grade boundary ${score}`)

assert.equal(leadRatingStatusFor(4, 49.9), '无法评级')
assert.equal(leadRatingStatusFor(4, 50), '参考评级')
assert.equal(leadRatingStatusFor(4, 59.9), '参考评级')
assert.equal(leadRatingStatusFor(5, 59.9), '参考评级')
assert.equal(leadRatingStatusFor(5, 60), '正式评级')
assert.equal(leadRatingStatusFor(7, 79.9), '正式评级')
assert.equal(leadRatingStatusFor(7, 80), '正式评级')

const aPlus = computeLeadRatingV3(modelOutput({ score: 9 }))
assert.equal(aPlus.mainView.displayGrade, 'A+')
assert.equal(aPlus.detailView.rating.confidence, '高')

const noAPlusWithRedFlag = computeLeadRatingV3(modelOutput({ score: 9, redFlags: ['重大知识产权权属争议'] }))
assert.equal(noAPlusWithRedFlag.mainView.displayGrade, 'A')

const severeConflict = computeLeadRatingV3(modelOutput({
  score: 9,
  conflicts: ['两份核心订单材料存在重大冲突，当前无法判断真实性'],
}))
assert.equal(severeConflict.detailView.rating.status, '无法评级')
assert.equal(severeConflict.detailView.rating.grade, 'D')
assert.equal(severeConflict.mainView.displayGrade, 'D')

const e3Cap = computeLeadRatingV3(modelOutput({ score: 9.5, evidenceLevel: 'E3' }))
assert.equal(e3Cap.computed.score, 80)
assert.ok(e3Cap.detailView.dimensionScores.every((dimension) => dimension.score === 8))

const referenceRating = computeLeadRatingV3(modelOutput({
  score: 7,
  nullKeys: ['financial_operations', 'technology_rd', 'industry_policy_space'],
}))
assert.equal(referenceRating.computed.informationCoverage, 55)
assert.equal(referenceRating.detailView.rating.status, '参考评级')
assert.equal(referenceRating.mainView.displayGrade, 'B')

const unable = computeLeadRatingV3(modelOutput({
  score: 9,
  nullKeys: ['financial_operations', 'product_competitiveness', 'technology_rd', 'industry_policy_space'],
}))
assert.equal(unable.detailView.rating.status, '无法评级')
assert.equal(unable.detailView.rating.grade, 'D')
assert.equal(unable.detailView.rating.score, null)
assert.equal(unable.mainView.displayGrade, 'D')

const normalized = computeLeadRatingV3(modelOutput({ score: 8.5 }))
assert.equal(normalized.mainView.displayGrade, normalized.detailView.rating.grade)
assert.equal(normalized.schemaVersion, 'lead-rating-v3')

const factId = '11111111-1111-4111-8111-111111111111'
const evidenceId = '22222222-2222-4222-8222-222222222222'
const traceableRating = { detailView: { dimensionScores: [{
  key: 'technology_rd', score: 8,
  keyEvidence: [{ factId, evidenceIds: [evidenceId] }],
}] } }
assert.equal(validateSnapshotBoundLeadRatingEvidence(traceableRating, [{ id: factId, evidenceIds: [evidenceId] }]), true)
assert.throws(() => validateSnapshotBoundLeadRatingEvidence(traceableRating, [{ id: factId, evidenceIds: [] }]), /unknown fact\/evidence/)

const researchWithCompanyFinancialScore = computeLeadRatingV3(modelOutput({ score: 8 }))
assert.throws(() => validateSnapshotBoundLeadRatingApplicability(researchWithCompanyFinancialScore, {
  financial_operations: 'not_applicable', transaction_exit: 'not_applicable',
}), /null financial dimension/)
const researchApplicable = computeLeadRatingV3(modelOutput({
  score: 8, nullKeys: ['financial_operations'],
}))
assert.equal(validateSnapshotBoundLeadRatingApplicability(researchApplicable, {
  financial_operations: 'not_applicable', transaction_exit: 'not_applicable',
}), true)
const transactionClaimWithoutTopicEvidence = computeLeadRatingV3({
  ...modelOutput({ score: 8 }),
  transaction_value: {
    valuation_information_available: true,
    terms_information_available: false,
    assessment: '错误地声称存在估值信息。',
  },
})
assert.throws(() => validateSnapshotBoundLeadRatingApplicability(transactionClaimWithoutTopicEvidence, {
  transaction_exit: 'missing',
}), /cannot claim valuation or terms availability/)

const integrated = await scoreWithAgentDetailed(LEAD_RATING_V3_WORKFLOW, {
  projectName: '验收项目',
  immutableEvidence: ['仅使用本条验收证据'],
}, {
  primaryModel: 'lead-rating-v3-acceptance',
  fallbackModel: 'lead-rating-v3-acceptance',
  agentRunner: (async ({ prompt, outputSchema }) => {
    assert.match(prompt, /共享线索池项目 V3 标准评级/)
    assert.equal((outputSchema as { properties?: { dimension_scores?: { minItems?: number } } }).properties?.dimension_scores?.minItems, 7)
    return {
      output: modelOutput({ score: 8.5 }),
      runtime: 'claude-agent-sdk',
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
      durationMs: 10,
      costMicrousd: 0,
      toolCalls: 0,
      numTurns: 1,
      sessionId: 'lead-rating-v3-acceptance',
    }
  }) as LeadScoringAgentRunner,
})
assert.equal(integrated.result.total, 85)
assert.equal(integrated.result.ratingV3?.mainView.displayGrade, 'A')

console.log(JSON.stringify({
  ok: true,
  checks: [
    'grade-boundaries', 'coverage-boundaries', 'a-plus-gates', 'severe-conflict-gate', 'e3-cap',
    'reference-rating', 'unable-rating-null-contract', 'main-detail-consistency', 'snapshot-evidence-traceability',
    'research-and-transaction-topic-applicability-gates', 'agent-workflow-integration',
  ],
}, null, 2))
