import assert from 'node:assert/strict'
import test from 'node:test'
import { buildExperiencePrompt, detectExplicitPreference, sanitizeCandidate, shouldCreatePeriodicCandidate } from '../src/services/assistantExperiencePolicy.js'

test('detects explicit future preference without treating project facts as preferences', () => {
  assert.equal(detectExplicitPreference('以后分析项目时先总结，再说原因'), true)
  assert.equal(detectExplicitPreference('大衍科技成立于 2020 年'), false)
})

test('creates one periodic boundary only when enabled', () => {
  assert.equal(shouldCreatePeriodicCandidate({ enabled: true, processedTurns: 4, completedTurns: 5 }), true)
  assert.equal(shouldCreatePeriodicCandidate({ enabled: false, processedTurns: 4, completedTurns: 5 }), false)
  assert.equal(shouldCreatePeriodicCandidate({ enabled: true, processedTurns: 5, completedTurns: 5 }), false)
})

test('filters secrets and orders project experience first', () => {
  assert.equal(sanitizeCandidate('密码是 abc123'), null)
  const prompt = buildExperiencePrompt([
    { rule: '说明原因', scopeType: 'global', version: 1 },
    { rule: '先总结', scopeType: 'project', version: 1 },
  ])
  assert.ok(prompt.indexOf('先总结') < prompt.indexOf('说明原因'))
})
