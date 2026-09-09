import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyDirectSkillAgentFailure } from '../src/services/aiDirectSkillAgentRecovery.js'

test('quota exhaustion is eligible for fallback-model recovery', () => {
  assert.deepEqual(classifyDirectSkillAgentFailure('insufficient quota for this request'), {
    code: 'DIRECT_SKILL_AGENT_QUOTA_EXHAUSTED',
    recoverableGateway403: false,
    recoverableQuota: true,
  })
})

test('authentication errors and unrelated failures never use quota fallback', () => {
  assert.equal(classifyDirectSkillAgentFailure('invalid api key').recoverableQuota, false)
  assert.equal(classifyDirectSkillAgentFailure('python script failed').recoverableQuota, false)
})
