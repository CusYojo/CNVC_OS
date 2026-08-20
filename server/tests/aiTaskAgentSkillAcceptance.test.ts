import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = process.cwd()

test('compliance and proposal business acceptance belongs to Agent and current Skill', async () => {
  const [taskService, renderService, proposalProcessor, complianceProcessor] = await Promise.all([
    readFile(path.join(root, 'server/src/services/aiTaskService.ts'), 'utf8'),
    readFile(path.join(root, 'server/src/services/aiDocumentSkillRenderService.ts'), 'utf8'),
    readFile(path.join(
      root,
      'server/workspace/.agents/skills/draft-investment-proposal/scripts/proposal_processor.py',
    ), 'utf8'),
    readFile(path.join(
      root,
      'server/workspace/.agents/skills/generate-investment-compliance-note/scripts/compliance_processor.py',
    ), 'utf8'),
  ])

  assert.doesNotMatch(taskService, /reviewGeneratedComplianceDocx\s*\(/)
  assert.doesNotMatch(taskService, /reviewInvestmentProposalDocx\s*\(/)
  assert.doesNotMatch(taskService, /validateInvestmentProposalWithSkill\s*\(/)
  assert.match(taskService, /deliveryIntegrityOnly:\s*\['compliance_statement', 'investment_proposal'\]/)
  assert.match(taskService, /acceptanceAuthority:\s*'agent-and-current-skill'/)
  assert.match(taskService, /programmaticBusinessAcceptance:\s*false/)
  assert.match(taskService, /deliveryValidation:\s*'file-integrity-and-authorization-only'/)

  assert.doesNotMatch(renderService, /compliance_processor\.py[\s\S]{0,2000}'verify'/)
  assert.doesNotMatch(proposalProcessor, /command_audit|command_verify|audit_artifacts|hard_failures/)
  assert.doesNotMatch(complianceProcessor, /verify_command|validate_content|quality_score/)
})
