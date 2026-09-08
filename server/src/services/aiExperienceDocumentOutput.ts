import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { evolutionError } from './aiEvolutionPolicyService.js'

/** Extract the delivered DOCX body, never a generation summary or a silently truncated excerpt. */
export async function aiExperienceDocxOutput(content: Buffer) {
  if (content.length > 10 * 1024 * 1024) throw evolutionError(409, 'EVOLUTION_OUTPUT_LIMIT', '报告文件超出检查限制')
  const zip = await JSZip.loadAsync(content)
  const entries = Object.values(zip.files)
  if (entries.length > 2000 || !zip.file('word/document.xml')) throw evolutionError(409, 'EVOLUTION_DOCUMENT_INVALID', '报告 DOCX 结构异常')
  let expanded = 0
  for (const entry of entries) {
    if (entry.dir) continue
    const size = (entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    if (!Number.isSafeInteger(size) || size! < 0) throw evolutionError(409, 'EVOLUTION_DOCUMENT_INVALID', '无法核对报告解压大小')
    expanded += size!
    if (expanded > 40 * 1024 * 1024) throw evolutionError(409, 'EVOLUTION_OUTPUT_LIMIT', '报告解压大小超出限制')
  }
  const text = (await mammoth.extractRawText({ buffer: content })).value
  if (!text.trim()) throw evolutionError(409, 'EVOLUTION_DOCUMENT_INVALID', '报告没有可检查的正文文本')
  if (Buffer.byteLength(text, 'utf8') > 40_000) throw evolutionError(409, 'EVOLUTION_OUTPUT_LIMIT', '完整报告正文超出单次检查范围，不能截断后判为通过')
  return `交付文件 SHA256：${createHash('sha256').update(content).digest('hex')}\n提取版本：docx-body-v1\n检查覆盖：DOCX 正文文本，不覆盖图片和版式；这些要求应记为无法判断。\n\n${text}`
}
