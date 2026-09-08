import assert from 'node:assert/strict'
import { test } from 'node:test'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { aiExperienceDocxOutput } from '../src/services/aiExperienceDocumentOutput.js'

async function document(text: string, metadata = '') {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
  if (metadata) zip.file('docProps/core.xml', metadata)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
test('document checks use delivered body text and exact file identity with explicit coverage', async () => {
  const bytes = await document('融资计划：拟融资一亿元。已完成融资：尚无证据。')
  const output = await aiExperienceDocxOutput(bytes)
  assert.ok(output.includes('融资计划：拟融资一亿元。已完成融资：尚无证据。'))
  assert.ok(output.includes(createHash('sha256').update(bytes).digest('hex')))
  assert.ok(output.includes('不覆盖图片和版式'))
  assert.notEqual(output, await aiExperienceDocxOutput(await document('融资计划：拟融资一亿元。已完成融资：尚无证据。', '<metadata/>')))
})
test('empty or over-limit bodies cannot be silently truncated into a passing input', async () => {
  await assert.rejects(aiExperienceDocxOutput(await document('')), { code: 'EVOLUTION_DOCUMENT_INVALID' })
  await assert.rejects(aiExperienceDocxOutput(await document('资料'.repeat(7000))), { code: 'EVOLUTION_OUTPUT_LIMIT' })
  const zip = new JSZip(); zip.file('word/document.xml', 'x'.repeat(41 * 1024 * 1024))
  await assert.rejects(aiExperienceDocxOutput(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), { code: 'EVOLUTION_OUTPUT_LIMIT' })
})
