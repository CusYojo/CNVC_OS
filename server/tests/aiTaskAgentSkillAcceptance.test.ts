import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = process.cwd()

test('all quick-entry business acceptance belongs to Agent and current Skill', async () => {
  const [
    taskService,
    renderService,
    qaRuntime,
    diligenceRuntime,
    bridge,
    businessContent,
    proposalContent,
    complianceWorkflow,
    qaPipeline,
  ] = await Promise.all([
    readFile(path.join(root, 'server/src/services/aiTaskService.ts'), 'utf8'),
    readFile(path.join(root, 'server/src/services/aiDocumentSkillRenderService.ts'), 'utf8'),
    readFile(path.join(root, 'server/src/services/aiProjectQaSkillRuntimeService.ts'), 'utf8'),
    readFile(path.join(root, 'server/src/services/aiDueDiligenceSkillRuntimeService.ts'), 'utf8'),
    readFile(path.join(root, 'server/scripts/skill_document_bridge.py'), 'utf8'),
    readFile(path.join(root, 'server/src/services/aiBusinessContentService.ts'), 'utf8'),
    readFile(path.join(root, 'server/src/services/aiInvestmentProposalContentService.ts'), 'utf8'),
    readFile(path.join(root, 'server/src/services/aiComplianceWorkflowService.ts'), 'utf8'),
    readFile(path.join(root, 'server/src/services/aiQaPipelineService.ts'), 'utf8'),
  ])

  assert.doesNotMatch(taskService, /reviewGeneratedComplianceDocx\s*\(/)
  assert.doesNotMatch(taskService, /reviewInvestmentProposalDocx\s*\(/)
  assert.doesNotMatch(taskService, /validateInvestmentProposalWithSkill\s*\(/)
  assert.doesNotMatch(taskService, /reviewInvestmentRecommendationPpt\s*\(/)
  assert.doesNotMatch(taskService, /assess(?:Qa|DueDiligence)TemplateFidelity\s*\(/)
  assert.match(taskService, /deliveryIntegrityOnly:\s*true/)
  assert.match(taskService, /acceptanceAuthority:\s*'agent-and-current-skill'/)
  assert.match(taskService, /programmaticBusinessAcceptance:\s*false/)
  assert.match(taskService, /deliveryValidation:\s*'file-integrity-and-authorization-only'/)
  assert.ok((taskService.match(/programmaticBusinessAcceptance:\s*false/g) ?? []).length >= 7)

  assert.doesNotMatch(renderService, /compliance_processor\.py[\s\S]{0,2000}'verify'/)
  const qaProductionPath = qaRuntime.slice(qaRuntime.indexOf('export async function generateProjectQaWithSkill'))
  assert.doesNotMatch(qaProductionPath, /assertSkillContentReady|renderEveryPage|verify-out/)
  assert.doesNotMatch(bridge, /processor\.verify_docx/)
  const diligenceProductionPath = diligenceRuntime.slice(
    diligenceRuntime.indexOf('export async function generateDueDiligenceReportWithSkill'),
  )
  assert.doesNotMatch(
    diligenceProductionPath,
    /runPackageAudits|audit_docx_style|investment_bank_styles|\['verify'/,
  )
  assert.match(businessContent, /input\.programmaticBusinessAcceptance === false/)
  assert.match(proposalContent, /if \(!programmaticBusinessAcceptance\)/)
  assert.match(complianceWorkflow, /if \(input\.programmaticBusinessAcceptance === false\)/)
  assert.match(qaPipeline, /useProgrammaticBusinessAcceptance = input\.programmaticBusinessAcceptance !== false/)
})
