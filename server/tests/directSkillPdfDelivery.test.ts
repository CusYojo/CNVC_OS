import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectDirectSkillPdf } from '../src/services/directSkillPdfDelivery.js'
import { writeAcceptancePdf } from '../src/scripts/helpers/acceptancePdf.js'

test('missing PDF, malformed PDF and duplicate PDF cannot pass delivery', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'skill-pdf-'))
  try {
    const docx = path.join(directory, 'proposal.docx')
    const pdf = path.join(directory, 'proposal.pdf')
    await assert.rejects(inspectDirectSkillPdf(docx), { code: 'DIRECT_SKILL_PDF_MISSING' })
    await writeFile(pdf, 'not a pdf')
    await assert.rejects(inspectDirectSkillPdf(docx), { code: 'DIRECT_SKILL_PDF_INVALID' })
    await writeAcceptancePdf(pdf)
    const result = await inspectDirectSkillPdf(docx)
    assert.equal(result.pdfPath, pdf)
    assert.equal(result.pdfSha256.length, 64)
    await writeAcceptancePdf(path.join(directory, 'extra.pdf'))
    await assert.rejects(inspectDirectSkillPdf(docx), { code: 'DIRECT_SKILL_PDF_MISSING' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
