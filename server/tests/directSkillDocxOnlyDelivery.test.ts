import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const servicePath = path.resolve('server/src/services/aiDirectInvestmentProposalAgentService.ts')

test('direct document agent delivers validated DOCX without entering the PDF branch', async () => {
  const source = await readFile(servicePath, 'utf8')

  assert.match(source, /当前任务不生成、不导出、不检查 PDF/)
  assert.doesNotMatch(source, /inspectDirectSkillPdf/)
  assert.doesNotMatch(source, /同时必须保留一份由最终 DOCX 导出/)
  assert.match(source, /skill\.output\.accepted/)
  assert.match(source, /fallback_model_selected/)
  assert.match(source, /doc\.paragraphs\.index/)
})
