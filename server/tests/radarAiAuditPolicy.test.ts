import assert from 'node:assert/strict'
import test from 'node:test'
import { radarAiDecisionAuditKey, radarAiReviewAuditKey } from '../src/services/radarAiAuditPolicy.js'

test('雷达 AI 决策幂等键绑定审计运行，重试不会与旧运行碰撞', () => {
  const first = radarAiDecisionAuditKey({ cacheKey: 'candidate-a', status: 'failed', runId: 'run-1' })
  const replay = radarAiDecisionAuditKey({ cacheKey: 'candidate-a', status: 'failed', runId: 'run-1' })
  const retry = radarAiDecisionAuditKey({ cacheKey: 'candidate-a', status: 'failed', runId: 'run-2' })
  assert.equal(first, replay)
  assert.notEqual(first, retry)
})

test('人工复核幂等键绑定触发决策，避免跨运行不可变输出冲突', () => {
  assert.equal(
    radarAiReviewAuditKey({ cacheKey: 'candidate-a', decisionId: 'decision-1' }),
    radarAiReviewAuditKey({ cacheKey: 'candidate-a', decisionId: 'decision-1' }),
  )
  assert.notEqual(
    radarAiReviewAuditKey({ cacheKey: 'candidate-a', decisionId: 'decision-1' }),
    radarAiReviewAuditKey({ cacheKey: 'candidate-a', decisionId: 'decision-2' }),
  )
})
