import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import type { BusinessContent } from './aiBusinessContentService.js'
import type { ComplianceDocumentBlueprint } from './aiComplianceBlueprintService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'

const execFileAsync = promisify(execFile)

export type ComplianceOutputIssue = {
  code:
    | 'DOCX_PACKAGE_INVALID'
    | 'DOCX_TEXT_INVALID'
    | 'DOCX_STRUCTURE_MISMATCH'
    | 'DOCX_FORBIDDEN_CONTENT'
    | 'DOCX_FORMAT_MISMATCH'
    | 'DOCX_PAGE_MISMATCH'
    | 'DOCX_TEMPLATE_PART_MISMATCH'
    | 'DOCX_NUMBERING_MISMATCH'
    | 'DOCX_UNEXPECTED_FEATURE'
    | 'PDF_INVALID'
    | 'PDF_TEXT_MISMATCH'
    | 'PDF_FORBIDDEN_CONTENT'
    | 'PDF_CONTENT_COVERAGE'
    | 'PDF_NUMBERING_MISMATCH'
    | 'PDF_FONT_MISSING'
  message: string
}

export type ComplianceOutputReview = {
  passed: boolean
  issues: ComplianceOutputIssue[]
  metadata: Record<string, unknown>
}

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function xmlText(xml: string) {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, '')))
    .join('')
}

function paragraphXmls(xml: string) {
  return [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
    .map((match) => match[0])
}

function hasActiveBold(xml: string) {
  return [...xml.matchAll(/<w:b\b([^>]*)\/>/g)]
    .some((match) => !/\bw:val="(?:0|false|off)"/i.test(match[1]))
}

function compactText(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\s\u00a0\u3000]+/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
}

function firstTag(xml: string, tag: string) {
  return xml.match(new RegExp(`<${tag}\\b[^>]*\\/?>`))?.[0] ?? ''
}

function integerAttribute(xml: string, name: string) {
  const match = xml.match(new RegExp(`${name}="(-?\\d+)"`))
  return match ? Number(match[1]) : null
}

function addIssue(issues: ComplianceOutputIssue[], issue: ComplianceOutputIssue) {
  if (!issues.some((existing) => existing.code === issue.code && existing.message === issue.message)) {
    issues.push(issue)
  }
}

function sha256(buffer: Buffer) {
  return import('node:crypto').then(({ createHash }) =>
    createHash('sha256').update(buffer).digest('hex'))
}

function orderedTextPresent(haystack: string, values: string[]) {
  let offset = 0
  for (const value of values) {
    const found = haystack.indexOf(value, offset)
    if (found < 0) return false
    offset = found + value.length
  }
  return true
}

function relationshipSourceDirectory(relationshipPartName: string) {
  if (relationshipPartName === '_rels/.rels') return ''
  const marker = '/_rels/'
  const markerIndex = relationshipPartName.lastIndexOf(marker)
  if (markerIndex < 0) return null
  return relationshipPartName.slice(0, markerIndex)
}

async function missingInternalRelationshipTargets(zip: JSZip) {
  const missing: Array<{ relationshipPart: string; target: string; resolvedTarget: string }> = []
  const relationshipParts = Object.keys(zip.files)
    .filter((name) => name.endsWith('.rels') && !zip.files[name].dir)
  for (const relationshipPart of relationshipParts) {
    const sourceDirectory = relationshipSourceDirectory(relationshipPart)
    if (sourceDirectory === null) continue
    const xml = await zip.file(relationshipPart)?.async('string') ?? ''
    for (const relationship of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const attributes = relationship[1]
      if (/\bTargetMode="External"/i.test(attributes)) continue
      const target = attributes.match(/\bTarget="([^"]+)"/i)?.[1]
      if (!target) continue
      const decodedTarget = decodeURIComponent(target.replace(/\\/g, '/'))
      const resolvedTarget = decodedTarget.startsWith('/')
        ? decodedTarget.slice(1)
        : path.posix.normalize(path.posix.join(sourceDirectory, decodedTarget))
      if (!zip.file(resolvedTarget)) {
        missing.push({ relationshipPart, target, resolvedTarget })
      }
    }
  }
  return missing
}

export async function reviewGeneratedComplianceDocx(input: {
  filePath: string
  template: AiTemplateDefinition
  blueprint: ComplianceDocumentBlueprint
  content: BusinessContent
  projectName: string
}): Promise<ComplianceOutputReview> {
  const issues: ComplianceOutputIssue[] = []
  const fileBuffer = await readFile(input.filePath)
  const fileStat = await stat(input.filePath)
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(fileBuffer)
  } catch {
    return {
      passed: false,
      issues: [{ code: 'DOCX_PACKAGE_INVALID', message: '文件不是有效DOCX OpenXML包' }],
      metadata: { bytes: fileStat.size },
    }
  }
  const documentPart = zip.file('word/document.xml')
  if (!documentPart) {
    return {
      passed: false,
      issues: [{ code: 'DOCX_PACKAGE_INVALID', message: 'DOCX缺少word/document.xml' }],
      metadata: { bytes: fileStat.size },
    }
  }
  const documentXml = await documentPart.async('string')
  const missingRelationshipTargets = await missingInternalRelationshipTargets(zip)
  if (missingRelationshipTargets.length) {
    addIssue(issues, {
      code: 'DOCX_PACKAGE_INVALID',
      message: `DOCX存在悬空内部关系：${missingRelationshipTargets
        .slice(0, 3)
        .map((item) => `${item.relationshipPart} -> ${item.resolvedTarget}`)
        .join('；')}`,
    })
  }
  const visibleText = xmlText(documentXml)
  const compact = compactText(visibleText)
  const paragraphs = paragraphXmls(documentXml)
  const paragraphTexts = paragraphs.map((paragraphXml) => xmlText(paragraphXml).trim())
  const sourceOutlinePrefix =
    /^\s*(?:[一二三四五六七八九十百]{1,4}\s*[、．]|[（(]\s*(?:[一二三四五六七八九十百]{1,4}|\d{1,2}|[A-Za-z])\s*[）)]|\d{1,3}\s*(?:[、．]|\.(?!\d)))/
  const leakedOutlineParagraphs = paragraphTexts.filter((value) => sourceOutlinePrefix.test(value))
  if (!visibleText || visibleText.includes('\uFFFD')) {
    addIssue(issues, {
      code: 'DOCX_TEXT_INVALID',
      message: 'DOCX无可编辑正文或包含损坏字符U+FFFD',
    })
  }
  const visualOutline = [
    input.content.title,
    '公司情况介绍',
    '公司简介',
    '核心团队',
    '产品及技术',
    '投资理由',
    '投资计划',
    '投资情形分析',
    '综上',
    input.blueprint.fixedContent.issuer,
  ].map(compactText)
  if (!orderedTextPresent(compact, visualOutline)) {
    addIssue(issues, {
      code: 'DOCX_STRUCTURE_MISMATCH',
      message: '标题、四段式章节、三个子节、综上结论或落款的顺序与Document Blueprint不一致',
    })
  }
  const visibleHeadingTexts = new Set(visualOutline.slice(0, 8))
  const bodyLabelParagraphs = paragraphTexts.filter((value) =>
    !visibleHeadingTexts.has(compactText(value))
    && /^[^，。；！？\n]{2,24}[：:]\s*\S/.test(value))
  if (bodyLabelParagraphs.length) {
    addIssue(issues, {
      code: 'DOCX_FORMAT_MISMATCH',
      message: `DOCX正文存在标签式小标题，应改为连续段落：${bodyLabelParagraphs.slice(0, 3).join('；')}`,
    })
  }
  const forbiddenParagraphs = new Set([
    '责任声明',
    '责任声明：',
    '风险提示',
    '资料缺口',
    '引用资料',
  ].map(compactText))
  const forbiddenStatusLabel = /【(?:资料记载|AI推断|待核验|资料缺口)】|待核验/
  if (
    forbiddenStatusLabel.test(visibleText)
    || paragraphTexts.some((value) => forbiddenParagraphs.has(compactText(value)))
    || compact.includes(compactText(input.template.disclaimer))
  ) {
    addIssue(issues, {
      code: 'DOCX_FORBIDDEN_CONTENT',
      message: 'DOCX正文不得包含状态标签、责任声明、风险提示、资料缺口、引用资料或审计免责声明板块',
    })
  }
  const runFontTags = [...documentXml.matchAll(/<w:rFonts\b[^>]*\/>/g)]
    .map((match) => match[0])
  const unexpectedRunFont = runFontTags.find((tag) => {
    const values = ['ascii', 'hAnsi', 'cs', 'eastAsia']
      .map((attribute) => tag.match(new RegExp(`w:${attribute}="([^"]+)"`))?.[1])
      .filter((value): value is string => Boolean(value))
    return values.some((value) => value !== 'Songti SC' && value !== 'STHeiti')
  })
  const titleParagraph = paragraphs.find((paragraphXml) =>
    compactText(xmlText(paragraphXml)) === compactText(input.content.title))
  const level1Paragraphs = ['公司情况介绍', '投资理由', '投资计划', '投资情形分析']
    .map((title) => paragraphs.find((paragraphXml) =>
      compactText(xmlText(paragraphXml)) === compactText(title)))
  const level2Paragraphs = ['公司简介', '核心团队', '产品及技术']
    .map((title) => paragraphs.find((paragraphXml) =>
      compactText(xmlText(paragraphXml)) === compactText(title)))
  const level1IndentValid = level1Paragraphs.every((paragraphXml) => {
    if (!paragraphXml) return false
    const indent = firstTag(paragraphXml, 'w:ind')
    return integerAttribute(indent, 'w:firstLine') === 0
      || integerAttribute(indent, 'w:firstLineChars') === 0
  })
  const level2IndentValid = level2Paragraphs.every((paragraphXml) => {
    if (!paragraphXml) return false
    const indent = firstTag(paragraphXml, 'w:ind')
    return integerAttribute(indent, 'w:left') === 0
      && integerAttribute(indent, 'w:firstLine') === 482
  })
  if (
    !runFontTags.length
    || unexpectedRunFont
    || !titleParagraph?.includes('w:eastAsia="STHeiti"')
    || !titleParagraph.includes('<w:sz w:val="28"/>')
    || hasActiveBold(titleParagraph)
    || level1Paragraphs.some((paragraphXml) => !paragraphXml || !hasActiveBold(paragraphXml))
    || level2Paragraphs.some((paragraphXml) => !paragraphXml || !hasActiveBold(paragraphXml))
    || !level1IndentValid
    || !level2IndentValid
  ) {
    addIssue(issues, {
      code: 'DOCX_FORMAT_MISMATCH',
      message: 'DOCX标题、一级/二级标题字形或编号缩进未满足核心规范',
    })
  }
  const pageSize = firstTag(documentXml, 'w:pgSz')
  const pageMargins = firstTag(documentXml, 'w:pgMar')
  const expectedPage = input.blueprint.primary.page
  if (
    integerAttribute(pageSize, 'w:w') !== expectedPage.widthDxa
    || integerAttribute(pageSize, 'w:h') !== expectedPage.heightDxa
    || integerAttribute(pageMargins, 'w:top') !== expectedPage.marginTopDxa
    || integerAttribute(pageMargins, 'w:right') !== expectedPage.marginRightDxa
    || integerAttribute(pageMargins, 'w:bottom') !== expectedPage.marginBottomDxa
    || integerAttribute(pageMargins, 'w:left') !== expectedPage.marginLeftDxa
  ) {
    addIssue(issues, {
      code: 'DOCX_PAGE_MISMATCH',
      message: '页面尺寸或页边距与模板Blueprint不一致',
    })
  }
  const partHashes: Record<string, string> = {}
  for (const [partName, expectedHash] of Object.entries(input.blueprint.primary.packageHashes)) {
    if (partName === 'word/numbering.xml' || partName === 'word/fontTable.xml') continue
    const part = zip.file(partName)
    if (!part) {
      addIssue(issues, {
        code: 'DOCX_TEMPLATE_PART_MISMATCH',
        message: `DOCX缺少模板保留部件${partName}`,
      })
      continue
    }
    const actualHash = await sha256(await part.async('nodebuffer'))
    partHashes[partName] = actualHash
    if (actualHash !== expectedHash) {
      addIssue(issues, {
        code: 'DOCX_TEMPLATE_PART_MISMATCH',
        message: `模板保留部件发生非预期变化：${partName}`,
      })
    }
  }
  const fontTableXml = await zip.file('word/fontTable.xml')?.async('string') ?? ''
  const fontTableRelationshipXml = await zip.file('word/_rels/fontTable.xml.rels')
    ?.async('string') ?? ''
  const fontEmbedRelationshipIds = [
    ...fontTableXml.matchAll(/<w:embed(?:Regular|Bold|Italic|BoldItalic)\b[^>]*\br:id="([^"]+)"/g),
  ].map((match) => match[1])
  const fontTableRelationshipIds = new Set(
    [...fontTableRelationshipXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"/g)]
      .map((match) => match[1]),
  )
  const missingFontEmbedRelationships = fontEmbedRelationshipIds
    .filter((id) => !fontTableRelationshipIds.has(id))
  if (missingFontEmbedRelationships.length) {
    addIssue(issues, {
      code: 'DOCX_PACKAGE_INVALID',
      message: `DOCX字体表引用了不存在的嵌入字体关系：${missingFontEmbedRelationships.join('、')}`,
    })
  }
  const fontFallbackAliasesValidated = [
    /<w:font w:name="宋体">[\s\S]*?<w:altName w:val="Songti SC"\/>/,
    /<w:font w:name="黑体">[\s\S]*?<w:altName w:val="STHeiti"\/>/,
    /<w:font w:name="Songti SC">[\s\S]*?<w:altName w:val="宋体"\/>/,
    /<w:font w:name="STHeiti">[\s\S]*?<w:altName w:val="黑体"\/>/,
  ].every((pattern) => pattern.test(fontTableXml))
  if (!fontFallbackAliasesValidated) {
    addIssue(issues, {
      code: 'DOCX_FORMAT_MISMATCH',
      message: 'DOCX字体表缺少宋体/黑体的macOS兼容回退映射',
    })
  }
  const numberingIds = [...documentXml.matchAll(/<w:numId w:val="(\d+)"\/>/g)]
    .map((match) => Number(match[1]))
  const numberingCount = (id: number) => numberingIds.filter((value) => value === id).length
  const numberingXml = await zip.file('word/numbering.xml')?.async('string') ?? ''
  if (
    ![1, 2].every((id) => numberingIds.includes(id))
    || numberingCount(1) !== 4
    || numberingCount(2) !== 3
    || numberingIds.some((id) => id !== 1 && id !== 2)
    || !numberingXml.includes('<w:numFmt w:val="chineseCounting"/>')
    || numberingXml.includes('<w:numFmt w:val="japaneseCounting"/>')
  ) {
    addIssue(issues, {
      code: 'DOCX_NUMBERING_MISMATCH',
      message: 'DOCX仅允许四个一级标题和三个二级标题使用编号，投资理由与合规核查必须使用连续正文段落',
    })
  }
  if (leakedOutlineParagraphs.length) {
    addIssue(issues, {
      code: 'DOCX_NUMBERING_MISMATCH',
      message: `正文残留来源材料编号：${leakedOutlineParagraphs.slice(0, 3).join('；')}`,
    })
  }
  const headerParts = Object.keys(zip.files).filter((name) => /^word\/header\d+\.xml$/.test(name))
  const footerParts = Object.keys(zip.files).filter((name) => /^word\/footer\d+\.xml$/.test(name))
  const tableCount = (documentXml.match(/<w:tbl\b/g) || []).length
  if (
    headerParts.length !== input.blueprint.primary.features.headerParts
    || footerParts.length !== input.blueprint.primary.features.footerParts
    || tableCount !== input.blueprint.primary.features.tableCount
  ) {
    addIssue(issues, {
      code: 'DOCX_UNEXPECTED_FEATURE',
      message: 'DOCX意外增加或删除了模板中的页眉、页脚或表格',
    })
  }
  const currentProjectName = input.projectName.replace(/项目$/, '')
  const forbiddenTemplateProject = input.blueprint.templates
    .flatMap((template) => template.templateProjectNames)
    .find((name) => name !== currentProjectName && compact.includes(compactText(name)))
  if (forbiddenTemplateProject) {
    addIssue(issues, {
      code: 'DOCX_TEXT_INVALID',
      message: `DOCX包含非当前项目的模板主体“${forbiddenTemplateProject}”`,
    })
  }
  return {
    passed: issues.length === 0,
    issues,
    metadata: {
      bytes: fileStat.size,
      sha256: await sha256(fileBuffer),
      editableText: true,
      blueprintSha256: input.blueprint.blueprintSha256,
      outlineValidated: !issues.some((issue) => issue.code === 'DOCX_STRUCTURE_MISMATCH'),
      forbiddenContentValidated: !issues.some((issue) => issue.code === 'DOCX_FORBIDDEN_CONTENT'),
      typographyValidated: !issues.some((issue) => issue.code === 'DOCX_FORMAT_MISMATCH'),
      fontFallbackAliasesValidated,
      fontEmbedRelationshipsValidated: missingFontEmbedRelationships.length === 0,
      pageSystemValidated: !issues.some((issue) => issue.code === 'DOCX_PAGE_MISMATCH'),
      templatePartsValidated: !issues.some((issue) => issue.code === 'DOCX_TEMPLATE_PART_MISMATCH'),
      numberingValidated: !issues.some((issue) => issue.code === 'DOCX_NUMBERING_MISMATCH'),
      preservedPartHashes: partHashes,
      relationshipClosureValidated: missingRelationshipTargets.length === 0,
    },
  }
}

async function runLibreOffice(docxPath: string, outputDirectory: string, profileDirectory: string) {
  const candidates = [
    process.env.AI_LIBREOFFICE_BIN,
    'soffice',
    'libreoffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ].filter((candidate): candidate is string => Boolean(candidate))
  let lastError: unknown
  const derivedFontconfigFiles = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(
      entry,
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
    ))
  const fontconfigFile = process.env.AI_FONTCONFIG_FILE
    || derivedFontconfigFiles.find((candidate) => existsSync(candidate))
  for (const binary of candidates) {
    try {
      await execFileAsync(binary, [
        '--headless',
        `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
        '--convert-to',
        'pdf',
        '--outdir',
        outputDirectory,
        docxPath,
      ], {
        timeout: 120000,
        env: {
          ...process.env,
          HOME: profileDirectory,
          TMPDIR: os.tmpdir(),
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
        maxBuffer: 4 * 1024 * 1024,
      })
      return binary
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error(`未找到可用的LibreOffice/soffice，无法生成PDF：${(lastError as Error)?.message ?? ''}`)
}

export async function convertComplianceDocxToPdf(input: {
  docxPath: string
  pdfPath: string
  fontFallback?: boolean
}) {
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'compliance-lo-profile-'))
  try {
    let conversionInput = input.docxPath
    let fontFallbacks: Record<string, string> = {}
    const applyFontFallback = input.fontFallback !== false
    if (applyFontFallback) {
      fontFallbacks = process.platform === 'darwin'
        ? {
            宋体: process.env.AI_PDF_SONG_FONT || 'Songti SC',
            黑体: process.env.AI_PDF_SANS_FONT || 'STHeiti',
          }
        : {
            宋体: process.env.AI_PDF_SONG_FONT || 'Noto Serif CJK SC',
            黑体: process.env.AI_PDF_SANS_FONT || 'Noto Sans CJK SC',
          }
      const zip = await JSZip.loadAsync(await readFile(input.docxPath))
      for (const name of Object.keys(zip.files).filter((entry) => /^word\/.*\.xml$/.test(entry))) {
        const part = zip.file(name)
        if (!part) continue
        let xml = await part.async('string')
        for (const [sourceFont, fallbackFont] of Object.entries(fontFallbacks)) {
          xml = xml.split(sourceFont).join(fallbackFont)
        }
        zip.file(name, xml)
      }
      conversionInput = path.join(profileDirectory, path.basename(input.docxPath))
      await writeFile(conversionInput, await zip.generateAsync({ type: 'nodebuffer' }))
    }
    const binary = await runLibreOffice(
      conversionInput,
      path.dirname(input.pdfPath),
      profileDirectory,
    )
    const generatedPath = path.join(
      path.dirname(input.pdfPath),
      `${path.basename(conversionInput, path.extname(conversionInput))}.pdf`,
    )
    if (path.resolve(generatedPath) !== path.resolve(input.pdfPath)) {
      await rename(generatedPath, input.pdfPath)
    }
    const pdfStat = await stat(input.pdfPath)
    if (!pdfStat.isFile() || pdfStat.size < 1000) {
      throw new Error('LibreOffice未生成有效PDF文件')
    }
    return {
      binary,
      bytes: pdfStat.size,
      fontFallbackApplied: applyFontFallback,
      fontFallbacks,
    }
  } finally {
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

async function extractPdfTextAndPages(buffer: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const document = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise
  const pages: string[] = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const textContent = await page.getTextContent()
    pages.push((textContent.items as { str?: string }[])
      .map((item) => item.str || '')
      .join(' ')
      .trim())
  }
  return {
    pageCount: document.numPages,
    text: pages.join('\n'),
  }
}

async function extractPdfTextWithPoppler(pdfPath: string) {
  const derivedCandidates = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) =>
      path.resolve(entry, '..', '..', 'native', 'poppler', 'poppler', 'bin', 'pdftotext'))
  const candidates = [...new Set([
    process.env.AI_PDFTOTEXT_BIN,
    'pdftotext',
    ...derivedCandidates,
  ].filter((candidate): candidate is string => Boolean(candidate)))]
  let lastError: unknown
  for (const binary of candidates) {
    try {
      const result = await execFileAsync(binary, [pdfPath, '-'], {
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
      })
      return { text: result.stdout, binary }
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
  }
  throw new Error(`无法调用pdftotext：${(lastError as Error)?.message ?? ''}`)
}

async function inspectPdfFontsWithPoppler(pdfPath: string) {
  const derivedCandidates = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) =>
      path.resolve(entry, '..', '..', 'native', 'poppler', 'poppler', 'bin', 'pdffonts'))
  const candidates = [...new Set([
    process.env.AI_PDFFONTS_BIN,
    'pdffonts',
    ...derivedCandidates,
  ].filter((candidate): candidate is string => Boolean(candidate)))]
  let lastError: unknown
  for (const binary of candidates) {
    try {
      const result = await execFileAsync(binary, [pdfPath], {
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
      })
      const names = result.stdout
        .split(/\r?\n/)
        .slice(2)
        .map((line) => line.trim().split(/\s+/)[0] ?? '')
        .filter(Boolean)
        .map((name) => name.replace(/^[A-Z]{6}\+/, ''))
      return { names: [...new Set(names)], binary }
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
  }
  throw new Error(`无法调用pdffonts：${(lastError as Error)?.message ?? ''}`)
}

function chineseBigrams(value: string) {
  const chinese = (value.match(/[\u3400-\u9fff]/g) || []).join('')
  const result = new Set<string>()
  for (let index = 0; index < chinese.length - 1; index += 1) {
    result.add(chinese.slice(index, index + 2))
  }
  return result
}

export async function reviewCompliancePdfAgainstDocx(input: {
  docxPath: string
  pdfPath: string
  template: AiTemplateDefinition
  blueprint: ComplianceDocumentBlueprint
  content: BusinessContent
}): Promise<ComplianceOutputReview> {
  const issues: ComplianceOutputIssue[] = []
  const [docxBuffer, pdfBuffer] = await Promise.all([
    readFile(input.docxPath),
    readFile(input.pdfPath),
  ])
  if (pdfBuffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return {
      passed: false,
      issues: [{ code: 'PDF_INVALID', message: '输出文件不是有效PDF' }],
      metadata: { bytes: pdfBuffer.length },
    }
  }
  const docxZip = await JSZip.loadAsync(docxBuffer)
  const documentXml = await docxZip.file('word/document.xml')?.async('string') ?? ''
  const docxText = xmlText(documentXml)
  let extracted: { pageCount: number; text: string }
  try {
    extracted = await extractPdfTextAndPages(pdfBuffer)
  } catch (error) {
    return {
      passed: false,
      issues: [{
        code: 'PDF_INVALID',
        message: `PDF文本层或页面结构无法读取：${(error as Error).message}`,
      }],
      metadata: { bytes: pdfBuffer.length },
    }
  }
  let textExtractor = 'pdfjs'
  if (chineseBigrams(extracted.text).size < chineseBigrams(docxText).size * 0.5) {
    try {
      const poppler = await extractPdfTextWithPoppler(input.pdfPath)
      if (chineseBigrams(poppler.text).size > chineseBigrams(extracted.text).size) {
        extracted.text = poppler.text
        textExtractor = poppler.binary
      }
    } catch (error) {
      console.warn('[aiComplianceOutput] pdftotext兜底不可用：', (error as Error).message)
    }
  }
  const pdfCompact = compactText(extracted.text)
  const requiredText = [
    input.content.title,
    '公司情况介绍',
    '公司简介',
    '核心团队',
    '产品及技术',
    '投资理由',
    '投资计划',
    '投资情形分析',
    '综上',
    input.blueprint.fixedContent.issuer,
  ]
  const missingRequired = requiredText.filter((value) =>
    !pdfCompact.includes(compactText(value)))
  if (missingRequired.length) {
    addIssue(issues, {
      code: 'PDF_TEXT_MISMATCH',
      message: `PDF缺少Word中的固定结构或内容：${missingRequired.slice(0, 5).join('、')}`,
    })
  }
  const forbiddenPdfValues = [
    input.template.disclaimer,
    '责任声明：',
    '风险提示',
    '资料缺口',
    '引用资料',
    '【资料记载】',
    '【AI推断】',
    '【待核验】',
    '【资料缺口】',
  ]
  const visibleForbidden = forbiddenPdfValues.filter((value) =>
    pdfCompact.includes(compactText(value)))
  if (visibleForbidden.length) {
    addIssue(issues, {
      code: 'PDF_FORBIDDEN_CONTENT',
      message: `PDF正文包含禁止渲染的审计内容：${visibleForbidden.slice(0, 5).join('、')}`,
    })
  }
  const visibleOutlineNumbers = [
    ['一、公司情况介绍'],
    ['（1）公司简介', '(1)公司简介'],
    ['（2）核心团队', '(2)核心团队'],
    ['（3）产品及技术', '(3)产品及技术'],
    ['二、投资理由'],
    ['三、投资计划'],
    ['四、投资情形分析'],
  ]
  const missingOutlineNumbers = visibleOutlineNumbers.filter((variants) =>
    !variants.some((value) => pdfCompact.includes(compactText(value))))
  const reasonStart = pdfCompact.indexOf(compactText('二、投资理由'))
  const reasonEnd = pdfCompact.indexOf(compactText('三、投资计划'), reasonStart + 1)
  const reasonSegment = reasonStart >= 0 && reasonEnd > reasonStart
    ? pdfCompact.slice(reasonStart, reasonEnd)
    : ''
  const missingReasonNumbers = [1, 2, 3, 4, 5]
    .filter((index) => !reasonSegment.includes(`${index}、`))
    .map((index) => `${index}、投资理由`)
  const numberedAnalysisKeywords = [
    '投资方式',
    '返投',
    '关联交易',
    '投资方向',
    '投资配置',
    '投资集中度',
    '其他法律法规',
  ]
  const missingAnalysisNumbers = numberedAnalysisKeywords.flatMap((keyword, index) => {
    const prefix = `${index + 1}、`
    const keywordOffset = pdfCompact.indexOf(keyword)
    const prefixOffset = keywordOffset >= 0
      ? pdfCompact.lastIndexOf(prefix, keywordOffset)
      : -1
    return prefixOffset >= 0
      && keywordOffset >= 0
      && keywordOffset - prefixOffset < 80
      ? []
      : [`${prefix}${keyword}`]
  })
  if (missingOutlineNumbers.length || missingReasonNumbers.length || missingAnalysisNumbers.length) {
    addIssue(issues, {
      code: 'PDF_NUMBERING_MISMATCH',
      message: `PDF可见编号与模板不一致：${[
        ...missingOutlineNumbers.map((variants) => variants[0]),
        ...missingReasonNumbers,
        ...missingAnalysisNumbers,
      ].slice(0, 8).join('、')}`,
    })
  }
  const docxNumbers = [...new Set(
    [...docxText.matchAll(/\d+(?:[.,]\d+)*(?:%|％)?/g)]
      .map((match) => match[0].replace(/,/g, '')),
  )]
  const pdfNumberText = pdfCompact.replace(/,/g, '')
  const missingNumbers = docxNumbers.filter((number) => !pdfNumberText.includes(number))
  if (missingNumbers.length) {
    addIssue(issues, {
      code: 'PDF_TEXT_MISMATCH',
      message: `PDF文本层缺少Word中的数字：${missingNumbers.slice(0, 8).join('、')}`,
    })
  }
  const docxGrams = chineseBigrams(docxText)
  const pdfGrams = chineseBigrams(extracted.text)
  const overlap = [...docxGrams].filter((gram) => pdfGrams.has(gram)).length
  const coverage = docxGrams.size ? overlap / docxGrams.size : 1
  if (coverage < 0.92) {
    addIssue(issues, {
      code: 'PDF_CONTENT_COVERAGE',
      message: `PDF与Word中文文本覆盖率仅为${(coverage * 100).toFixed(1)}%`,
    })
  }
  let pdfFontNames: string[] = []
  let fontExtractor = ''
  try {
    const fontAudit = await inspectPdfFontsWithPoppler(input.pdfPath)
    pdfFontNames = fontAudit.names
    fontExtractor = fontAudit.binary
    const cjkFontPattern = /(?:CJK|SourceHan|Songti|Heiti|Hiragino|SimSun|SimHei|YaHei|KaiTi|FangSong|ArialUnicode)/i
    if (chineseBigrams(docxText).size && !pdfFontNames.some((name) => cjkFontPattern.test(name))) {
      addIssue(issues, {
        code: 'PDF_FONT_MISSING',
        message: `PDF未检测到可识别的中文字体，实际字体为：${pdfFontNames.slice(0, 8).join('、') || '未知'}`,
      })
    }
  } catch (error) {
    console.warn('[aiComplianceOutput] pdffonts字体审核不可用：', (error as Error).message)
  }
  return {
    passed: issues.length === 0,
    issues,
    metadata: {
      bytes: pdfBuffer.length,
      sha256: await sha256(pdfBuffer),
      pageCount: extracted.pageCount,
      textLayerValidated: extracted.text.length > 100,
      textExtractor,
      requiredContentValidated: missingRequired.length === 0,
      forbiddenContentValidated: visibleForbidden.length === 0,
      numericContentValidated: missingNumbers.length === 0,
      visibleNumberingValidated: !issues.some((issue) =>
        issue.code === 'PDF_NUMBERING_MISMATCH'),
      cjkFontValidated: !issues.some((issue) => issue.code === 'PDF_FONT_MISSING'),
      pdfFontNames,
      fontExtractor,
      docxTextCoverage: coverage,
      derivedFrom: path.basename(input.docxPath),
    },
  }
}
