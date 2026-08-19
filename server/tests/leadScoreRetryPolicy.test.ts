import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  leadScoreRetryPolicy,
  publicLeadScoreDeadLetterError,
  publicLeadScoreError,
  shouldAttemptLeadScoreFallback,
  type LeadScoreRuntimeError,
} from '../src/services/leadScoreRetryPolicy.js'

test('circuit-open errors defer immediately until the reported recovery window', () => {
  const error = Object.assign(new Error('线索 Agent 连续失败熔断中'), {
    code: 'LEAD_AGENT_CIRCUIT_OPEN',
    retryable: true,
    retryAfterMs: 287_000,
  }) as LeadScoreRuntimeError
  assert.deepEqual(leadScoreRetryPolicy(error), {
    retryable: true,
    deferImmediately: true,
    delayMs: 287_000,
    category: 'circuit',
  })
})

test('rate and concurrency gates are delayed while permanent errors fail closed', () => {
  assert.equal(leadScoreRetryPolicy(new Error('HTTP 429 Too Many Requests')).category, 'rate_limit')
  assert.equal(leadScoreRetryPolicy(new Error('线索 Agent 全局并发已达到上限')).category, 'concurrency')
  assert.deepEqual(leadScoreRetryPolicy(Object.assign(new Error('invalid schema'), { retryable: false })), {
    retryable: false,
    deferImmediately: false,
    delayMs: 0,
    category: 'permanent',
  })
})

test('public errors explain automatic recovery without exposing provider details', () => {
  assert.equal(
    publicLeadScoreError('线索 Agent 连续失败熔断中'),
    'AI 评分服务暂时熔断，系统将等待服务恢复后自动重试',
  )
  assert.equal(
    publicLeadScoreError('lead-scoring-agent timed out after 30000ms'),
    'AI 评分服务响应超时，系统将自动重试',
  )
  assert.equal(
    publicLeadScoreDeadLetterError('线索 Agent 连续失败熔断中'),
    '任务因 AI 评分服务熔断未能完成',
  )
})

test('a global backoff never consumes the fallback model attempt', () => {
  const circuit = Object.assign(new Error('线索 Agent 连续失败熔断中'), {
    code: 'LEAD_AGENT_CIRCUIT_OPEN',
    retryable: true,
  })
  assert.equal(shouldAttemptLeadScoreFallback(circuit, 1, 2), false)
  assert.equal(shouldAttemptLeadScoreFallback(new Error('HTTP 406 upstream error'), 1, 2), true)
  assert.equal(shouldAttemptLeadScoreFallback(new Error('HTTP 406 upstream error'), 2, 2), false)
  assert.equal(
    shouldAttemptLeadScoreFallback(Object.assign(new Error('invalid schema'), { retryable: false }), 1, 2),
    false,
  )
})

test('production scoring enables deferred cycles and skips fallback during a global backoff', async () => {
  const [routes, workflow] = await Promise.all([
    readFile(new URL('../src/routes/meta.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/inProcessAiWorkflowService.ts', import.meta.url), 'utf8'),
  ])
  assert.match(routes, /SCORE_DEFERRED_RETRY_LIMIT \|\| '3'/)
  assert.match(routes, /retryPolicy\.deferImmediately/)
  assert.match(routes, /delayMs: retryPolicy\.delayMs/)
  assert.match(routes, /waitsForCircuitRecovery \|\| retryCycles < SCORE_DEFERRED_RETRY_LIMIT/)
  assert.match(routes, /automaticCircuitRecovery: true/)
  assert.match(workflow, /shouldAttemptLeadScoreFallback\(lastError, modelAttempt, models\.length\)/)
})
