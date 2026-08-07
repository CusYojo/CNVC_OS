import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  LineRuleType,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx'
import JSZip from 'jszip'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type BusinessContent,
  type BusinessFinding,
  type BusinessTable,
  type EvidenceSource,
} from './aiBusinessContentService.js'
import {
  loadInvestmentProposalBlueprint,
  type InvestmentProposalDocumentBlueprint,
} from './aiInvestmentProposalBlueprintService.js'
import { containsInvestmentProposalInternalErrorText } from './aiInvestmentProposalReviewerService.js'
import {
  containsInvestmentProposalAbnormalSpacing,
  containsInvestmentProposalAiStyleBoilerplate,
  containsInvestmentProposalColonLabel,
  containsInvestmentProposalConversationalWording,
  containsInvestmentProposalFormulaicAnalysisWrapper,
  containsInvestmentProposalGenericNoDataPreface,
  containsInvestmentProposalInlineSubheading,
  containsInvestmentProposalLongQuotedExcerpt,
  containsInvestmentProposalProseLabel,
  containsInvestmentProposalSourceProcessWording,
  containsInvestmentProposalWebArtifact,
  sanitizeInvestmentProposalClientText,
} from './aiInvestmentProposalTextService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'
import { getAiSkillDirectory } from './aiSkillService.js'

type ProjectLike = {
  name: string
  companyName?: string | null
}

// DOCX 写入 Office/WPS 通用中文字体名，避免同一份文件因生成服务器平台不同
// 而混入 Songti SC、STHeiti 等平台字体元数据。
const SANS_FONT = process.env.AI_DOCUMENT_SANS_FONT || '黑体'
const SONG_FONT = process.env.AI_DOCUMENT_SONG_FONT || '宋体'
const FANGSONG_FONT = process.env.AI_DOCUMENT_FANGSONG_FONT || '仿宋'
const KAITI_FONT = process.env.AI_DOCUMENT_KAITI_FONT || '楷体'
const NUMBER_FONT = 'Times New Roman'
const PROPOSAL_SKILL_NAME = 'draft-investment-proposal' as const
const PROPOSAL_STYLE = {
  title: '82',
  heading1: '78',
  heading2: '85',
  body: '90',
  gridTable: '97',
  threeLineTable: 'ProposalThreeLine',
} as const

const font = (eastAsia: string) => ({
  ascii: eastAsia,
  hAnsi: eastAsia,
  cs: eastAsia,
  eastAsia,
})

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

function findingParagraph(finding: BusinessFinding) {
  const text = sanitizeInvestmentProposalClientText(finding.text)
  return new Paragraph({
    style: PROPOSAL_STYLE.body,
    spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
    indent: { firstLine: 480 },
    alignment: AlignmentType.JUSTIFIED,
    keepLines: true,
    children: [
      new TextRun({
        text,
        size: 24,
        color: '000000',
        font: font(FANGSONG_FONT),
      }),
    ],
  })
}

function tableTextWidth(value: string) {
  return [...value].reduce((width, character) =>
    width + (/[\u3400-\u9FFF]/.test(character) ? 2 : 1), 0)
}

function tableColumnWidths(table: BusinessTable) {
  const totalWidth = 8306
  const columnCount = table.columns.length
  const minimum = columnCount >= 6 ? 720 : columnCount === 5 ? 820 : 980
  const narrativeHeader = /备注|说明|要求|依据|用途|投资方|股东姓名|股东名称|事项/
  const compactHeader = /序号|日期|时间|年度|年份|期间|轮次|比例|股比|金额|估值|倍数|状态|A\/E/i
  const weights = table.columns.map((header, index) => {
    const contentWidth = Math.max(
      tableTextWidth(header) * 1.2,
      ...table.rows.map((row) => Math.min(36, tableTextWidth(row[index] ?? ''))),
    )
    const semanticWeight = narrativeHeader.test(header)
      ? 1.45
      : compactHeader.test(header)
        ? 0.78
        : 1
    return Math.max(4, contentWidth * semanticWeight)
  })
  const remaining = totalWidth - minimum * columnCount
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)
  const widths = weights.map((weight) =>
    minimum + Math.floor(remaining * weight / weightTotal))
  widths[widths.length - 1] += totalWidth - widths.reduce((sum, width) => sum + width, 0)
  return widths
}

function isThreeLineProposalTable(sectionTitle: string, tableTitle: string) {
  return /财务|经营|收入|利润|现金|预测|回报|退出|可比/.test(
    `${sectionTitle}${tableTitle}`,
  )
}

function proposalTable(table: BusinessTable, sectionTitle: string) {
  const widths = tableColumnWidths(table)
  const threeLine = isThreeLineProposalTable(sectionTitle, table.title)
  const centeredColumn = (index: number) =>
    /序号|日期|时间|年度|年份|期间|轮次|状态|A\/E/i
      .test(table.columns[index] ?? '')
  const numericValue = (value: string, index: number) =>
    /比例|股比|金额|估值|倍数|收入|利润|成本|现金|MOIC|IRR|PS|PE/i
      .test(table.columns[index] ?? '')
    || /(?:\d[\d,.]*\s*(?:%|倍|万元|亿元|元|万|亿))$/i.test(value.trim())
  const cell = (value: string, index: number, header = false, last = false) => new TableCell({
    width: { size: widths[index], type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 0, right: 108, bottom: 0, left: 108 },
    shading: header && !threeLine
      ? { fill: 'C0C0C0', type: ShadingType.CLEAR, color: 'auto' }
      : undefined,
    borders: threeLine
      ? {
          top: header
            ? { style: BorderStyle.SINGLE, size: 12, color: '000000' }
            : { style: BorderStyle.NONE, size: 0, color: '000000' },
          bottom: header
            ? { style: BorderStyle.SINGLE, size: 4, color: '000000' }
            : last
              ? { style: BorderStyle.SINGLE, size: 12, color: '000000' }
              : { style: BorderStyle.NONE, size: 0, color: '000000' },
          left: { style: BorderStyle.NONE, size: 0, color: '000000' },
          right: { style: BorderStyle.NONE, size: 0, color: '000000' },
        }
      : undefined,
    children: [new Paragraph({
      alignment: header
        ? AlignmentType.CENTER
        : numericValue(value, index)
          ? AlignmentType.RIGHT
          : centeredColumn(index)
            ? AlignmentType.CENTER
            : AlignmentType.LEFT,
      spacing: { before: 0, after: 0, line: 300, lineRule: LineRuleType.AT_LEAST },
      keepLines: true,
      children: [new TextRun({
        text: sanitizeInvestmentProposalClientText(value),
        bold: header,
        size: 21,
        color: '000000',
        font: font(header ? SONG_FONT : FANGSONG_FONT),
      })],
    })],
  })
  return [
    new Paragraph({
      style: PROPOSAL_STYLE.body,
      keepNext: true,
      spacing: { before: 80, after: 60, line: 480, lineRule: LineRuleType.EXACT },
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: `${sanitizeInvestmentProposalClientText(table.title)}${
          table.unit && table.unit !== '无' ? `（单位：${table.unit}）` : ''
        }`,
        bold: true,
        size: 24,
        color: '000000',
        font: font(FANGSONG_FONT),
      })],
    }),
    new Table({
      style: threeLine ? PROPOSAL_STYLE.threeLineTable : PROPOSAL_STYLE.gridTable,
      width: { size: 8306, type: WidthType.DXA },
      columnWidths: widths,
      alignment: AlignmentType.CENTER,
      indent: { size: 0, type: WidthType.DXA },
      margins: { top: 0, right: 108, bottom: 0, left: 108 },
      layout: TableLayoutType.FIXED,
      borders: threeLine
        ? {
            top: { style: BorderStyle.NONE, size: 0, color: '000000' },
            bottom: { style: BorderStyle.NONE, size: 0, color: '000000' },
            left: { style: BorderStyle.NONE, size: 0, color: '000000' },
            right: { style: BorderStyle.NONE, size: 0, color: '000000' },
            insideHorizontal: { style: BorderStyle.NONE, size: 0, color: '000000' },
            insideVertical: { style: BorderStyle.NONE, size: 0, color: '000000' },
          }
        : {
            top: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
            left: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
            right: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
            insideVertical: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
          },
      rows: [
        new TableRow({
          tableHeader: true,
          cantSplit: true,
          children: table.columns.map((value, index) => cell(value, index, true)),
        }),
        ...table.rows.map((row, rowIndex) => new TableRow({
          cantSplit: true,
          children: row.map((value, index) =>
            cell(value, index, false, rowIndex === table.rows.length - 1)),
        })),
      ],
    }),
    new Paragraph({
      style: PROPOSAL_STYLE.body,
      spacing: { before: 0, after: 80, line: 120, lineRule: LineRuleType.EXACT },
      children: [],
    }),
  ]
}

function headingParagraph(title: string, level: 1 | 2 | 3, pageBreakBefore: boolean) {
  const headingFont = level === 1 ? SANS_FONT : level === 2 ? KAITI_FONT : FANGSONG_FONT
  return new Paragraph({
    style: level === 1 ? PROPOSAL_STYLE.heading1 : PROPOSAL_STYLE.heading2,
    pageBreakBefore,
    keepNext: true,
    keepLines: true,
    spacing: {
      before: 0,
      after: 0,
      line: 480,
      lineRule: LineRuleType.EXACT,
    },
    children: [new TextRun({
      text: title,
      size: level === 3 ? 24 : 28,
      bold: level === 1 || level === 3,
      font: font(headingFont),
      color: '000000',
    })],
  })
}

function secondaryThreeLineStyle(stylesXml: string) {
  const style = stylesXml.match(
    /<w:style\b(?=[^>]*w:type="table")(?=[^>]*w:styleId="11")[\s\S]*?<\/w:style>/,
  )?.[0]
  if (!style) throw new Error('投资提案次版式权威缺少三线表样式')
  return style
    .replace(/\s+w:default="1"/, '')
    .replace('w:styleId="11"', `w:styleId="${PROPOSAL_STYLE.threeLineTable}"`)
    .replace(/<w:name\b[^>]*\/>/, '<w:name w:val="Proposal Three Line"/>')
}

async function applyInvestmentProposalLayoutAuthority(buffer: Buffer) {
  const skillDirectory = getAiSkillDirectory(PROPOSAL_SKILL_NAME)
  const primaryPath = path.join(skillDirectory, 'assets', 'primary-layout-authority.docx')
  const secondaryPath = path.join(skillDirectory, 'assets', 'secondary-layout-authority.docx')
  const [target, primary, secondary] = await Promise.all([
    JSZip.loadAsync(buffer),
    JSZip.loadAsync(await readFile(primaryPath)),
    JSZip.loadAsync(await readFile(secondaryPath)),
  ])
  const primaryStyles = await primary.file('word/styles.xml')?.async('string')
  const secondaryStyles = await secondary.file('word/styles.xml')?.async('string')
  if (!primaryStyles || !secondaryStyles) {
    throw new Error('投资提案版式权威缺少 styles.xml')
  }
  const mergedStyles = primaryStyles.replace(
    '</w:styles>',
    `${secondaryThreeLineStyle(secondaryStyles)}</w:styles>`,
  )
  target.file('word/styles.xml', mergedStyles)

  const targetDocumentXml = await target.file('word/document.xml')?.async('string')
  if (!targetDocumentXml) throw new Error('投资提案成品缺少 document.xml')
  // 主版式权威的一、二级样式自带自动编号，而 17 节 Blueprint
  // 标题文本已包含编号。在段落级显式关闭样式编号，避免渲染为
  // “一、 一、基本情况简介”或“（一） （一）公司简介”。
  const documentWithoutDuplicateNumbering = targetDocumentXml.replace(
    /(<w:pPr(?:\s[^>]*)?>\s*<w:pStyle\b(?=[^>]*w:val="(?:78|85)")[^>]*\/>)/g,
    '$1<w:numPr><w:numId w:val="0"/></w:numPr>',
  )
  target.file('word/document.xml', documentWithoutDuplicateNumbering)

  for (const partName of [
    'word/fontTable.xml',
    'word/numbering.xml',
    'word/theme/theme1.xml',
  ]) {
    const part = await primary.file(partName)?.async('nodebuffer')
    if (part) target.file(partName, part)
  }
  const primaryHeader = await primary.file('word/header1.xml')?.async('nodebuffer')
  const primaryFooter = await primary.file('word/footer1.xml')?.async('nodebuffer')
  if (!primaryHeader || !primaryFooter) {
    throw new Error('投资提案版式权威缺少页眉或页脚')
  }
  for (const name of Object.keys(target.files)) {
    if (/^word\/header\d+\.xml$/.test(name)) target.file(name, primaryHeader)
    if (/^word\/footer\d+\.xml$/.test(name)) target.file(name, primaryFooter)
  }
  return target.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export async function generateInvestmentProposalDocx(input: {
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  generatedAt?: Date
  blueprint?: InvestmentProposalDocumentBlueprint
}) {
  const blueprint = input.blueprint ?? await loadInvestmentProposalBlueprint(input.template)
  const generatedAt = input.generatedAt ?? new Date()
  const company = input.project.companyName?.trim() || input.project.name
  const byTitle = new Map(input.content.sections.map((section) => [section.title, section]))
  const body: Array<Paragraph | Table> = [
    new Paragraph({
      style: PROPOSAL_STYLE.title,
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
      keepNext: true,
      children: [new TextRun({
        text: sanitizeInvestmentProposalClientText(
          input.content.title || `关于对${company}实施股权投资的提案`,
        ),
        size: 32,
        bold: true,
        color: '000000',
        font: font(SONG_FONT),
      })],
    }),
    new Paragraph({
      style: PROPOSAL_STYLE.body,
      spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
      children: [new TextRun({
        text: blueprint.fixedBlocks.salutation,
        size: 24,
        bold: true,
        color: '000000',
        font: font(FANGSONG_FONT),
      })],
    }),
    new Paragraph({
      style: PROPOSAL_STYLE.body,
      spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
      indent: { firstLine: 480 },
      alignment: AlignmentType.JUSTIFIED,
      children: [new TextRun({
        text: sanitizeInvestmentProposalClientText(input.content.executiveSummary),
        size: 24,
        color: '000000',
        font: font(FANGSONG_FONT),
      })],
    }),
    new Paragraph({
      style: PROPOSAL_STYLE.body,
      spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
      indent: { firstLine: 480 },
      alignment: AlignmentType.JUSTIFIED,
      children: [new TextRun({
        text: blueprint.fixedBlocks.authorization,
        size: 24,
        color: '000000',
        font: font(FANGSONG_FONT),
      })],
    }),
  ]

  blueprint.sections.forEach((definition) => {
    const current = byTitle.get(definition.title)
    body.push(headingParagraph(
      definition.title,
      definition.level,
      false,
    ))
    if (definition.container) return
    const findings = (current?.findings ?? [])
      .filter((finding) => sanitizeInvestmentProposalClientText(finding.text))
    findings.forEach((finding) => body.push(findingParagraph(finding)))
    ;(current?.tables ?? []).forEach((table) => body.push(...proposalTable(table, definition.title)))
  })

  body.push(
    new Paragraph({
      style: PROPOSAL_STYLE.body,
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
      children: [new TextRun({
        text: blueprint.fixedBlocks.managementCompany,
        size: 24,
        color: '000000',
        font: font(FANGSONG_FONT),
      })],
    }),
    new Paragraph({
      style: PROPOSAL_STYLE.body,
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
      children: [new TextRun({
        text: `${generatedAt.getFullYear()}年${generatedAt.getMonth() + 1}月${generatedAt.getDate()}日`,
        size: 24,
        color: '000000',
        font: font(FANGSONG_FONT),
      })],
    }),
  )

  const proposalHeader = () => new Header({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: '000000' } },
      spacing: { after: 80 },
      children: [new TextRun({
        text: blueprint.fixedBlocks.headerCompany,
        size: 21,
        color: '000000',
        font: font(SONG_FONT),
      })],
    })],
  })
  const proposalFooter = () => new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        children: [PageNumber.CURRENT],
        size: 21,
        color: '000000',
        font: font(NUMBER_FONT),
      })],
    })],
  })
  const document = new Document({
    features: { updateFields: true },
    evenAndOddHeaderAndFooters: true,
    styles: {
      default: {
        document: {
          run: { size: 24, color: '000000', font: font(FANGSONG_FONT) },
          paragraph: {
            spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
          },
        },
      },
      paragraphStyles: [
        {
          id: 'Title',
          name: 'Title',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 32, bold: true, color: '000000', font: font(SANS_FONT) },
          paragraph: {
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
          },
        },
        {
          id: 'Heading1',
          name: 'heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 28, bold: true, color: '000000', font: font(SANS_FONT) },
          paragraph: {
            spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
            outlineLevel: 0,
          },
        },
        {
          id: 'Heading2',
          name: 'heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 28, color: '000000', font: font(KAITI_FONT) },
          paragraph: {
            spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
            outlineLevel: 1,
          },
        },
        {
          id: 'Heading3',
          name: 'heading 3',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 24, bold: true, color: '000000', font: font(FANGSONG_FONT) },
          paragraph: {
            spacing: { before: 0, after: 0, line: 480, lineRule: LineRuleType.EXACT },
            outlineLevel: 2,
          },
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: {
            width: blueprint.page.widthDxa,
            height: blueprint.page.heightDxa,
          },
          margin: {
            top: blueprint.page.marginTopDxa,
            right: blueprint.page.marginRightDxa,
            bottom: blueprint.page.marginBottomDxa,
            left: blueprint.page.marginLeftDxa,
            header: blueprint.page.headerDxa,
            footer: blueprint.page.footerDxa,
          },
        },
      },
      headers: {
        default: proposalHeader(),
        even: proposalHeader(),
        first: proposalHeader(),
      },
      footers: {
        default: proposalFooter(),
        even: proposalFooter(),
        first: proposalFooter(),
      },
      children: body,
    }],
  })
  await mkdir(path.dirname(input.outputPath), { recursive: true })
  const packed = await Packer.toBuffer(document)
  const buffer = await applyInvestmentProposalLayoutAuthority(packed)
  await writeFile(input.outputPath, buffer)
  return {
    bytes: buffer.length,
    blueprintVersion: blueprint.version,
    coreStandardSha256: blueprint.coreStandardSha256,
    templateCorpusSha256: blueprint.corpusSha256,
    sectionCount: blueprint.sections.length,
    tableCount: input.content.sections.reduce((count, section) => count + (section.tables?.length ?? 0), 0),
    headingLevels: [1, 2],
    tocField: false,
    updateFields: true,
    pageGeometry: blueprint.page,
    formatter: 'investment-proposal-layout-authority-formatter-v5',
    layoutAuthority: path.join(
      getAiSkillDirectory(PROPOSAL_SKILL_NAME),
      'assets',
      'primary-layout-authority.docx',
    ),
  }
}

export type InvestmentProposalOutputIssue = {
  code: string
  message: string
}

export type InvestmentProposalOutputReview = {
  passed: boolean
  issues: InvestmentProposalOutputIssue[]
  metadata: {
    bytes: number
    expectedSectionCount: number
    foundSectionCount: number
    headingLevelCounts: Record<string, number>
    tableCount: number
    tocField: boolean
    updateFields: boolean
    evenAndOddHeaders: boolean
    fixedBlocksValidated: boolean
    pageGeometryValidated: boolean
    bodyClaimsValidated: boolean
  }
}

export async function reviewInvestmentProposalDocx(input: {
  filePath: string
  template: AiTemplateDefinition
  blueprint: InvestmentProposalDocumentBlueprint
  content: BusinessContent
  projectName: string
}) {
  const issues: InvestmentProposalOutputIssue[] = []
  const fileStat = await stat(input.filePath)
  if (!fileStat.isFile() || fileStat.size < 1000) {
    issues.push({ code: 'DOCX_EMPTY', message: 'Word 文件为空或不完整' })
  }
  const zip = await JSZip.loadAsync(await readFile(input.filePath))
  const documentXml = await zip.file('word/document.xml')?.async('string') ?? ''
  const stylesXml = await zip.file('word/styles.xml')?.async('string') ?? ''
  const settingsXml = await zip.file('word/settings.xml')?.async('string') ?? ''
  const headersXml = (await Promise.all(
    Object.keys(zip.files)
      .filter((name) => /^word\/header\d+\.xml$/.test(name))
      .map((name) => zip.file(name)!.async('string')),
  )).join('\n')
  const footersXml = (await Promise.all(
    Object.keys(zip.files)
      .filter((name) => /^word\/footer\d+\.xml$/.test(name))
      .map((name) => zip.file(name)!.async('string')),
  )).join('\n')
  if (!documentXml || !stylesXml) {
    issues.push({ code: 'OPENXML_MISSING', message: 'Word 缺少 document.xml 或 styles.xml' })
  }

  const paragraphs = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)]
    .map((match) => ({
      text: xmlText(match[0]),
      styleId: match[0].match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1] ?? '',
    }))
  const expectedTitles = input.blueprint.sections.map((item) => item.title)
  const bodyText = paragraphs
    .filter((item) => !expectedTitles.includes(item.text))
    .map((item) => item.text)
    .join('\n')
  const proseBodyText = bodyText.replace(/（单位：[^）]+）/g, '')
  const allText = paragraphs.map((item) => item.text).join('\n')
  if (containsInvestmentProposalInternalErrorText(allText)) {
    issues.push({
      code: 'INTERNAL_ERROR_TEXT_LEAK',
      message: 'Word 正文包含仅供系统内部记录的技术错误信息',
    })
  }
  if (containsInvestmentProposalSourceProcessWording(allText)) {
    issues.push({
      code: 'SOURCE_PROCESS_WORDING_LEAK',
      message: 'Word 正文包含项目资料、会议纪要或原始文件等内部取证过程措辞',
    })
  }
  if (containsInvestmentProposalAiStyleBoilerplate(allText)) {
    issues.push({
      code: 'AI_STYLE_BOILERPLATE',
      message: 'Word 正文包含明显的 AI 模板化套话',
    })
  }
  if (containsInvestmentProposalConversationalWording(allText)) {
    issues.push({
      code: 'CONVERSATIONAL_TRANSCRIPT_LEAK',
      message: 'Word正文包含交流口语或转录语气，未改写为正式书面表述',
    })
  }
  if (containsInvestmentProposalLongQuotedExcerpt(bodyText)) {
    issues.push({
      code: 'LONG_QUOTED_EVIDENCE_LEAK',
      message: 'Word正文包含长段引号摘录，未先完成事实概括',
    })
  }
  if (containsInvestmentProposalFormulaicAnalysisWrapper(bodyText)) {
    issues.push({
      code: 'FORMULAIC_ANALYSIS_WRAPPER',
      message: 'Word正文包含机械判断或核验套句',
    })
  }
  if (containsInvestmentProposalGenericNoDataPreface(bodyText)) {
    issues.push({
      code: 'GENERIC_NO_DATA_PREFACE',
      message: 'Word正文包含统一的无资料判定前缀，未直接说明具体缺失事项',
    })
  }
  if (containsInvestmentProposalAbnormalSpacing(allText)) {
    issues.push({
      code: 'ABNORMAL_TYPOGRAPHY_SPACING',
      message: 'Word正文包含中文字符、数字单位或标点附近的异常空格',
    })
  }
  if (allText.includes('待核验')) {
    issues.push({
      code: 'INTERNAL_EVIDENCE_STATUS_TEXT_LEAK',
      message: 'Word 正文包含仅供系统内部审计的“待核验”状态文字',
    })
  }
  if (containsInvestmentProposalWebArtifact(allText)) {
    issues.push({
      code: 'WEB_ARTIFACT_TEXT_LEAK',
      message: 'Word 正文包含网页折叠态、原文链接或来源网址元数据',
    })
  }
  if (containsInvestmentProposalProseLabel(allText)) {
    issues.push({
      code: 'CLIENT_PROSE_LABEL_LEAK',
      message: 'Word 正文包含重复的“判断/依据/影响/待办”底稿标签',
    })
  }
  if (containsInvestmentProposalColonLabel(proseBodyText)) {
    issues.push({
      code: 'CLIENT_COLON_LABEL_LEAK',
      message: 'Word 正文包含“订单节奏：”一类冒号引导标签',
    })
  }
  if (containsInvestmentProposalInlineSubheading(bodyText)) {
    issues.push({
      code: 'INLINE_NUMBERED_SUBHEADING_LEAK',
      message: 'Word 正文包含数字小标题，未按连续自然段输出',
    })
  }
  const foundTitles = paragraphs
    .filter((item) => expectedTitles.includes(item.text))
    .map((item) => item.text)
  if (foundTitles.length !== expectedTitles.length
    || foundTitles.some((title, index) => title !== expectedTitles[index])) {
    issues.push({ code: 'SECTION_TREE_MISMATCH', message: '章节存在遗漏、增删或顺序错误' })
  }
  input.blueprint.sections.forEach((section) => {
    const paragraph = paragraphs.find((item) => item.text === section.title)
    if (!paragraph) return
    const expectedStyle = section.level === 1
      ? PROPOSAL_STYLE.heading1
      : PROPOSAL_STYLE.heading2
    if (paragraph.styleId !== expectedStyle) {
      issues.push({
        code: 'HEADING_STYLE_MISMATCH',
        message: `${section.title}应使用${expectedStyle}，实际为${paragraph.styleId || '无样式'}`,
      })
    }
  })

  const fixedTexts = [
    input.blueprint.fixedBlocks.salutation,
    input.blueprint.fixedBlocks.authorization,
    input.blueprint.fixedBlocks.managementCompany,
  ]
  if (fixedTexts.some((value) => !allText.includes(value))) {
    issues.push({ code: 'FIXED_BLOCK_MISSING', message: '固定称谓、授权说明或机构落款缺失' })
  }
  const forbiddenFooterBlocks = ['免责声明', '引用资料', input.template.disclaimer]
    .filter(Boolean)
  if (forbiddenFooterBlocks.some((value) => allText.includes(value))) {
    issues.push({ code: 'FORBIDDEN_FOOTER_BLOCK', message: '文末不得生成免责声明或引用资料板块' })
  }
  const leakedSamples = [
    '佳量脑科学',
    '飞阔科技',
    '轻蜓光电',
    '普雷赛斯',
    '微纳核芯',
    '中数睿智',
    '德塔智能',
    '蓝成应急',
  ].filter((value) => allText.includes(value) && !input.projectName.includes(value))
  if (leakedSamples.length) {
    issues.push({ code: 'TEMPLATE_SAMPLE_LEAK', message: `发现模板项目事实泄露：${leakedSamples.join('、')}` })
  }
  const expectedClaims = input.content.sections.flatMap((section) =>
    section.findings
      .map((finding) => sanitizeInvestmentProposalClientText(finding.text))
      .filter(Boolean))
  if (expectedClaims.some((claim) => !allText.includes(claim))) {
    issues.push({ code: 'BODY_CLAIM_MISSING', message: 'Word 正文遗漏已通过内容 Reviewer 的事实项' })
  }

  const finalSection = [...documentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].at(-1)?.[0] ?? ''
  const pageSize = finalSection.match(/<w:pgSz\b[^>]*\/>/)?.[0] ?? ''
  const pageMargin = finalSection.match(/<w:pgMar\b[^>]*\/>/)?.[0] ?? ''
  const number = (xml: string, key: string) =>
    Number.parseInt(xml.match(new RegExp(`\\b${key}="(\\d+)"`))?.[1] ?? '-1', 10)
  const geometryValidated =
    number(pageSize, 'w:w') === input.blueprint.page.widthDxa
    && number(pageSize, 'w:h') === input.blueprint.page.heightDxa
    && number(pageMargin, 'w:top') === input.blueprint.page.marginTopDxa
    && number(pageMargin, 'w:right') === input.blueprint.page.marginRightDxa
    && number(pageMargin, 'w:bottom') === input.blueprint.page.marginBottomDxa
    && number(pageMargin, 'w:left') === input.blueprint.page.marginLeftDxa
  if (!geometryValidated) {
    issues.push({ code: 'PAGE_GEOMETRY_MISMATCH', message: 'A4 页面或页边距与 Document Blueprint 不一致' })
  }
  if (!xmlText(headersXml).replace(/\s+/g, '').includes(
    input.blueprint.fixedBlocks.headerCompany.replace(/\s+/g, ''),
  )) {
    issues.push({ code: 'HEADER_MISSING', message: '固定页眉缺失' })
  }
  if (!/PAGE/.test(footersXml)) {
    issues.push({ code: 'PAGE_NUMBER_MISSING', message: '页脚页码字段缺失' })
  }
  const tocField = /TOC\b/.test(documentXml)
  if (tocField || paragraphs.some((item) => item.text.trim() === '目录')) {
    issues.push({ code: 'TOC_FIELD_FORBIDDEN', message: '核心规范不创建独立目录页或 TOC 域' })
  }
  if (/<w:br\b[^>]*w:type="page"/.test(documentXml)) {
    issues.push({ code: 'MANUAL_PAGE_BREAK_FORBIDDEN', message: '核心规范要求正文自然流排，不设置手动分页' })
  }
  const updateFields = /<w:updateFields\s*\/>/.test(settingsXml)
    || /<w:updateFields\b[^>]*w:val="true"/.test(settingsXml)
    || /<w:updateFields\b[^>]*w:val="1"/.test(settingsXml)
  if (!updateFields) issues.push({ code: 'UPDATE_FIELDS_DISABLED', message: 'Word 打开时未启用字段更新' })
  const evenAndOddHeaders = /<w:evenAndOddHeaders\s*\/>/.test(settingsXml)
    || /<w:evenAndOddHeaders\b[^>]*w:val="true"/.test(settingsXml)
    || /<w:evenAndOddHeaders\b[^>]*w:val="1"/.test(settingsXml)
  if (!evenAndOddHeaders) {
    issues.push({ code: 'EVEN_PAGE_HEADER_DISABLED', message: '偶数页页眉页脚未启用，导出后可能缺少固定页眉或页码' })
  }

  const styleXml = (styleId: string) =>
    [...stylesXml.matchAll(/<w:style\b[\s\S]*?<\/w:style>/g)]
      .filter((match) => match[0].includes(`w:styleId="${styleId}"`))
      .at(-1)?.[0] ?? ''
  const roleStyleNames = [
    [PROPOSAL_STYLE.title, '星实-题目'],
    [PROPOSAL_STYLE.heading1, '星实-一标'],
    [PROPOSAL_STYLE.heading2, '星实-二标'],
    [PROPOSAL_STYLE.body, '星实-正文'],
  ] as const
  if (roleStyleNames.some(([styleId, styleName]) =>
    !styleXml(styleId).includes(`w:val="${styleName}"`))) {
    issues.push({ code: 'TYPOGRAPHY_MISMATCH', message: '未完整复用主版式权威的四类真实样式' })
  }
  if (paragraphs.some((item) => item.styleId === 'Heading3')) {
    issues.push({ code: 'HEADING3_FORBIDDEN', message: '标准 17 节结构不得新增三级标题' })
  }
  if (paragraphs.filter((item) => item.styleId === PROPOSAL_STYLE.body).length < 10) {
    issues.push({ code: 'BODY_STYLE_MISMATCH', message: '正文段落必须显式使用主版式权威正文样式' })
  }
  const expectedTableCount = input.content.sections.reduce(
    (count, section) => count + (section.tables?.length ?? 0),
    0,
  )
  const expectedGridTableCount = input.content.sections.reduce(
    (count, section) => count + (section.tables ?? [])
      .filter((table) => !isThreeLineProposalTable(section.title, table.title)).length,
    0,
  )
  const tableXml = [...documentXml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)]
    .map((match) => match[0])
  const tableCount = tableXml.length
  if (tableCount !== expectedTableCount) {
    issues.push({ code: 'TABLE_COUNT_MISMATCH', message: `表格应为${expectedTableCount}个，实际为${tableCount}个` })
  }
  if (expectedGridTableCount && !documentXml.includes('C0C0C0')) {
    issues.push({ code: 'TABLE_FORMAT_MISMATCH', message: '表格表头底纹缺失' })
  }
  const invalidTableGeometry = tableXml.some((xml) => {
    const gridWidths = [...xml.matchAll(/<w:gridCol\b[^>]*w:w="(\d+)"/g)]
      .map((match) => Number.parseInt(match[1], 10))
    const gridWidth = gridWidths.reduce((sum, width) => sum + width, 0)
    return gridWidths.length < 2
      || gridWidths.length > 8
      || gridWidth !== 8306
      || !/<w:tblW\b(?=[^>]*w:w="8306")(?=[^>]*w:type="dxa")[^>]*\/>/.test(xml)
      || !/<w:tblLayout\b[^>]*w:type="fixed"/.test(xml)
      || !/<w:jc\b[^>]*w:val="center"/.test(xml)
      || !/<w:tblHeader\b/.test(xml)
      || /<w:trHeight\b[^>]*w:hRule="exact"/.test(xml)
      || !/<w:vAlign\b[^>]*w:val="center"/.test(xml)
  })
  if (invalidTableGeometry) {
    issues.push({
      code: 'TABLE_GEOMETRY_MISMATCH',
      message: '表格列宽、总宽、居中、重复表头或单元格垂直对齐不符合 Formatter 规范',
    })
  }

  const result: InvestmentProposalOutputReview = {
    passed: issues.length === 0,
    issues,
    metadata: {
      bytes: fileStat.size,
      expectedSectionCount: expectedTitles.length,
      foundSectionCount: foundTitles.length,
      headingLevelCounts: {
        Heading1: paragraphs.filter((item) => item.styleId === PROPOSAL_STYLE.heading1).length,
        Heading2: paragraphs.filter((item) => item.styleId === PROPOSAL_STYLE.heading2).length,
        Heading3: paragraphs.filter((item) => item.styleId === 'Heading3').length,
      },
      tableCount,
      tocField,
      updateFields,
      evenAndOddHeaders,
      fixedBlocksValidated: !issues.some((item) => item.code === 'FIXED_BLOCK_MISSING'),
      pageGeometryValidated: geometryValidated,
      bodyClaimsValidated: !issues.some((item) => item.code === 'BODY_CLAIM_MISSING'),
    },
  }
  return result
}
