import assert from 'node:assert/strict'
import test from 'node:test'
import { isAiArtifactDeliveryFormat } from '../src/services/aiArtifactDeliveryPolicy.js'

test('investment proposal exposes its DOCX/PDF pair, not working files', () => {
  for (const format of ['docx', 'pdf']) assert.equal(isAiArtifactDeliveryFormat('investment_proposal', format), true)
  for (const format of ['md', 'json', 'png', 'pptx']) assert.equal(isAiArtifactDeliveryFormat('investment_proposal', format), false)
})

test('other task format behavior is unchanged', () => {
  for (const type of ['compliance_statement', 'project_qa', 'due_diligence_report']) {
    for (const format of ['docx', 'pdf', 'md']) assert.equal(isAiArtifactDeliveryFormat(type, format), true)
  }
})
