import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { PDFParse } from 'pdf-parse'
import type { BusinessContent } from './aiBusinessContentService.js'
import type { InvestmentProposalDocumentBlueprint } from './aiInvestmentProposalBlueprintService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'
import { sanitizeInvestmentProposalClientText } from './aiInvestmentProposalTextService.js'
import { execFileSupervised as execFileAsync } from '../runtime/supervisedProcessService.js'

const SOFFICE_CANDIDATES = [
  process.env.AI_SOFFICE_PATH,
  process.env.AI_LIBREOFFICE_BIN,
  'soffice',
  'libreoffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].filter((candidate): candidate is string => Boolean(candidate))

async function resolvePdftotext(soffice: string) {
  const candidates = [
    process.env.AI_PDFTOTEXT_PATH,
    path.resolve(
      path.dirname(soffice),
      '..',
      '..',
      'native',
      'poppler',
      'poppler',
      'bin',
      'pdftotext',
    ),
    'pdftotext',
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    try {
      if (candidate.includes(path.sep)) await access(candidate)
      else await execFileAsync(candidate, ['-v'], { timeout: 10000 })
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

const xmlEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => xmlEntities[name] ?? '')
}

function xmlText(value: string) {
  return [...value.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join('')
}

function compact(value: string) {
  return value.normalize('NFKC').replace(/[\s\u00a0\u3000]+/g, '')
}

async function resolveSoffice() {
  for (const candidate of SOFFICE_CANDIDATES) {
    if (candidate.includes(path.sep)) {
      try {
        await access(candidate)
        return candidate
      } catch {
        continue
      }
    }
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 10000 })
      try {
        const resolved = await execFileAsync('/usr/bin/which', [candidate], {
          timeout: 10000,
          encoding: 'utf8',
        })
        return resolved.stdout.trim() || candidate
      } catch {
        return candidate
      }
    } catch {
      continue
    }
  }
  throw new Error('投资提案 PDF 导出失败：未找到 LibreOffice/soffice；请配置 AI_SOFFICE_PATH')
}

export type InvestmentProposalPdfReview = {
  passed: boolean
  issues: Array<{ code: string; message: string }>
  metadata: {
    bytes: number
    pageCount: number
    pdfSha256: string
    sourceDocxSha256: string
    sameSourceDocument: true
    textValidated: boolean
    outlineValidated: boolean
    fixedBlocksValidated: boolean
    bodyClaimsValidated: boolean
    pageHeadersValidated: boolean
    pageNumbersValidated: boolean
    blankPageCount: number
    converter: string
    textExtractor: string
  }
}

export async function exportAndReviewInvestmentProposalPdf(input: {
  docxPath: string
  pdfPath: string
  template: AiTemplateDefinition
  blueprint: InvestmentProposalDocumentBlueprint
  content: BusinessContent
}) {
  const docxBuffer = await readFile(input.docxPath)
  if (!docxBuffer.subarray(0, 2).equals(Buffer.from('PK'))) {
    throw new Error('投资提案 PDF 导出的 Word 源文件不是有效 DOCX')
  }
  const zip = await JSZip.loadAsync(docxBuffer)
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) throw new Error('投资提案 PDF 导出的 Word 源文件缺少 document.xml')
  const docxText = xmlText(documentXml)
  const soffice = await resolveSoffice()
  const derivedFontconfigFile = path.resolve(
    path.dirname(soffice),
    '..',
    '..',
    'native',
    'libreoffice-headless',
    'libreoffice',
    'LibreOfficeDev.app',
    'Contents',
    'Resources',
    'fontconfig',
    'fonts.conf',
  )
  const fontconfigFile = process.env.AI_FONTCONFIG_FILE
    || (existsSync(derivedFontconfigFile) ? derivedFontconfigFile : undefined)
  const workDir = await mkdtemp(path.join(tmpdir(), 'cybernaut-proposal-pdf-'))
  const profileDir = path.join(workDir, 'lo-profile')
  const localDocx = path.join(workDir, path.basename(input.docxPath))
  try {
    await copyFile(input.docxPath, localDocx)
    await execFileAsync(soffice, [
      '--headless',
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      workDir,
      localDocx,
    ], {
      timeout: 180000,
      env: {
        ...process.env,
        HOME: workDir,
        TMPDIR: workDir,
        SAL_FONTPATH: [
          process.env.SAL_FONTPATH,
          '/System/Library/Fonts',
          '/System/Library/Fonts/Supplemental',
          '/Library/Fonts',
          '/usr/share/fonts',
          '/usr/local/share/fonts',
        ].filter(Boolean).join(path.delimiter),
        ...(fontconfigFile
          ? {
              FONTCONFIG_FILE: fontconfigFile,
              FONTCONFIG_PATH: path.dirname(fontconfigFile),
            }
          : {}),
      },
      maxBuffer: 1024 * 1024 * 5,
    })
    const generatedPdf = path.join(
      workDir,
      `${path.basename(localDocx, path.extname(localDocx))}.pdf`,
    )
    const generatedStat = await stat(generatedPdf)
    if (!generatedStat.isFile() || generatedStat.size < 1000) {
      throw new Error('LibreOffice 未生成完整的投资提案 PDF')
    }
    await mkdir(path.dirname(input.pdfPath), { recursive: true })
    await rename(generatedPdf, input.pdfPath).catch(async () => {
      await copyFile(generatedPdf, input.pdfPath)
    })
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  const pdfBuffer = await readFile(input.pdfPath)
  const issues: Array<{ code: string; message: string }> = []
  if (pdfBuffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    issues.push({ code: 'PDF_INVALID', message: 'PDF 文件头无效' })
  }
  const parser = new PDFParse({ data: pdfBuffer })
  let pageCount = 0
  let pdfText = ''
  let pageTexts: string[] = []
  try {
    const parsed = await parser.getText()
    pageCount = parsed.total
    pdfText = parsed.text
    pageTexts = parsed.pages.map((page) => page.text)
  } finally {
    await parser.destroy()
  }
  let textExtractor = 'pdf-parse'
  const pdftotext = await resolvePdftotext(soffice)
  if (pdftotext) {
    try {
      const extracted = await execFileAsync(pdftotext, ['-layout', input.pdfPath, '-'], {
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 10,
        encoding: 'utf8',
      })
      const popplerText = extracted.stdout
      const popplerPages = popplerText
        .split('\f')
        .map((page) => page.trim())
        .filter(Boolean)
      if (popplerText.trim() && popplerPages.length === pageCount) {
        pdfText = popplerText
        pageTexts = popplerPages
        textExtractor = path.basename(pdftotext)
      }
    } catch {
      // 保留 pdf-parse 结果；Reviewer 会继续验证文本层并在损坏时失败关闭。
    }
  }
  if (pageCount < 3 || pdfBuffer.length < 1000) {
    issues.push({ code: 'PDF_INCOMPLETE', message: `PDF 页数或文件大小异常：${pageCount}页` })
  }
  const compactPdf = compact(pdfText)
  const compactDocx = compact(docxText)
  const outlineValidated = input.blueprint.sections.every((section) =>
    compactPdf.includes(compact(section.title)))
  if (!outlineValidated) {
    issues.push({ code: 'PDF_OUTLINE_MISMATCH', message: 'PDF 缺少 Word 中的一个或多个 Blueprint 章节' })
  }
  const fixedBlocks = [
    input.blueprint.fixedBlocks.salutation,
    input.blueprint.fixedBlocks.authorization,
    input.blueprint.fixedBlocks.managementCompany,
  ]
  const fixedBlocksValidated = fixedBlocks.every((value) => compactPdf.includes(compact(value)))
  if (!fixedBlocksValidated) {
    issues.push({ code: 'PDF_FIXED_BLOCK_MISSING', message: 'PDF 缺少 Word 中的固定说明或机构落款' })
  }
  const forbiddenFooterBlocks = ['免责声明', '引用资料', input.template.disclaimer]
    .filter(Boolean)
  if (forbiddenFooterBlocks.some((value) => compactPdf.includes(compact(value)))) {
    issues.push({ code: 'PDF_FORBIDDEN_FOOTER_BLOCK', message: 'PDF 文末不得生成免责声明或引用资料板块' })
  }
  const claims = input.content.sections.flatMap((section) =>
    section.findings
      .map((finding) => sanitizeInvestmentProposalClientText(finding.text))
      .filter(Boolean))
  // Word/LibreOffice 对行末中文标点会使用悬挂标点，部分 PDF 文本层
  // 不返回该字形。正文一致性仍逐字校验内容，仅排除排版标点。
  const compactClaim = (value: string) => compact(value).replace(/[，。；：！？、“”‘’（）()]/g, '')
  const compactPdfClaims = compactClaim(pdfText)
  const bodyClaimsValidated = claims.every((claim) => compactPdfClaims.includes(compactClaim(claim)))
  if (!bodyClaimsValidated) {
    issues.push({ code: 'PDF_BODY_MISMATCH', message: 'PDF 遗漏 Word 中已通过 Reviewer 的正文事实项' })
  }
  const sourceAnchors = [
    input.content.title,
    input.blueprint.fixedBlocks.salutation,
    ...input.blueprint.sections.map((section) => section.title),
    input.blueprint.fixedBlocks.managementCompany,
  ]
  const docxAnchorsValid = sourceAnchors.every((value) => compactDocx.includes(compact(value)))
  const textValidated = pdfText.trim().length >= Math.min(500, compactDocx.length)
    && !pdfText.includes('\uFFFD')
    && docxAnchorsValid
  if (!textValidated) {
    issues.push({ code: 'PDF_TEXT_INVALID', message: 'PDF 文本层为空、损坏或无法与 Word 源文件核对' })
  }
  const pageLines = pageTexts.map((page) =>
    page.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  const pageHeadersValidated = pageLines.length === pageCount
    && pageLines.every((lines) =>
      lines.some((line) =>
        compact(line).includes(compact(input.blueprint.fixedBlocks.headerCompany))))
  if (!pageHeadersValidated) {
    issues.push({ code: 'PDF_PAGE_HEADER_MISSING', message: 'PDF 一个或多个页面缺少固定页眉' })
  }
  const pageNumbersValidated = pageLines.length === pageCount
    && pageLines.every((lines, index) => lines.includes(String(index + 1)))
  if (!pageNumbersValidated) {
    issues.push({ code: 'PDF_PAGE_NUMBER_MISSING', message: 'PDF 一个或多个页面缺少连续页码' })
  }
  const blankPageCount = pageLines.filter((lines, index) =>
    compact(lines.filter((line) =>
      line !== String(index + 1)
      && !compact(line).includes(compact(input.blueprint.fixedBlocks.headerCompany))).join('')).length < 20).length
  if (blankPageCount) {
    issues.push({ code: 'PDF_BLANK_PAGE', message: `PDF 存在${blankPageCount}个空白或近空白页面` })
  }

  const result: InvestmentProposalPdfReview = {
    passed: issues.length === 0,
    issues,
    metadata: {
      bytes: pdfBuffer.length,
      pageCount,
      pdfSha256: createHash('sha256').update(pdfBuffer).digest('hex'),
      sourceDocxSha256: createHash('sha256').update(docxBuffer).digest('hex'),
      sameSourceDocument: true,
      textValidated,
      outlineValidated,
      fixedBlocksValidated,
      bodyClaimsValidated,
      pageHeadersValidated,
      pageNumbersValidated,
      blankPageCount,
      converter: path.basename(soffice),
      textExtractor,
    },
  }
  return result
}
