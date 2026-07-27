import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'

const REQUIRED_SECTION_TREE = [
  {
    title: '公司情况介绍',
    level: 1,
    children: ['公司简介', '核心团队', '产品及技术'],
  },
  { title: '投资理由', level: 1, children: [] },
  { title: '投资计划', level: 1, children: [] },
  { title: '投资情形分析', level: 1, children: [] },
] as const

export const COMPLIANCE_MISSING_DATA_SENTENCE = '当前项目暂无相关资料。'

export type ComplianceParagraphFingerprint = {
  paragraphIndex: number
  styleId: string
  fontEastAsia: string
  fontSizeHalfPoints: number | null
  bold: boolean
  alignment: string
  spacingBefore: number | null
  spacingAfter: number | null
  spacingLine: number | null
  firstLineIndent: number | null
  leftIndent: number | null
  numberingId: number | null
  numberingLevel: number | null
}

export type ComplianceTemplateBlueprint = {
  path: string
  fileName: string
  sha256: string
  packageHashes: Record<string, string>
  page: {
    widthDxa: number
    heightDxa: number
    orientation: 'portrait' | 'landscape'
    marginTopDxa: number
    marginRightDxa: number
    marginBottomDxa: number
    marginLeftDxa: number
    headerDistanceDxa: number
    footerDistanceDxa: number
    sectionCount: number
    renderedPageCountHint: number
  }
  features: {
    tocPresent: boolean
    tableCount: number
    headerParts: number
    footerParts: number
    explicitPageBreaks: number
    fieldInstructions: string[]
  }
  title: string
  issuer: string
  dateText: string
  sectionTitles: string[]
  paragraphRoles: {
    title: ComplianceParagraphFingerprint
    level1: ComplianceParagraphFingerprint
    level2: ComplianceParagraphFingerprint
    body: ComplianceParagraphFingerprint
    numberedBody: ComplianceParagraphFingerprint
    issuer: ComplianceParagraphFingerprint
  }
  templateProjectNames: string[]
  templateParagraphs: string[]
}

export type ComplianceDocumentBlueprint = {
  kind: 'compliance-statement'
  version: 1
  blueprintSha256: string
  primary: ComplianceTemplateBlueprint
  templates: ComplianceTemplateBlueprint[]
  sectionTree: Array<{
    title: string
    level: 1
    children: string[]
  }>
  logicalSections: string[]
  fixedContent: {
    titlePattern: string
    conclusionLead: '综上'
    issuer: string
    missingDataSentence: typeof COMPLIANCE_MISSING_DATA_SENTENCE
  }
}

type ParsedParagraph = {
  index: number
  text: string
  xml: string
  fingerprint: ComplianceParagraphFingerprint
}

const blueprintCache = new Map<string, Promise<ComplianceDocumentBlueprint>>()

function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex')
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

function integerAttribute(xml: string, name: string) {
  const match = xml.match(new RegExp(`${name}="(-?\\d+)"`))
  return match ? Number(match[1]) : null
}

function stringAttribute(xml: string, name: string) {
  return xml.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? ''
}

function firstTag(xml: string, tag: string) {
  return xml.match(new RegExp(`<${tag}\\b[^>]*\\/?>`))?.[0] ?? ''
}

function paragraphText(xml: string) {
  const tokens = [...xml.matchAll(/<w:(t|tab|br)\b[^>]*>([\s\S]*?)<\/w:\1>|<w:(tab|br)\b[^>]*\/>/g)]
  return tokens.map((match) => {
    const tag = match[1] || match[3]
    if (tag === 'tab') return '\t'
    if (tag === 'br') return '\n'
    return decodeXml(match[2].replace(/<[^>]+>/g, ''))
  }).join('').replace(/\s+/g, ' ').trim()
}

function fingerprintParagraph(xml: string, paragraphIndex: number): ComplianceParagraphFingerprint {
  const paragraphProperties = xml.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/)?.[0] ?? ''
  const firstRunProperties = xml.match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/)?.[0] ?? ''
  const styleTag = firstTag(paragraphProperties, 'w:pStyle')
  const fontsTag = firstTag(firstRunProperties, 'w:rFonts')
  const sizeTag = firstTag(firstRunProperties, 'w:sz')
  const justificationTag = firstTag(paragraphProperties, 'w:jc')
  const spacingTag = firstTag(paragraphProperties, 'w:spacing')
  const indentTag = firstTag(paragraphProperties, 'w:ind')
  const numbering = paragraphProperties.match(/<w:numPr\b[^>]*>[\s\S]*?<\/w:numPr>/)?.[0] ?? ''
  const numberingIdTag = firstTag(numbering, 'w:numId')
  const numberingLevelTag = firstTag(numbering, 'w:ilvl')
  const boldTag = firstTag(firstRunProperties, 'w:b')
  const boldValue = boldTag ? stringAttribute(boldTag, 'w:val') : ''
  return {
    paragraphIndex,
    styleId: stringAttribute(styleTag, 'w:val'),
    fontEastAsia: stringAttribute(fontsTag, 'w:eastAsia'),
    fontSizeHalfPoints: integerAttribute(sizeTag, 'w:val'),
    bold: Boolean(boldTag) && !['0', 'false', 'off'].includes(boldValue),
    alignment: stringAttribute(justificationTag, 'w:val'),
    spacingBefore: integerAttribute(spacingTag, 'w:before'),
    spacingAfter: integerAttribute(spacingTag, 'w:after'),
    spacingLine: integerAttribute(spacingTag, 'w:line'),
    firstLineIndent: integerAttribute(indentTag, 'w:firstLine'),
    leftIndent: integerAttribute(indentTag, 'w:left'),
    numberingId: integerAttribute(numberingIdTag, 'w:val'),
    numberingLevel: integerAttribute(numberingLevelTag, 'w:val'),
  }
}

function parseParagraphs(documentXml: string): ParsedParagraph[] {
  return [...documentXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
    .map((match, index) => ({
      index,
      text: paragraphText(match[0]),
      xml: match[0],
      fingerprint: fingerprintParagraph(match[0], index),
    }))
}

function requireParagraph(
  paragraphs: ParsedParagraph[],
  predicate: (paragraph: ParsedParagraph) => boolean,
  description: string,
) {
  const paragraph = paragraphs.find(predicate)
  if (!paragraph) throw new Error(`合规模板无法建立 Document Blueprint：缺少${description}`)
  return paragraph
}

function templateProjectNames(title: string) {
  const match = title.match(/^关于(.+?)项目投资合规性的说明$/)
  return match?.[1] ? [match[1].trim()] : []
}

async function parseTemplate(templatePath: string): Promise<ComplianceTemplateBlueprint> {
  const buffer = await readFile(templatePath)
  const zip = await JSZip.loadAsync(buffer)
  const documentPart = zip.file('word/document.xml')
  if (!documentPart) throw new Error(`合规模板缺少 word/document.xml：${path.basename(templatePath)}`)
  const documentXml = await documentPart.async('string')
  const paragraphs = parseParagraphs(documentXml)
  const visible = paragraphs.filter((paragraph) => paragraph.text)
  const title = requireParagraph(
    visible,
    (paragraph) => /^关于.+项目投资合规性的说明$/.test(paragraph.text),
    '文档标题',
  )
  const sectionParagraphs = REQUIRED_SECTION_TREE.map((section) =>
    requireParagraph(visible, (paragraph) => paragraph.text === section.title, `章节“${section.title}”`))
  const level2 = requireParagraph(visible, (paragraph) => paragraph.text === '公司简介', '二级标题“公司简介”')
  const firstBody = requireParagraph(
    visible,
    (paragraph) => paragraph.index > level2.index
      && !REQUIRED_SECTION_TREE.some((section) => section.title === paragraph.text)
      && !REQUIRED_SECTION_TREE[0].children.includes(paragraph.text as never),
    '正文样例段落',
  )
  const numberedBody = requireParagraph(
    visible,
    (paragraph) => paragraph.text.length > 20
      && (
        paragraph.fingerprint.numberingId !== null
        || /^\s*\d+[、.．]\s*/.test(paragraph.text)
      ),
    '编号正文样例段落',
  )
  const conclusion = requireParagraph(
    visible,
    (paragraph) => paragraph.text.startsWith('综上'),
    '“综上”结论',
  )
  const issuer = requireParagraph(
    visible,
    (paragraph) => paragraph.index > conclusion.index && /公司$/.test(paragraph.text),
    '落款机构',
  )
  const date = requireParagraph(
    visible,
    (paragraph) => paragraph.index > issuer.index
      && /\d{4}\s*年.*\d{1,2}\s*月.*\d{1,2}\s*日/.test(paragraph.text),
    '落款日期',
  )
  const pageSize = firstTag(documentXml, 'w:pgSz')
  const pageMargins = firstTag(documentXml, 'w:pgMar')
  const widthDxa = integerAttribute(pageSize, 'w:w')
  const heightDxa = integerAttribute(pageSize, 'w:h')
  const marginTopDxa = integerAttribute(pageMargins, 'w:top')
  const marginRightDxa = integerAttribute(pageMargins, 'w:right')
  const marginBottomDxa = integerAttribute(pageMargins, 'w:bottom')
  const marginLeftDxa = integerAttribute(pageMargins, 'w:left')
  if (
    widthDxa === null
    || heightDxa === null
    || marginTopDxa === null
    || marginRightDxa === null
    || marginBottomDxa === null
    || marginLeftDxa === null
  ) {
    throw new Error(`合规模板页面参数不完整：${path.basename(templatePath)}`)
  }
  const fieldInstructions = [...documentXml.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)]
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean)
  const headerParts = Object.keys(zip.files).filter((name) => /^word\/header\d+\.xml$/.test(name)).length
  const footerParts = Object.keys(zip.files).filter((name) => /^word\/footer\d+\.xml$/.test(name)).length
  const packagePartNames = [
    'word/styles.xml',
    'word/stylesWithEffects.xml',
    'word/numbering.xml',
    'word/theme/theme1.xml',
    'word/fontTable.xml',
  ]
  const packageHashes: Record<string, string> = {}
  for (const partName of packagePartNames) {
    const part = zip.file(partName)
    if (part) packageHashes[partName] = sha256(await part.async('nodebuffer'))
  }
  const structuralText = new Set([
    title.text,
    issuer.text,
    date.text,
    conclusion.text,
    ...REQUIRED_SECTION_TREE.flatMap((section) => [section.title, ...section.children]),
  ])
  return {
    path: templatePath,
    fileName: path.basename(templatePath),
    sha256: sha256(buffer),
    packageHashes,
    page: {
      widthDxa,
      heightDxa,
      orientation: stringAttribute(pageSize, 'w:orient') === 'landscape' ? 'landscape' : 'portrait',
      marginTopDxa,
      marginRightDxa,
      marginBottomDxa,
      marginLeftDxa,
      headerDistanceDxa: integerAttribute(pageMargins, 'w:header') ?? 0,
      footerDistanceDxa: integerAttribute(pageMargins, 'w:footer') ?? 0,
      sectionCount: (documentXml.match(/<w:sectPr\b/g) || []).length,
      renderedPageCountHint: (documentXml.match(/<w:lastRenderedPageBreak\/>/g) || []).length + 1,
    },
    features: {
      tocPresent: fieldInstructions.some((instruction) => /\bTOC\b/i.test(instruction)),
      tableCount: (documentXml.match(/<w:tbl\b/g) || []).length,
      headerParts,
      footerParts,
      explicitPageBreaks: (documentXml.match(/<w:br\b[^>]*w:type="page"[^>]*\/>/g) || []).length,
      fieldInstructions,
    },
    title: title.text,
    issuer: issuer.text,
    dateText: date.text,
    sectionTitles: sectionParagraphs.map((paragraph) => paragraph.text),
    paragraphRoles: {
      title: title.fingerprint,
      level1: sectionParagraphs[0].fingerprint,
      level2: level2.fingerprint,
      body: firstBody.fingerprint,
      numberedBody: numberedBody.fingerprint,
      issuer: issuer.fingerprint,
    },
    templateProjectNames: templateProjectNames(title.text),
    templateParagraphs: visible
      .map((paragraph) => paragraph.text)
      .filter((text) => text.length >= 28 && !structuralText.has(text)),
  }
}

function samePageSystem(left: ComplianceTemplateBlueprint, right: ComplianceTemplateBlueprint) {
  return [
    'widthDxa',
    'heightDxa',
    'orientation',
    'marginTopDxa',
    'marginRightDxa',
    'marginBottomDxa',
    'marginLeftDxa',
  ].every((key) =>
    left.page[key as keyof ComplianceTemplateBlueprint['page']]
      === right.page[key as keyof ComplianceTemplateBlueprint['page']])
}

async function createBlueprint(template: AiTemplateDefinition): Promise<ComplianceDocumentBlueprint> {
  if (template.type !== 'compliance_statement') {
    throw new Error('Document Blueprint 解析器仅适用于合规性说明')
  }
  const templatePaths = [...new Set([
    template.referencePath,
    ...(template.referencePaths ?? []),
  ])]
  const templates = await Promise.all(templatePaths.map(parseTemplate))
  const primary = templates[0]
  for (const candidate of templates.slice(1)) {
    if (!samePageSystem(primary, candidate)) {
      throw new Error(`合规模板页面系统不一致：${primary.fileName} / ${candidate.fileName}`)
    }
    if (candidate.sectionTitles.join('\n') !== primary.sectionTitles.join('\n')) {
      throw new Error(`合规模板章节树不一致：${primary.fileName} / ${candidate.fileName}`)
    }
  }
  const logicalSections = template.sections.slice()
  const fingerprintSource = JSON.stringify({
    templateVersion: template.templateVersion,
    templateHashes: templates.map((item) => item.sha256),
    page: primary.page,
    sectionTree: REQUIRED_SECTION_TREE,
    logicalSections,
    disclaimer: template.disclaimer,
  })
  return {
    kind: 'compliance-statement',
    version: 1,
    blueprintSha256: sha256(fingerprintSource),
    primary,
    templates,
    sectionTree: REQUIRED_SECTION_TREE.map((section) => ({
      title: section.title,
      level: section.level,
      children: [...section.children],
    })),
    logicalSections,
    fixedContent: {
      titlePattern: '关于{项目名称}项目投资合规性的说明',
      conclusionLead: '综上',
      issuer: primary.issuer,
      missingDataSentence: COMPLIANCE_MISSING_DATA_SENTENCE,
    },
  }
}

export function parseComplianceDocumentBlueprint(template: AiTemplateDefinition) {
  const key = [
    template.templateVersion,
    template.referencePath,
    ...(template.referencePaths ?? []),
    template.disclaimer,
  ].join('|')
  let cached = blueprintCache.get(key)
  if (!cached) {
    cached = createBlueprint(template)
    blueprintCache.set(key, cached)
  }
  return cached
}

export function complianceBlueprintMetadata(blueprint: ComplianceDocumentBlueprint) {
  return {
    blueprintVersion: blueprint.version,
    blueprintSha256: blueprint.blueprintSha256,
    templateCount: blueprint.templates.length,
    templateHashes: blueprint.templates.map((item) => ({
      fileName: item.fileName,
      sha256: item.sha256,
    })),
    sectionTree: blueprint.sectionTree,
    page: blueprint.primary.page,
    features: blueprint.primary.features,
  }
}
