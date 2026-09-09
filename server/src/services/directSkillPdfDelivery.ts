import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { PDFParse } from 'pdf-parse'

export async function inspectDirectSkillPdf(outputPath: string) {
  const pdfPath = outputPath.replace(/\.docx$/i, '.pdf')
  const expected = path.basename(pdfPath)
  const pdfs = (await readdir(path.dirname(outputPath))).filter((name) => /\.pdf$/i.test(name))
  if (pdfs.length !== 1 || pdfs[0] !== expected) {
    throw Object.assign(new Error('Skill 缺少唯一且与 DOCX 同名的 PDF 成品'), { code: 'DIRECT_SKILL_PDF_MISSING' })
  }
  const info = await lstat(pdfPath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw Object.assign(new Error('PDF 成品必须是任务目录中的普通文件'), { code: 'DIRECT_SKILL_PDF_INVALID' })
  }
  const bytes = await readFile(pdfPath)
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw Object.assign(new Error('PDF 成品文件头无效'), { code: 'DIRECT_SKILL_PDF_INVALID' })
  }
  const parser = new PDFParse({ data: bytes })
  try {
    const parsed = await parser.getText()
    if (parsed.total < 1 || !parsed.text.trim()) throw Error('empty PDF')
  } catch {
    throw Object.assign(new Error('PDF 成品无法解析或没有可读内容'), { code: 'DIRECT_SKILL_PDF_INVALID' })
  } finally {
    await parser.destroy()
  }
  // This is delivery integrity, not proof of native export or visual fidelity.
  // The executing Skill must still perform its DOCX/PDF pair and visual gates.
  return { pdfPath, pdfBytes: bytes.length, pdfSha256: createHash('sha256').update(bytes).digest('hex') }
}
