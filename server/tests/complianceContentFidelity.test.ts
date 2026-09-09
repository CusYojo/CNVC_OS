import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildComplianceSkillContent, renderComplianceStatementWithSkill } from '../src/services/aiDocumentSkillRenderService.js'
import type { BusinessContent } from '../src/services/aiBusinessContentService.js'

test('compliance formatter preserves investment reason limitations verbatim', () => {
  const reasons = [
    '公司已完成样品验证，但量产良率仍需核验。',
    '该产品已有试用客户，仍需取得正式验收材料。',
    '项目具有潜在应用价值，取决于后续客户验证。',
    '客户已表达采购意向，交割前应核对正式订单。',
    '已取得初步测试结果，需进一步确认测试条件。',
  ]
  const content: BusinessContent = {
    title: '测试', executiveSummary: '', highlights: [], risks: [], missing: [],
    sections: [{ title: '投资理由', summary: '', findings: reasons.map(text => ({
      text, status: '待核验', sourceIndexes: [0],
    })) }],
  }
  const payload = buildComplianceSkillContent({
    projectName: '合成测试', content,
    sources: [{ sourceId: 'fixture', sourceType: 'test', sourceName: '合成证据', content: '合成文本' }],
    company: '合成机构', generatedAt: new Date('2026-09-07T00:00:00Z'),
  })
  const blocks = payload.sections.find(section => section.heading === '投资理由')!.blocks
  assert.deepEqual(blocks.map(block => block.text), reasons)
  assert.ok(blocks.every(block => 'status' in block && block.status === 'pending'))
})

test('render rejects missing contract with safe persisted error before Python execution', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'compliance-contract-test-'))
  const outputPath = path.join(directory, 'synthetic.docx')
  const errors: string[] = []
  t.mock.method(console, 'error', (message: string) => errors.push(message))
  await assert.rejects(renderComplianceStatementWithSkill({
    outputPath, taskProjectName: 'PRIVATE_SYNTHETIC_NAME',
    content: { title: '', executiveSummary: 'PRIVATE_SYNTHETIC_FACT', sections: [], highlights: [], risks: [], missing: [] },
    sources: [], company: 'Synthetic', generatedAt: new Date('2026-09-07T00:00:00Z'),
  }), { code: 'COMPLIANCE_RENDER_CONTRACT_MISMATCH' })
  const diagnostic = await readFile(path.join(directory, '.generate-investment-compliance-note-render', 'contract-error.json'), 'utf8')
  assert.equal(JSON.parse(diagnostic).level, 'error')
  assert.deepEqual(JSON.parse(errors[0]), JSON.parse(diagnostic))
  assert.doesNotMatch(diagnostic, /PRIVATE_SYNTHETIC/)
  await assert.rejects(access(outputPath), { code: 'ENOENT' })
})
