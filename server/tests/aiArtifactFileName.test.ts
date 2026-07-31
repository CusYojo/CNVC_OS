import assert from 'node:assert/strict'
import test from 'node:test'
import { makeArtifactFileName } from '../src/services/aiBusinessDocumentService.js'
import type { AiTemplateDefinition } from '../src/services/aiTemplateCatalog.js'

const template = (input: Partial<AiTemplateDefinition>): AiTemplateDefinition => ({
  type: 'investment_recommendation_ppt',
  skillName: 'editable-ppt-content-replacer',
  label: '2. 轻蜓光电投资建议书',
  description: '测试模板',
  outputFormat: 'pptx',
  templateVersion: 'test',
  referencePath: '/tmp/template.pptx',
  editableLevel: 'core-elements',
  sections: [],
  requiredParameters: [],
  disclaimer: '测试',
  ...input,
})

test('investment recommendation PPT filename does not inherit the uploaded template name', () => {
  assert.equal(
    makeArtifactFileName('智灵动力', template({}), 1785329882510),
    '智灵动力_投资建议书_1785329882510.pptx',
  )
})

test('other document types continue to use their configured document name', () => {
  assert.equal(
    makeArtifactFileName(
      '智灵动力',
      template({
        type: 'due_diligence_report',
        label: '尽调报告',
        outputFormat: 'docx',
      }),
      1785329882510,
    ),
    '智灵动力_尽调报告_1785329882510.docx',
  )
})
