import { PDFParse } from 'pdf-parse'

import type { WeixinInboundDocument } from './weixinInboundFile.js'
import { WeixinInboundFileError } from './weixinInboundFile.js'

const MAX_RUNTIME_TEXT_CHARS = 300_000

function boundedDocumentText(fileName: string, value: string) {
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  if (!normalized) {
    throw new WeixinInboundFileError(
      `微信文件 ${fileName} 没有可读取的文字内容`,
      '文件中没有可读取的文字；扫描版 PDF 请先转换为可搜索 PDF，或直接发送正文。',
    )
  }
  if (normalized.length <= MAX_RUNTIME_TEXT_CHARS) return normalized
  return `${normalized.slice(0, MAX_RUNTIME_TEXT_CHARS)}\n\n[文件内容过长，已截断]`
}

async function pdfText(document: WeixinInboundDocument) {
  const data = Buffer.from(document.dataBase64 || '', 'base64')
  if (!data.length || data.length !== document.byteSize) {
    throw new WeixinInboundFileError('微信 PDF 内容为空或长度不一致')
  }
  const parser = new PDFParse({ data })
  try {
    const parsed = await parser.getText()
    return boundedDocumentText(document.fileName, parsed.text || '')
  } catch (error) {
    if (error instanceof WeixinInboundFileError) throw error
    throw new WeixinInboundFileError(
      `微信 PDF 文字提取失败：${error instanceof Error ? error.message : String(error)}`,
      'PDF 正文解析失败；请发送可搜索 PDF，或另存为 DOCX、Markdown 后重试。',
    )
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

export async function weixinAgentDocumentText(document: WeixinInboundDocument) {
  const text = document.kind === 'pdf'
    ? await pdfText(document)
    : boundedDocumentText(document.fileName, document.text || '')
  return `【微信文件：${document.fileName}】\n${text}\n【文件结束】`
}
