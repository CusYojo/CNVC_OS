import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getAiSkillDirectory } from '../src/services/aiSkillService.js'
import { validateInvestmentProposalWithSkill } from '../src/services/aiInvestmentProposalSkillRuntimeService.js'

const TEMPLATE_NAME = '德塔式精简工商字段投资提案_固定模板V7.docx'

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

test('investment proposal validates the active Deta V7 plugin manifest instead of legacy A4 rules', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'proposal-plugin-validation-'))
  try {
    const renderDirectory = path.join(directory, '.investment-proposal-plugin-render')
    const documentPath = path.join(directory, '投资提案.docx')
    const payloadPath = path.join(renderDirectory, 'proposal.json')
    const manifestPath = path.join(renderDirectory, 'render-manifest.json')
    const pluginSkillDirectory = getAiSkillDirectory('draft-investment-proposal')
    const templatePath = path.resolve(pluginSkillDirectory, '..', '..', 'assets', TEMPLATE_NAME)
    await mkdir(renderDirectory, { recursive: true })
    await copyFile(templatePath, documentPath)
    await writeFile(payloadPath, JSON.stringify({ meta: {}, sections: [] }), 'utf8')
    const [document, payload, template] = await Promise.all([
      readFile(documentPath),
      readFile(payloadPath),
      readFile(templatePath),
    ])
    await writeFile(manifestPath, JSON.stringify({
      status: 'rendered',
      workflow: 'SBL_APP_PLUGIN_TEMPLATE_RENDER_V1',
      docx: documentPath,
      docx_sha256: sha256(document),
      payload: payloadPath,
      payload_sha256: sha256(payload),
      template: templatePath,
      template_sha256: sha256(template),
      template_enforced: true,
      renderer_mode: 'clone-approved-docx',
      external_llm_gateway: false,
    }), 'utf8')

    const result = await validateInvestmentProposalWithSkill(documentPath)
    assert.equal(result.passed, true)
    assert.equal(result.fidelity.passed, true)
    assert.equal(result.proposal.status, 'pass')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('investment proposal rejects a Deta V7 plugin manifest when the document hash drifts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'proposal-plugin-validation-'))
  try {
    const renderDirectory = path.join(directory, '.investment-proposal-plugin-render')
    const documentPath = path.join(directory, '投资提案.docx')
    const payloadPath = path.join(renderDirectory, 'proposal.json')
    const manifestPath = path.join(renderDirectory, 'render-manifest.json')
    const pluginSkillDirectory = getAiSkillDirectory('draft-investment-proposal')
    const templatePath = path.resolve(pluginSkillDirectory, '..', '..', 'assets', TEMPLATE_NAME)
    await mkdir(renderDirectory, { recursive: true })
    await copyFile(templatePath, documentPath)
    await writeFile(payloadPath, '{}', 'utf8')
    const [payload, template] = await Promise.all([readFile(payloadPath), readFile(templatePath)])
    await writeFile(manifestPath, JSON.stringify({
      status: 'rendered',
      workflow: 'SBL_APP_PLUGIN_TEMPLATE_RENDER_V1',
      docx: documentPath,
      docx_sha256: '0'.repeat(64),
      payload: payloadPath,
      payload_sha256: sha256(payload),
      template: templatePath,
      template_sha256: sha256(template),
      template_enforced: true,
      renderer_mode: 'clone-approved-docx',
      external_llm_gateway: false,
    }), 'utf8')

    await assert.rejects(
      validateInvestmentProposalWithSkill(documentPath),
      (error: Error & { code?: string; report?: { errors?: string[] } }) => (
        error.code === 'INVESTMENT_PROPOSAL_SKILL_VALIDATION_FAILED'
        && error.report?.errors?.includes('PLUGIN_RENDER_DOCUMENT_SHA256') === true
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
