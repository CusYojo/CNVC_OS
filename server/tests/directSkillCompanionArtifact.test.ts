import assert from 'node:assert/strict'
import test from 'node:test'
import { directSkillCompanionArtifact } from '../src/services/directSkillCompanionArtifact.js'

test('PDF registration preserves task/user/project ownership and relates to DOCX', () => {
  const docx = {
    id: 'docx-id', taskId: 'task', userId: 'owner', projectId: 'project',
    conversationId: 'conversation', fileName: 'proposal.docx', format: 'docx',
    mimeType: 'application/docx', storagePath: '/task/proposal.docx',
    version: 1, editableLevel: 'full', sourceCutoffDate: '2026-09-07',
    templateVersion: '1', qualityStatus: 'passed', archived: false,
    metadata: { openXmlReadable: true },
  } as Parameters<typeof directSkillCompanionArtifact>[0]
  const [pdf] = directSkillCompanionArtifact(docx, { pdfPath: '/task/proposal.pdf', pdfBytes: 1234, pdfSha256: 'hash' })
  assert.notEqual(pdf.id, docx.id)
  for (const key of ['taskId', 'userId', 'projectId', 'conversationId'] as const) assert.equal(pdf[key], docx[key])
  assert.equal(pdf.format, 'pdf')
  assert.equal(pdf.mimeType, 'application/pdf')
  assert.equal(pdf.metadata?.companionDocxArtifactId, docx.id)
  assert.equal(pdf.metadata?.openXmlReadable, undefined)
  assert.deepEqual(directSkillCompanionArtifact(docx, {}), [])
})
