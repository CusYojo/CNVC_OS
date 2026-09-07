import assert from 'node:assert/strict'
import test from 'node:test'
import {
  leadWorkflowAgentContract,
  leadWorkflowAgentRuntime,
} from '../src/services/leadWorkflowAgentService.js'
import { leadSubjectAgentRuntime } from '../src/services/leadSubjectAgentService.js'
import { leadAgentAuditPromptVersion } from '../src/services/leadAgentPromptVersion.js'

test('routes GPT subject and workflow agents through Codex CLI', () => {
  assert.equal(leadSubjectAgentRuntime('gpt-5.6-sol'), 'codex-cli')
  assert.equal(leadWorkflowAgentRuntime('gpt-5.6-sol'), 'codex-cli')
  assert.equal(leadSubjectAgentRuntime('gpt-5.6-sol', true), 'claude-agent-sdk')
  assert.equal(leadWorkflowAgentRuntime('gpt-5.6-sol', true), 'claude-agent-sdk')
})

test('audit prompt versions are isolated by Agent runtime', () => {
  assert.equal(leadAgentAuditPromptVersion('lead-research-prompt-v1', 'codex-cli'), 'lead-research-prompt-v1-codex-v1')
  assert.equal(leadAgentAuditPromptVersion('lead-research-prompt-v1', 'claude-agent-sdk'), 'lead-research-prompt-v1-claude-v1')
  assert.throws(
    () => leadAgentAuditPromptVersion('x'.repeat(60), 'claude-agent-sdk'),
    /exceeds 64 characters/,
  )
})

test('paper screening treats missing commercial fields as enrichment gaps', () => {
  const contract = leadWorkflowAgentContract('lead-screening-agent')
  assert.equal(contract.profileVersion, 'lead-screening-agent-v3')
  assert.equal(contract.promptVersion, 'lead-screening-prompt-v3')
  assert.match(contract.systemPrompt, /论文候选不要求具备公司、客户、收入或融资信息/)
  assert.match(contract.systemPrompt, /应 accept/)
})
