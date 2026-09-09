import '../security/hardenImageSizeRuntime.js'
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  LevelFormat,
  LevelSuffix,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  usedBusinessSourceIndexes,
  type BusinessContent,
  type EvidenceSource,
} from './aiBusinessContentService.js'
import { dedupeTextList } from './aiEvidenceQualityService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'
import {
  parseComplianceDocumentBlueprint,
  type ComplianceDocumentBlueprint,
} from './aiComplianceBlueprintService.js'
import {
  cleanComplianceBodyText,
  COMPLIANCE_CHECKLIST_TOPICS,
  COMPLIANCE_INVESTMENT_REASON_TOPICS,
  ensureComplianceSentenceEnding,
} from './aiComplianceWorkflowService.js'
import { sanitizeClientVisibleEvidenceWording } from './aiClientVisibleTextService.js'
import { generateInvestmentProposalDocx } from './aiInvestmentProposalDocumentService.js'
import { renderComplianceStatementWithSkill } from './aiDocumentSkillRenderService.js'
import type { finalizeComplianceReadiness } from './complianceReadinessContract.js'
import { supportedComplianceLegalName } from './complianceLegalName.js'
import { generateInvestmentRecommendationPptWithGorden } from './aiGordenSuperPptService.js'
import { formatShanghaiDate } from '../utils/shanghaiTime.js'

type ProjectLike = {
  name: string
  companyName?: string | null
  industry?: string | null
  stage?: string | null
  financing?: string | null
  valuation?: string | null
  summary?: string | null
  businessModel?: string | null
  market?: string | null
  team?: string | null
}

const MUTED = '5E6D82'
const LIGHT_BLUE = 'EEF4FB'
const AMBER = 'FFF5D9'
const RED = 'FDECEC'
const GREEN = 'EAF7F0'
const TEMPLATE_PURPLE = '625FE7'
const TEMPLATE_PURPLE_DARK = '3E3AAE'
const TEMPLATE_PALE = 'F3F3FA'
const DOCX_SANS_FONT = process.env.AI_DOCUMENT_SANS_FONT || '黑体'
const DOCX_SONG_FONT = process.env.AI_DOCUMENT_SONG_FONT || '宋体'
const DOCX_FANGSONG_FONT = process.env.AI_DOCUMENT_FANGSONG_FONT || '仿宋'
const DOCX_KAITI_FONT = process.env.AI_DOCUMENT_KAITI_FONT || '楷体'
const PPT_FONT = process.env.AI_PRESENTATION_FONT || '微软雅黑'
const PPT_FALLBACK_FONT = process.env.AI_PRESENTATION_FALLBACK_FONT || 'Hiragino Sans GB'

const docxFont = (eastAsia: string) => ({
  ascii: 'Arial',
  hAnsi: 'Arial',
  cs: 'Times New Roman',
  eastAsia,
})

function setDocxFontAltName(xml: string, fontName: string, altName: string) {
  const fontPattern = new RegExp(
    `<w:font w:name="${fontName}">([\\s\\S]*?)<\\/w:font>`,
  )
  return xml.replace(fontPattern, (fontXml) => {
    if (/<w:altName\b[^>]*\/>/.test(fontXml)) {
      return fontXml.replace(
        /<w:altName\b[^>]*\/>/,
        `<w:altName w:val="${altName}"/>`,
      )
    }
    return fontXml.replace(
      `<w:font w:name="${fontName}">`,
      `<w:font w:name="${fontName}"><w:altName w:val="${altName}"/>`,
    )
  })
}

function ensureDocxFontAltName(xml: string, fontName: string, altName: string) {
  if (new RegExp(`<w:font w:name="${fontName}">`).test(xml)) {
    return setDocxFontAltName(xml, fontName, altName)
  }
  const fontEntry = `<w:font w:name="${fontName}"><w:altName w:val="${altName}"/><w:charset w:val="86"/><w:family w:val="auto"/><w:pitch w:val="default"/></w:font>`
  if (xml.includes('</w:fonts>')) {
    return xml.replace('</w:fonts>', `${fontEntry}</w:fonts>`)
  }
  // docx 在没有显式字体登记时会生成自闭合 fontTable。若不展开，
  // macOS/Linux 的 LibreOffice 无法从“宋体/黑体/仿宋/楷体”找到 CJK 字形。
  return xml.replace(/<w:fonts([^>]*)\/>/, `<w:fonts$1>${fontEntry}</w:fonts>`)
}

function ensureCrossPlatformChineseFontTable(xml: string) {
  return [
    ['宋体', 'Songti SC'],
    ['Songti SC', '宋体'],
    ['Noto Serif CJK SC', '宋体'],
    ['黑体', 'STHeiti'],
    ['STHeiti', '黑体'],
    ['Noto Sans CJK SC', '黑体'],
    ['仿宋', 'STFangsong'],
    ['STFangsong', '仿宋'],
    ['楷体', 'Kaiti SC'],
    ['Kaiti SC', '楷体'],
  ].reduce(
    (fontTableXml, [fontName, altName]) =>
      ensureDocxFontAltName(fontTableXml, fontName, altName),
    xml,
  )
}

function complianceCompatibleFont(font: string) {
  if (font === DOCX_SONG_FONT) {
    if (process.platform === 'darwin') return 'Songti SC'
    if (process.platform === 'linux') return 'Noto Serif CJK SC'
  }
  if (font === DOCX_SANS_FONT) {
    if (process.platform === 'darwin') return 'STHeiti'
    if (process.platform === 'linux') return 'Noto Sans CJK SC'
  }
  if (font === DOCX_FANGSONG_FONT) {
    if (process.platform === 'darwin') return 'STFangsong'
    if (process.platform === 'linux') return 'Noto Serif CJK SC'
  }
  if (font === DOCX_KAITI_FONT) {
    if (process.platform === 'darwin') return 'Kaiti SC'
    if (process.platform === 'linux') return 'Noto Serif CJK SC'
  }
  return font
}

function docxTemplateProfile(template: AiTemplateDefinition) {
  if (template.type === 'compliance_statement') {
    return {
      bodyFont: DOCX_SONG_FONT,
      headingFont: DOCX_SANS_FONT,
      accent: '000000',
      coverTitle: `关于${template.label.replace('合规性说明', '')}`,
      header: '',
    }
  }
  return {
    bodyFont: DOCX_FANGSONG_FONT,
    headingFont: DOCX_SANS_FONT,
    accent: '000000',
    coverTitle: template.label,
    header: '浙江赛智伯乐投资管理有限公司',
  }
}

const statusStyle = {
  资料记载: { color: '226B47', fill: GREEN },
  AI推断: { color: '1B5EA7', fill: LIGHT_BLUE },
  待核验: { color: 'A06300', fill: AMBER },
  资料缺口: { color: 'A13B3B', fill: RED },
} as const

const DUE_DILIGENCE_OUTLINE = [
  {
    title: '投资概要',
    modules: ['公司情况', '交易要点', '行业概况', '商业模式和经营管理', '投资价值与风险'],
  },
  {
    title: '公司概况',
    modules: [
      '公司基本信息', '历史沿革', '公司股东情况及实际控制人情况', '核心团队介绍',
      '组织架构', '关联公司及关联交易', '资质、荣誉及法律合规情况',
    ],
  },
  {
    title: '产品与技术',
    modules: ['产品概念总览', '核心技术路线', '产品矩阵', '场景应用', '核心技术沿革', '知识产权及数据权属'],
  },
  { title: '业务情况', modules: ['商业模式与销售策略', '客户验证情况', '供应商、采购与成本情况'] },
  { title: '行业和市场', modules: ['行业趋势与痛点', '市场分析'] },
  { title: '未来发展规划', modules: ['业务拓展规划', '财务情况'] },
  { title: '投资方案', modules: ['投资亮点', '公司估值与投资方式', '退出方案'] },
  { title: '风险提示与对策', modules: ['风险提示与对策'] },
] as const

const DUE_DILIGENCE_STYLES = {
  level1: 'DueDiligenceHeading1',
  level2: 'DueDiligenceHeading2',
  body: 'DueDiligenceBody',
  tableTitle: 'DueDiligenceTableTitle',
  sourceNote: 'DueDiligenceSourceNote',
} as const

const safeName = (value: string) => value.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
const text = (value: unknown, fallback = '待核验') => String(value ?? '').trim() || fallback
const generatedDateLabel = (sourceCutoffDate: string) => `资料截止：${sourceCutoffDate}`
const complianceProjectName = (value: string) => value.trim().replace(/项目$/, '')
const complianceDateLabel = (value: Date) =>
  `${value.getFullYear()}年   ${value.getMonth() + 1}   月   ${value.getDate()}   日`

function sectionLabelFor(title: string) {
  if (/行业|市场|竞争/.test(title)) return '行业研究'
  if (/产品|技术/.test(title)) return '技术分析'
  if (/财务|估值|交易|投资方案/.test(title)) return '投资测算'
  if (/风险|合规|缺口/.test(title)) return '风险提示'
  if (/团队|治理|股权/.test(title)) return '项目分析'
  return '项目概览'
}

function drawWrappedText(
  context: SKRSContext2D,
  value: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const lines: string[] = []
  let current = ''
  for (const character of value) {
    const candidate = current + character
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current)
      current = character
      if (lines.length === maxLines - 1) break
    } else {
      current = candidate
    }
  }
  if (current && lines.length < maxLines) lines.push(current)
  const consumed = lines.join('').length
  if (consumed < value.length && lines.length) {
    let last = lines[lines.length - 1]
    while (last && context.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1)
    lines[lines.length - 1] = `${last}…`
  }
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight))
}

function sourceText(indexes: number[], sources: EvidenceSource[]) {
  const valid = [...new Set(indexes.filter((index) => Boolean(sources[index])))]
  return valid.length ? `引用：${valid.map((index) => `[S${index + 1}]`).join(' ')}` : ''
}

function usedSourceGroups(content: BusinessContent, sources: EvidenceSource[]) {
  const groups = new Map<string, {
    sourceName: string
    sourceType: string
    versionOrDate?: string
    markers: number[]
    locators: number[]
  }>()
  usedBusinessSourceIndexes(content, sources.length).forEach((index) => {
    const source = sources[index]
    if (!source) return
    const key = `${source.sourceType}:${source.sourceId || source.sourceName}`
    const existing = groups.get(key) ?? {
      sourceName: source.sourceName,
      sourceType: source.sourceType,
      versionOrDate: source.versionOrDate,
      markers: [],
      locators: [],
    }
    existing.markers.push(index + 1)
    if (Number.isInteger(source.chunkIndex)) existing.locators.push(Number(source.chunkIndex))
    if (!existing.versionOrDate && source.versionOrDate) existing.versionOrDate = source.versionOrDate
    groups.set(key, existing)
  })
  return [...groups.values()].map((group) => ({
    ...group,
    markers: [...new Set(group.markers)].sort((left, right) => left - right),
    locators: [...new Set(group.locators)].sort((left, right) => left - right),
  }))
}

function bibliographyLine(group: ReturnType<typeof usedSourceGroups>[number]) {
  const markers = group.markers.map((marker) => `S${marker}`).join('、')
  const locator = group.locators.length
    ? `知识片段 ${group.locators.join('、')}`
    : '文件级定位'
  const date = group.versionOrDate ? `；版本/日期 ${group.versionOrDate}` : ''
  return `[${markers}] ${group.sourceName}；${locator}${date}`
}

function paragraph(value: string, options: {
  bold?: boolean
  color?: string
  size?: number
  font?: string
  before?: number
  after?: number
  keepNext?: boolean
  firstLine?: number
  line?: number
  align?: (typeof AlignmentType)[keyof typeof AlignmentType]
} = {}) {
  return new Paragraph({
    children: [new TextRun({
      text: value,
      bold: options.bold,
      color: options.color ?? MUTED,
      size: options.size ?? 21,
      font: docxFont(options.font ?? DOCX_SONG_FONT),
    })],
    spacing: { before: options.before ?? 0, after: options.after ?? 140, line: options.line ?? 330 },
    indent: options.firstLine ? { firstLine: options.firstLine } : undefined,
    alignment: options.align,
    keepNext: options.keepNext,
  })
}

function customNumber(value: number | null | undefined, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Number(value))) : fallback
}

function customLineSpacing(value: string) {
  const exact = value.match(/固定值\s*([\d.]+)\s*pt/i)
  if (exact) return Math.round(Number(exact[1]) * 20)
  const multiple = value.match(/([\d.]+)\s*倍/)
  if (multiple) return Math.round(Number(multiple[1]) * 240)
  return 360
}

function customPageProfile(template: AiTemplateDefinition) {
  const analysis = template.customAnalysis
  const pageValues = analysis?.formatProfile.pageSize.match(/([\d.]+)\s*[×x]\s*([\d.]+)\s*cm/i)
  const marginValues = analysis?.formatProfile.margins.match(
    /上\s*([\d.]+)\s*cm、下\s*([\d.]+)\s*cm、左\s*([\d.]+)\s*cm、右\s*([\d.]+)\s*cm/i,
  )
  const dxa = (cm: number) => Math.round(cm * 567)
  return {
    width: dxa(Number(pageValues?.[1]) || 21),
    height: dxa(Number(pageValues?.[2]) || 29.7),
    marginTop: dxa(Number(marginValues?.[1]) || 2.54),
    marginBottom: dxa(Number(marginValues?.[2]) || 2.54),
    marginLeft: dxa(Number(marginValues?.[3]) || 3.18),
    marginRight: dxa(Number(marginValues?.[4]) || 3.18),
  }
}

async function generateCustomTemplateDocx(input: {
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
}) {
  const analysis = input.template.customAnalysis
  if (!analysis || analysis.format !== 'docx') throw new Error('上传 Word 模板缺少格式分析')
  const profile = analysis.formatProfile
  const bodyFont = profile.primaryFont || DOCX_SONG_FONT
  const headingFont = profile.headingFont || bodyFont
  const bodySize = Math.round(customNumber(profile.bodySizePt, 12, 8, 24) * 2)
  const headingSize = Math.round(customNumber(profile.headingSizePt, 16, 10, 34) * 2)
  const titleSize = Math.round(customNumber(profile.titleSizePt, 22, 14, 48) * 2)
  const line = customLineSpacing(profile.lineSpacing)
  const page = customPageProfile(input.template)
  const references = usedSourceGroups(input.content, input.sources)
  const runFont = (font: string) => docxFont(font)
  // 页眉页脚只继承样式，不复用上传模板中的可见文字。
  const headerText = input.content.title
  const footerText = input.project.name
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: 360, line },
      keepNext: true,
      children: [new TextRun({
        text: input.content.title,
        font: runFont(headingFont),
        size: titleSize,
        bold: true,
        color: profile.colors[0] || '000000',
      })],
    }),
    new Paragraph({
      spacing: { after: 280, line },
      alignment: AlignmentType.JUSTIFIED,
      children: [new TextRun({
        text: input.content.executiveSummary,
        font: runFont(bodyFont),
        size: bodySize,
        color: '000000',
      })],
    }),
  ]
  input.content.sections.forEach((section, index) => {
    children.push(new Paragraph({
      style: 'Heading1',
      keepNext: true,
      pageBreakBefore: index > 0 && analysis.structures[index]?.level === 1
        && /第[一二三四五六七八九十\d]+[章节篇]|报告|方案/.test(section.title),
      spacing: { before: 260, after: 160, line },
      children: [new TextRun({
        text: section.title,
        font: runFont(headingFont),
        size: headingSize,
        bold: true,
        color: profile.colors[0] || '000000',
      })],
    }))
    children.push(new Paragraph({
      spacing: { after: 160, line },
      alignment: AlignmentType.JUSTIFIED,
      children: [new TextRun({
        text: section.summary,
        font: runFont(bodyFont),
        size: bodySize,
        bold: true,
        color: '000000',
      })],
    }))
    section.findings.forEach((finding) => {
      const refs = sourceText(finding.sourceIndexes, input.sources)
      children.push(new Paragraph({
        spacing: { after: 140, line },
        indent: { firstLine: Math.round(bodySize * 10) },
        alignment: AlignmentType.JUSTIFIED,
        children: [
          new TextRun({
            text: finding.text,
            font: runFont(bodyFont),
            size: bodySize,
            color: '000000',
          }),
          ...(refs ? [new TextRun({
            text: `\n${refs.replace(/^引用[：:]/, '参见')}`,
            font: runFont(bodyFont),
            size: Math.max(16, bodySize - 4),
            color: '666666',
          })] : []),
        ],
      }))
    })
    ;(section.tables ?? []).forEach((table) => {
      const rows = [
        new TableRow({
          children: table.columns.map((column) => new TableCell({
            shading: { fill: profile.colors[0] || 'E8E8E8' },
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({
                text: column,
                bold: true,
                color: profile.colors[0] ? 'FFFFFF' : '000000',
                font: runFont(bodyFont),
                size: Math.max(18, bodySize - 2),
              })],
            })],
          })),
        }),
        ...table.rows.map((row) => new TableRow({
          children: row.map((cell) => new TableCell({
            children: [new Paragraph({
              children: [new TextRun({
                text: cell,
                font: runFont(bodyFont),
                size: Math.max(18, bodySize - 2),
              })],
            })],
          })),
        })),
      ]
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows,
      }))
    })
  })
  children.push(
    new Paragraph({
      style: 'Heading1',
      pageBreakBefore: true,
      keepNext: true,
      children: [new TextRun({
        text: '引用资料与责任声明',
        font: runFont(headingFont),
        size: headingSize,
        bold: true,
        color: profile.colors[0] || '000000',
      })],
    }),
  )
  if (references.length) {
    references.forEach((reference) => children.push(new Paragraph({
      spacing: { after: 100, line },
      children: [new TextRun({
        text: bibliographyLine(reference),
        font: runFont(bodyFont),
        size: Math.max(18, bodySize - 2),
        color: '444444',
      })],
    })))
  } else {
    children.push(new Paragraph({
      children: [new TextRun({
        text: '本文件仅列示正文实际使用且可定位的项目资料或公开来源。',
        font: runFont(bodyFont),
        size: bodySize,
        color: '555555',
      })],
    }))
  }
  children.push(new Paragraph({
    spacing: { before: 240, line },
    border: { top: { style: BorderStyle.SINGLE, color: '888888', size: 6 } },
    children: [new TextRun({
      text: `${input.template.disclaimer} 资料截止日：${input.sourceCutoffDate}。`,
      font: runFont(bodyFont),
      size: Math.max(18, bodySize - 2),
      color: '555555',
    })],
  }))
  const doc = new Document({
    creator: '浙江赛智伯乐股权投资管理有限公司投资中台',
    title: input.content.title,
    description: '依据当前项目资料库生成的 AI 初稿',
    styles: {
      default: {
        document: {
          run: { font: runFont(bodyFont), size: bodySize, color: '000000' },
          paragraph: { spacing: { after: 140, line } },
        },
        heading1: {
          run: { font: runFont(headingFont), size: headingSize, bold: true, color: profile.colors[0] || '000000' },
          paragraph: { spacing: { before: 260, after: 160, line }, keepNext: true },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: page.width, height: page.height },
          margin: {
            top: page.marginTop,
            bottom: page.marginBottom,
            left: page.marginLeft,
            right: page.marginRight,
            header: 720,
            footer: 720,
          },
          pageNumbers: { start: 1 },
        },
      },
      headers: headerText
        ? {
            default: new Header({
              children: [new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({
                  text: headerText,
                  font: runFont(bodyFont),
                  size: Math.max(16, bodySize - 4),
                })],
              })],
            }),
          }
        : undefined,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              ...(footerText ? [new TextRun({
                text: `${footerText}　`,
                font: runFont(bodyFont),
                size: Math.max(16, bodySize - 4),
              })] : []),
              new TextRun({
                children: [PageNumber.CURRENT],
                font: runFont(bodyFont),
                size: Math.max(16, bodySize - 4),
              }),
            ],
          })],
        }),
      },
      children,
    }],
  })
  await writeFile(input.outputPath, await Packer.toBuffer(doc))
  const [templateBuffer, generatedBuffer] = await Promise.all([
    readFile(input.template.referencePath),
    readFile(input.outputPath),
  ])
  const templateZip = await JSZip.loadAsync(templateBuffer)
  const outputZip = await JSZip.loadAsync(generatedBuffer)
  const appliedParts: string[] = []
  for (const part of ['word/theme/theme1.xml', 'word/fontTable.xml']) {
    const sourcePart = templateZip.file(part)
    if (!sourcePart || !outputZip.file(part)) continue
    outputZip.file(part, await sourcePart.async('nodebuffer'))
    appliedParts.push(part)
  }
  await writeFile(input.outputPath, await outputZip.generateAsync({ type: 'nodebuffer' }))
  return {
    pageIntent: 'custom-template',
    templateApplied: true,
    templateSha256: createHash('sha256').update(templateBuffer).digest('hex'),
    templateCorpus: [{
      fileName: path.basename(input.template.referencePath),
      sha256: createHash('sha256').update(templateBuffer).digest('hex'),
    }],
    templateParts: appliedParts,
    typography: {
      body: bodyFont,
      heading: headingFont,
      bodySizePt: bodySize / 2,
      headingSizePt: headingSize / 2,
      titleSizePt: titleSize / 2,
      lineSpacing: profile.lineSpacing,
    },
    customStructureCount: input.template.sections.length,
  }
}

export async function generateBusinessDocx(input: {
  complianceReadiness?: ReturnType<typeof finalizeComplianceReadiness>
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  generatedAt?: Date
  blueprint?: ComplianceDocumentBlueprint
}) {
  await mkdir(path.dirname(input.outputPath), { recursive: true })
  if (input.template.type === 'custom_template_document') {
    return generateCustomTemplateDocx(input)
  }
  if (String(input.template.type) === 'investment_proposal') {
    const generation = await generateInvestmentProposalDocx({
      outputPath: input.outputPath,
      template: input.template,
      project: input.project,
      content: input.content,
      sources: input.sources,
      sourceCutoffDate: input.sourceCutoffDate,
      generatedAt: input.generatedAt,
    })
    const templateBuffer = await readFile(input.template.referencePath)
    const templateCorpus = await Promise.all(
      (input.template.referencePaths?.length
        ? input.template.referencePaths
        : [input.template.referencePath])
        .map(async (referencePath) => ({
          fileName: path.basename(referencePath),
          sha256: createHash('sha256').update(await readFile(referencePath)).digest('hex'),
        })),
    )
    return {
      pageIntent: 'brief',
      templateApplied: true,
      templateSha256: createHash('sha256').update(templateBuffer).digest('hex'),
      templateCorpus,
      templateParts: [],
      typography: { body: DOCX_FANGSONG_FONT, heading: DOCX_SANS_FONT },
      ...generation,
    }
  }
  if (String(input.template.type) === 'compliance_statement') {
    const complianceBlueprint = input.blueprint ?? await parseComplianceDocumentBlueprint(input.template)
    return renderComplianceStatementWithSkill({
      outputPath: input.outputPath,
      taskProjectName: input.project.name,
      deliveryReadiness: input.complianceReadiness,
      targetCompanyLegalName: supportedComplianceLegalName(input.project.companyName || input.project.name, input.sources),
      content: input.content,
      sources: input.sources,
      company: complianceBlueprint.fixedContent.issuer,
      generatedAt: input.generatedAt ?? new Date(),
    })
  }
  const generatedAt = input.generatedAt ?? new Date()
  const profile = docxTemplateProfile(input.template)
  const complianceBlueprint = input.template.type === 'compliance_statement'
    ? input.blueprint ?? await parseComplianceDocumentBlueprint(input.template)
    : undefined
  const runFont = (font = profile.bodyFont) => {
    const compatibleFont = complianceCompatibleFont(font)
    // LibreOffice 会在缺少 w:hint 时优先采用 hAnsi；若只给 eastAsia 指定
    // 中文字体，中文仍可能落到 Arial 并显示方框。四个字体槽保持一致，
    // 再通过 fontTable 的 altName 兼容 Windows 中文字体名称。
    return {
      ascii: compatibleFont,
      hAnsi: compatibleFont,
      cs: compatibleFont,
      eastAsia: compatibleFont,
    }
  }
  const dueRuntimeFonts = process.platform === 'darwin'
    ? {
        song: 'Songti SC',
        heading: 'STHeiti',
        body: 'STFangsong',
        level2: 'Kaiti SC',
      }
    : process.platform === 'linux'
      ? {
          song: 'Noto Serif CJK SC',
          heading: 'Noto Sans CJK SC',
          body: 'Noto Serif CJK SC',
          level2: 'Noto Serif CJK SC',
        }
      : {
          song: DOCX_SONG_FONT,
          heading: DOCX_SANS_FONT,
          body: DOCX_FANGSONG_FONT,
          level2: DOCX_KAITI_FONT,
        }
  const isProposal = input.template.type === 'investment_proposal'
  const heading = (value: string, level: 1 | 2 = 1, pageBreakBefore = false) => new Paragraph({
    style: level === 1 ? 'Heading1' : 'Heading2',
    pageBreakBefore,
    keepNext: true,
    spacing: {
      before: isProposal ? (level === 1 ? 240 : 120) : (level === 1 ? 300 : 220),
      after: isProposal ? 0 : (level === 1 ? 180 : 120),
      line: 360,
    },
    children: [new TextRun({
      text: value,
      font: runFont(level === 1 ? profile.headingFont : (isProposal ? DOCX_KAITI_FONT : profile.bodyFont)),
      size: isProposal ? 28 : (level === 1 ? 30 : 26),
      bold: level === 1,
      color: '000000',
    })],
  })
  const bodyParagraph = (value: string, options: {
    bold?: boolean
    color?: string
    size?: number
    firstLine?: boolean
    keepNext?: boolean
  } = {}) => paragraph(value, {
    font: profile.bodyFont,
    color: options.color ?? '000000',
    size: options.size ?? (isProposal ? 28 : 24),
    bold: options.bold,
    firstLine: options.firstLine === false ? 0 : (isProposal ? 560 : 480),
    keepNext: options.keepNext,
    after: isProposal ? 0 : 160,
    line: 360,
    align: isProposal ? AlignmentType.JUSTIFIED : undefined,
  })
  const templateHeader = input.template.type === 'due_diligence_report'
    ? new Header({
      children: [new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, color: '000000', size: 8 } },
        spacing: { after: 80 },
        children: [],
      })],
    })
    : profile.header
      ? new Header({
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            border: { bottom: { style: BorderStyle.SINGLE, color: '000000', size: 8 } },
            spacing: { after: 80 },
            children: [new TextRun({
              text: profile.header,
              font: runFont(profile.bodyFont),
              size: 19,
              color: '000000',
            })],
          }),
        ],
      })
      : undefined
  const pageFooter = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        children: [PageNumber.CURRENT],
        color: '000000',
        size: 18,
        font: runFont(profile.bodyFont),
      })],
    })],
  })
  const disclaimerParagraph = new Paragraph({
    spacing: { before: 240, after: 120, line: 330 },
    border: { top: { color: '888888', size: 6, style: BorderStyle.SINGLE } },
    children: [new TextRun({
      text: `${input.template.disclaimer} 资料截止日：${input.sourceCutoffDate}。`,
      font: runFont(profile.bodyFont),
      size: 20,
      color: '555555',
      italics: !isProposal,
    })],
  })

  const references = usedSourceGroups(input.content, input.sources)
  const contentChildren: Array<Paragraph | Table> = []

  if (input.template.type === 'compliance_statement') {
    const sectionByTitle = new Map(input.content.sections.map((section) => [section.title, section]))
    const section = (title: string) => sectionByTitle.get(title)
    const complianceFindingRuns = (sectionTitle: string, value: string) => {
      const font = runFont(profile.bodyFont)
      const run = (text: string, bold = false) => new TextRun({
        text,
        color: '000000',
        size: 24,
        bold,
        font,
      })
      if (sectionTitle === '核心团队') {
        const parentheticalLead = value.match(
          /^([\u3400-\u9fff·]{2,8}（[^）]{2,40}）)([，。]?)([\s\S]*)$/,
        )
        if (parentheticalLead) {
          const [, lead, punctuation, body] = parentheticalLead
          return [run(lead, true), run(`${punctuation}${body}`)]
        }
        const roleLead = value.match(
          /^([^，。；]{2,52}(?:联合创始人|创始人|首席科学家|总经理|董事长|负责人|CEO|COO|CTO|CMO))([，。])([\s\S]+)$/i,
        )
        if (roleLead) {
          const [, lead, punctuation, body] = roleLead
          return [run(lead, true), run(`${punctuation}${body}`)]
        }
        const roleFirstLead = value.match(
          /^((?:公司)?(?:联合创始人|创始人|首席科学家|总经理|董事长|战略负责人|市场负责人|产业负责人|运营负责人|CEO|COO|CTO|CMO)(?:[、/，\s]*(?:联合创始人|创始人|首席科学家|总经理|董事长|战略负责人|市场负责人|产业负责人|运营负责人|CEO|COO|CTO|CMO))*[\u3400-\u9fff·]{2,4}?)([，。]?)(?=(?:具有|拥有|本科|硕士|博士|毕业|获|曾|现|长期|主要|负责|系|为))([\s\S]+)$/i,
        )
        if (roleFirstLead) {
          const [, lead, punctuation, body] = roleFirstLead
          return [run(lead, true), run(`${punctuation}${body}`)]
        }
      }
      if (sectionTitle === '产品及技术') {
        const productLead = value.match(
          /^([^，。]{2,88}?(?:模型|平台|系统|方案|技术|产品|数据体系|技术架构))([，。]?)([\s\S]+)$/,
        )
        if (productLead) {
          const [, lead, punctuation, body] = productLead
          return [run(lead, true), run(`${punctuation}${body}`)]
        }
      }
      return [run(value)]
    }
    const findingParagraph = (
      finding: BusinessContent['sections'][number]['findings'][number],
      sectionTitle = '',
      options: {
        keepNext?: boolean
        before?: number
      } = {},
    ) => {
      const normalizedText = sanitizeClientVisibleEvidenceWording(
        ensureComplianceSentenceEnding(finding.text),
      )
      return new Paragraph({
        spacing: {
          before: options.before ?? 0,
          after: 0,
          line: 360,
        },
        keepNext: options.keepNext,
        keepLines: false,
        indent: { firstLine: 480 },
        alignment: AlignmentType.JUSTIFIED,
        children: complianceFindingRuns(sectionTitle, normalizedText),
      })
    }
    const complianceHeading = (value: string, level: 1 | 2) => new Paragraph({
      numbering: {
        reference: level === 1 ? 'compliance-level-1' : 'compliance-level-2',
        level: 0,
      },
      alignment: AlignmentType.LEFT,
      keepNext: true,
      keepLines: true,
      spacing: { before: level === 1 ? 240 : 0, after: 0, line: 360 },
      // 模板的 List Paragraph 样式自带字符首行缩进。标题段必须在段落级
      // 显式覆盖，否则 Word/WPS 会在编号缩进之外再次叠加样式缩进，
      // 导致“一、”和“（1）”整体右移。
      indent: level === 1
        ? { firstLine: 0 }
        : { left: 0, firstLine: 482 },
      children: [new TextRun({
        text: value,
        font: runFont(profile.bodyFont),
        size: 24,
        bold: true,
        color: '000000',
      })],
    })
    const addFindingSection = (title: string) => {
      const current = section(title)
      contentChildren.push(complianceHeading(title, 2))
      const findings = current?.findings.length
        ? current.findings
        : [{
            text: title === '公司简介'
              ? '公司的登记主体、设立时间和主要业务尚待确认，后续应核对营业执照、工商档案、公司介绍及主要业务合同。'
              : title === '核心团队'
                ? '核心人员的姓名、职务、任职关系和职责分工尚待确认，后续应核对人员简历、任职文件及访谈记录。'
                : '核心产品、技术权属和客户验证情况尚待确认，后续应核对产品说明、技术文档、知识产权及客户合同。',
            status: '资料缺口' as const,
            sourceIndexes: [],
          }]
      findings.forEach((finding) => contentChildren.push(findingParagraph(finding, title)))
    }

    contentChildren.push(complianceHeading('公司情况介绍', 1))
    addFindingSection('公司简介')
    addFindingSection('核心团队')
    addFindingSection('产品及技术')

    contentChildren.push(complianceHeading('投资理由', 1))
    const reasons = section('投资理由')?.findings ?? []
    const renderedReasons = COMPLIANCE_INVESTMENT_REASON_TOPICS.map((topic, index) =>
      reasons[index] ?? {
          text: topic === '政策和行业趋势'
            ? '项目所处细分行业和适用政策尚待确认，暂不能判断其与基金投资方向及行业趋势的匹配程度。后续应核对公司主营业务、行业分类和适用政策。'
            : topic === '核心团队能力'
              ? '核心人员的履历、任职关系和职责分工尚待确认，暂不能判断团队是否能够支持后续研发、交付和经营。后续应核对人员简历和任职文件。'
              : topic === '产品或技术差异化'
                ? '产品形态、核心技术和知识产权归属尚待确认，暂不能判断公司与同类项目的差异。后续应核对产品说明、技术文档和知识产权材料。'
                : topic === '客户验证或产业生态'
                  ? '客户合作、交付验收和回款情况尚待确认，暂不能判断项目的商业化进展。后续应核对客户合同、验收文件和回款记录。'
                  : '收费方式、收入构成和订单转化情况尚待确认，暂不能判断公司的持续经营和扩张能力。后续应核对经营数据、订单管线和融资安排。',
          status: '资料缺口' as const,
          sourceIndexes: [],
        })
    renderedReasons.forEach((finding) => contentChildren.push(findingParagraph(finding, '投资理由')))

    contentChildren.push(complianceHeading('投资计划', 1))
    const plan = section('投资计划')?.findings ?? []
    const renderedPlan = plan.length
      ? plan
      : [{
          text: '尚缺少本轮估值、融资额、本基金投资金额、投资方式及交易条款等资料。',
          status: '资料缺口' as const,
          sourceIndexes: [],
        }]
    renderedPlan.forEach((finding) => contentChildren.push(findingParagraph(finding, '投资计划')))

    contentChildren.push(complianceHeading('投资情形分析', 1))
    const analyses = section('投资情形分析')?.findings ?? []
    const renderedAnalyses = COMPLIANCE_CHECKLIST_TOPICS.map((topic, index) =>
      analyses[index] ?? {
          text: topic === '投资方式及投资限制'
            ? '本次投资采用增资、股权受让还是其他方式尚未确定。交易方案明确后，应按基金合伙协议逐项核对禁止性和限制性条款。'
            : topic === '返投要求'
              ? '项目是否计入返投以及投资后能否完成返投目标，需结合注册地、人员和业务落地安排判断，并以基金返投条款、认定口径和最新台账为准。'
              : topic === '关联交易'
                ? '标的公司、主要股东、核心人员和交易参与方与基金相关主体的关系尚未完成核对。是否构成关联交易，应以关联关系核查表和利益冲突声明为准。'
                : topic === '投资方向'
                  ? '项目主营业务与基金约定投资范围尚未完成逐项比对。后续应核对基金投资范围、公司主营业务及收入构成。'
                  : topic === '投资配置'
                    ? '本次投资采用基金直接持股还是通过专项载体实施尚未确定。交易架构明确后，应按基金配置条款核对资产类型和持股路径。'
                    : topic === '投资集中度'
                      ? '本次投资金额及对同一项目的累计风险敞口尚未确定。集中度应按基金协议约定的计算口径，以基金规模和本次投资金额测算。'
                      : '公司主体资质、知识产权、数据合规、劳动用工、许可备案和诉讼处罚情况仍需核对，并在交割前完成必要审批。',
          status: '资料缺口' as const,
          sourceIndexes: [],
        })
    renderedAnalyses.forEach((finding) => contentChildren.push(findingParagraph(finding, '投资情形分析')))

    const conclusion = section('结论')?.findings[0]
    contentChildren.push(findingParagraph(conclusion ?? {
      text: input.content.executiveSummary,
      status: '待核验',
      sourceIndexes: [],
    }, '结论', { before: 240 }))
    contentChildren.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { before: 240, after: 0, line: 360 },
        keepNext: true,
        children: [new TextRun({
          text: complianceBlueprint?.fixedContent.issuer
            ?? '浙江赛智伯乐股权投资管理有限公司',
          font: runFont(profile.bodyFont),
          size: 24,
          color: '000000',
        })],
      }),
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { before: 240, after: 0, line: 360 },
        children: [new TextRun({
          text: complianceDateLabel(generatedAt),
          font: runFont(profile.bodyFont),
          size: 24,
          color: '000000',
        })],
      }),
    )
  } else if (input.template.type === 'investment_proposal') {
    const tableBorders = {
      top: { style: BorderStyle.SINGLE, color: '000000', size: 4 },
      bottom: { style: BorderStyle.SINGLE, color: '000000', size: 4 },
      left: { style: BorderStyle.SINGLE, color: '000000', size: 4 },
      right: { style: BorderStyle.SINGLE, color: '000000', size: 4 },
      insideHorizontal: { style: BorderStyle.SINGLE, color: '000000', size: 4 },
      insideVertical: { style: BorderStyle.SINGLE, color: '000000', size: 4 },
    }
    const proposalTable = (
      table: NonNullable<BusinessContent['sections'][number]['tables']>[number],
    ): Array<Paragraph | Table> => {
      const width = 8300
      const baseColumn = Math.floor(width / table.columns.length)
      const columnWidths = table.columns.map((_, index) =>
        index === table.columns.length - 1
          ? width - baseColumn * (table.columns.length - 1)
          : baseColumn)
      const cellParagraph = (value: string, bold = false) => new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0, line: 260 },
        children: [new TextRun({
          text: value,
          font: runFont(profile.bodyFont),
          size: 21,
          bold,
          color: '000000',
        })],
      })
      const row = (values: string[], header = false) => new TableRow({
        tableHeader: header,
        cantSplit: true,
        children: values.map((value, index) => new TableCell({
          width: { size: columnWidths[index], type: WidthType.DXA },
          shading: header ? { fill: 'D9D9D9' } : undefined,
          margins: { top: 70, right: 90, bottom: 70, left: 90 },
          children: [cellParagraph(value, header)],
        })),
      })
      const refs = sourceText(table.sourceIndexes, input.sources)
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          keepNext: true,
          spacing: { before: 120, after: 0, line: 360 },
          children: [new TextRun({
            text: table.title,
            font: runFont(profile.bodyFont),
            size: 28,
            bold: true,
            color: '000000',
          })],
        }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          keepNext: true,
          spacing: { before: 0, after: 60, line: 260 },
          children: [new TextRun({
            text: `单位：${table.unit || '无'}`,
            font: runFont(profile.bodyFont),
            size: 21,
            color: '555555',
          })],
        }),
        new Table({
          width: { size: width, type: WidthType.DXA },
          columnWidths,
          borders: tableBorders,
          rows: [
            row(table.columns, true),
            ...table.rows.map((values) => row(values)),
          ],
        }),
        new Paragraph({
          spacing: { before: 40, after: 80, line: 260 },
          children: [new TextRun({
            text: `（${table.status}${refs ? `；${refs}` : ''}）`,
            font: runFont(profile.bodyFont),
            size: 18,
            color: '666666',
          })],
        }),
      ]
    }
    input.content.sections.forEach((currentSection, sectionIndex) => {
      const level: 1 | 2 = /^（[一二三四五六七八九十]+）/.test(currentSection.title) ? 2 : 1
      const nextSection = input.content.sections[sectionIndex + 1]
      const hasChildSection = level === 1
        && Boolean(nextSection && /^（[一二三四五六七八九十]+）/.test(nextSection.title))
      contentChildren.push(heading(currentSection.title, level))
      if (hasChildSection) return
      if (currentSection.summary) {
        contentChildren.push(bodyParagraph(currentSection.summary, {
          keepNext: Boolean(currentSection.tables?.length || currentSection.findings.length),
        }))
      }
      currentSection.tables?.forEach((table) => {
        contentChildren.push(...proposalTable(table))
      })
      currentSection.findings.forEach((finding, findingIndex) => {
        const refs = sourceText(finding.sourceIndexes, input.sources)
        contentChildren.push(new Paragraph({
          spacing: { after: 0, line: 360 },
          keepNext: findingIndex < currentSection.findings.length - 1,
          keepLines: true,
          indent: { firstLine: 560 },
          alignment: AlignmentType.JUSTIFIED,
          children: [
            new TextRun({
              text: finding.text,
              color: '000000',
              size: 28,
              font: runFont(profile.bodyFont),
            }),
            new TextRun({
              text: `\n（${finding.status}${refs ? `；${refs}` : ''}）`,
              color: '666666',
              size: 18,
              font: runFont(profile.bodyFont),
            }),
          ],
        }))
      })
    })
    contentChildren.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { before: 240, after: 0, line: 360 },
        keepNext: true,
        children: [new TextRun({
          text: '浙江赛智伯乐股权投资管理有限公司',
          font: runFont(profile.bodyFont),
          size: 28,
          color: '000000',
        })],
      }),
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { before: 0, after: 120, line: 360 },
        children: [new TextRun({
          text: formatShanghaiDate(generatedAt, { year: 'numeric', month: 'long' }),
          font: runFont(profile.bodyFont),
          size: 28,
          color: '000000',
        })],
      }),
      disclaimerParagraph,
      heading('引用资料', 1),
    )
    if (references.length) {
      references.forEach((source) => contentChildren.push(paragraph(
        bibliographyLine(source),
        { size: 19, color: '555555', after: 60, font: profile.bodyFont, firstLine: 0, line: 280 },
      )))
    } else {
      contentChildren.push(paragraph('当前项目知识库无可用引用资料；所有实质性内容均需补证并人工核验。', {
        color: '555555',
        size: 20,
        font: profile.bodyFont,
        firstLine: 0,
        line: 300,
      }))
    }
  } else if (input.template.type === 'due_diligence_report') {
    const sectionByTitle = new Map(input.content.sections.map((section) => [section.title, section]))
    const dueHeading = (
      value: string,
      level: 1 | 2,
      pageBreakBefore = false,
    ) => new Paragraph({
      style: level === 1
        ? DUE_DILIGENCE_STYLES.level1
        : DUE_DILIGENCE_STYLES.level2,
      pageBreakBefore,
      keepNext: true,
      keepLines: true,
      outlineLevel: level - 1,
      children: [new TextRun({ text: value })],
    })
    const dueBody = (
      value: string,
      options: { bold?: boolean; keepNext?: boolean; firstLine?: boolean } = {},
    ) => new Paragraph({
      style: DUE_DILIGENCE_STYLES.body,
      keepNext: options.keepNext,
      keepLines: false,
      alignment: AlignmentType.JUSTIFIED,
      indent: options.firstLine === false ? { firstLine: 0 } : undefined,
      children: [new TextRun({
        text: value,
        bold: options.bold,
      })],
    })
    const tableBorders = {
      top: { style: BorderStyle.SINGLE, color: '7F7F7F', size: 4 },
      bottom: { style: BorderStyle.SINGLE, color: '7F7F7F', size: 4 },
      left: { style: BorderStyle.SINGLE, color: '7F7F7F', size: 4 },
      right: { style: BorderStyle.SINGLE, color: '7F7F7F', size: 4 },
      insideHorizontal: { style: BorderStyle.SINGLE, color: 'BFBFBF', size: 4 },
      insideVertical: { style: BorderStyle.SINGLE, color: 'BFBFBF', size: 4 },
    }
    const overviewWidths = [1200, 2950, 1200, 2950]
    const overviewCell = (value: string, label = false) => new TableCell({
      width: { size: overviewWidths[label ? 0 : 1], type: WidthType.DXA },
      shading: label ? { fill: 'E7E6E6' } : undefined,
      margins: { top: 90, right: 100, bottom: 90, left: 100 },
      children: [new Paragraph({
        alignment: label ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { before: 0, after: 0, line: 280 },
        children: [new TextRun({
          text: value,
          font: runFont(dueRuntimeFonts.body),
          size: 21,
          bold: label,
          color: '000000',
        })],
      })],
    })
    const overviewRow = (leftLabel: string, leftValue: string, rightLabel: string, rightValue: string) =>
      new TableRow({
        cantSplit: true,
        children: [
          overviewCell(leftLabel, true),
          overviewCell(leftValue),
          overviewCell(rightLabel, true),
          overviewCell(rightValue),
        ],
      })
    const overviewTable = new Table({
      width: { size: 8300, type: WidthType.DXA },
      columnWidths: overviewWidths,
      borders: tableBorders,
      rows: [
        overviewRow('公司主体', text(input.project.companyName), '所属行业', text(input.project.industry)),
        overviewRow('项目名称', text(input.project.name), '资料截止日', input.sourceCutoffDate),
        overviewRow('融资安排', text(input.project.financing), '估值口径', text(input.project.valuation)),
      ],
    })
    const dueTable = (
      table: NonNullable<BusinessContent['sections'][number]['tables']>[number],
      sectionTitle: string,
    ): Array<Paragraph | Table> => {
      const width = 8300
      const isFinancial = sectionTitle === '财务情况'
      const weights = table.columns.map((column, columnIndex) => {
        if (isFinancial) {
          if (/序号/.test(column)) return 0.7
          if (/年度|年份|期间|时间/.test(column)) return 1.1
          if (/指标|科目|项目/.test(column)) return 2.1
          if (/口径|说明|备注/.test(column)) return 2.8
          return 1.4
        }
        const maxLength = Math.max(
          column.length,
          ...table.rows.map((row) => String(row[columnIndex] ?? '').length),
        )
        return Math.max(1, Math.min(4, Math.ceil(maxLength / 12)))
      })
      const totalWeight = weights.reduce((sum, value) => sum + value, 0)
      const columnWidths = weights.map((weight, index) =>
        index === weights.length - 1
          ? width - weights.slice(0, -1).reduce(
              (sum, value) => sum + Math.floor(width * value / totalWeight),
              0,
            )
          : Math.floor(width * weight / totalWeight))
      const row = (values: string[], header = false) => new TableRow({
        tableHeader: header,
        cantSplit: true,
        children: values.map((value, index) => new TableCell({
          width: { size: columnWidths[index], type: WidthType.DXA },
          shading: header ? { fill: 'E7E6E6' } : undefined,
          margins: { top: 90, right: 110, bottom: 90, left: 110 },
          children: [new Paragraph({
            alignment: header
              ? AlignmentType.CENTER
              : /^[-+]?[\d,.]+(?:%|万|万元|亿|亿元|年|月|天)?$/.test(value.trim())
                ? AlignmentType.RIGHT
                : value.length <= 12
                  ? AlignmentType.CENTER
                  : AlignmentType.LEFT,
            spacing: { before: 0, after: 0, line: 280 },
            children: [new TextRun({
              text: value,
              font: runFont(dueRuntimeFonts.body),
              size: 18,
              bold: header,
              color: '000000',
            })],
          })],
        })),
      })
      return [
        new Paragraph({
          style: DUE_DILIGENCE_STYLES.tableTitle,
          keepNext: true,
          children: [new TextRun({ text: table.title })],
        }),
        ...(table.unit ? [new Paragraph({
          style: DUE_DILIGENCE_STYLES.sourceNote,
          keepNext: true,
          children: [new TextRun({ text: `单位：${table.unit}` })],
        })] : []),
        new Table({
          width: { size: width, type: WidthType.DXA },
          columnWidths,
          borders: tableBorders,
          rows: [
            row(table.columns, true),
            ...table.rows.map((values) => row(values)),
          ],
        }),
      ]
    }

    DUE_DILIGENCE_OUTLINE.forEach((group, groupIndex) => {
      contentChildren.push(dueHeading(`${groupIndex + 1}、${group.title}`, 1, groupIndex > 0))
      group.modules.forEach((moduleTitle, moduleIndex) => {
        const currentSection = sectionByTitle.get(moduleTitle)
        if (!currentSection) return
        contentChildren.push(dueHeading(`${groupIndex + 1}.${moduleIndex + 1} ${moduleTitle}`, 2))
        if (group.title === '投资概要' && moduleTitle === '公司情况') {
          if (currentSection.summary) {
            contentChildren.push(dueBody(currentSection.summary, {
              keepNext: true,
            }))
          }
          contentChildren.push(overviewTable)
        } else if (currentSection.summary) {
          contentChildren.push(dueBody(currentSection.summary, {
            keepNext: Boolean(currentSection.findings.length || currentSection.tables?.length),
          }))
        }
        currentSection.findings.forEach((finding, findingIndex) => {
          const prefix = currentSection.title === '后续核验事项'
            ? `（${findingIndex + 1}）`
            : ''
          contentChildren.push(new Paragraph({
            style: DUE_DILIGENCE_STYLES.body,
            keepNext: false,
            keepLines: false,
            alignment: AlignmentType.JUSTIFIED,
            children: [
              new TextRun({
                text: `${prefix}${finding.text}`,
              }),
            ],
          }))
        })
        currentSection.tables?.forEach((table) => {
          contentChildren.push(...dueTable(table, currentSection.title))
        })
      })
    })
    const investmentConclusion = sectionByTitle.get('投资结论及建议')
    if (investmentConclusion) {
      contentChildren.push(dueHeading('投资结论及建议', 1, true))
      if (investmentConclusion.summary) {
        contentChildren.push(dueBody(investmentConclusion.summary, {
          keepNext: Boolean(investmentConclusion.findings.length || investmentConclusion.tables?.length),
        }))
      }
      investmentConclusion.findings.forEach((finding) => contentChildren.push(dueBody(finding.text)))
      investmentConclusion.tables?.forEach((table) => {
        contentChildren.push(...dueTable(table, investmentConclusion.title))
      })
    }
  } else {
    input.content.sections.forEach((currentSection, sectionIndex) => {
      const shouldBreak = input.template.type === 'investment_proposal'
        && sectionIndex > 0
        && sectionIndex % 2 === 0
      contentChildren.push(heading(`${sectionIndex + 1}. ${currentSection.title}`, 1, shouldBreak))
      contentChildren.push(bodyParagraph(currentSection.summary, {
        bold: true,
        color: profile.accent,
        firstLine: false,
        keepNext: currentSection.findings.length > 0,
      }))
      currentSection.findings.forEach((finding, findingIndex) => {
        const style = statusStyle[finding.status]
        const refs = sourceText(finding.sourceIndexes, input.sources)
        contentChildren.push(new Paragraph({
          spacing: { after: 150, line: 360 },
          keepNext: findingIndex < currentSection.findings.length - 1,
          indent: { firstLine: 480 },
          children: [
            new TextRun({ text: `【${finding.status}】`, bold: true, color: style.color, size: 22, font: runFont(profile.bodyFont) }),
            new TextRun({ text: finding.text, color: '000000', size: 24, font: runFont(profile.bodyFont) }),
            ...(refs ? [new TextRun({ text: `\n${refs}`, color: '666666', size: 18, font: runFont(profile.bodyFont), italics: true })] : []),
          ],
        }))
      })
    })
    contentChildren.push(disclaimerParagraph, heading('引用资料', 1, true))
    if (references.length) {
      references.forEach((source) => contentChildren.push(paragraph(
        bibliographyLine(source),
        { size: 19, color: '555555', after: 90, font: profile.bodyFont, firstLine: 0 },
      )))
    } else {
      contentChildren.push(paragraph('当前项目知识库无可用引用资料；所有实质性内容均需补证并人工核验。', {
        color: 'A13B3B',
        size: 22,
        font: profile.bodyFont,
      }))
    }
  }

  const blueprintPage = complianceBlueprint?.primary.page
  const basePage = {
    size: {
      width: blueprintPage?.widthDxa ?? 11906,
      height: blueprintPage?.heightDxa ?? 16838,
    },
    margin: {
      top: blueprintPage?.marginTopDxa ?? 1440,
      right: blueprintPage?.marginRightDxa ?? 1800,
      bottom: blueprintPage?.marginBottomDxa
        ?? (input.template.type === 'compliance_statement' ? 1440 : 1498),
      left: blueprintPage?.marginLeftDxa ?? 1800,
      header: blueprintPage?.headerDistanceDxa
        ?? (input.template.type === 'compliance_statement' ? 851 : 720),
      footer: blueprintPage?.footerDistanceDxa
        ?? (input.template.type === 'compliance_statement' ? 992 : 720),
    },
    ...(input.template.type === 'compliance_statement' ? {} : { pageNumbers: { start: 1 } }),
  }
  const commonSection = {
    properties: { page: basePage },
    headers: templateHeader ? { default: templateHeader } : undefined,
    footers: input.template.type === 'compliance_statement' ? undefined : { default: pageFooter },
  }
  const proposalCompany = text(input.project.companyName, input.project.name)
  const proposalTitle = input.content.title.includes(proposalCompany) && input.content.title.includes('提案')
    ? input.content.title
    : `关于对${proposalCompany}实施股权投资的提案`
  const title = input.template.type === 'compliance_statement'
    ? `关于${complianceProjectName(input.project.name)}项目投资合规性的说明`
    : input.template.type === 'investment_proposal'
      ? proposalTitle
      : `${input.project.name}${input.template.label}`
  let coverChildren: Array<Paragraph | Table>
  if (input.template.type === 'compliance_statement') {
    coverChildren = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0, line: 360 },
        children: [new TextRun({
          text: title,
          font: runFont(profile.headingFont),
          size: 28,
          color: '000000',
        })],
      }),
    ]
  } else if (input.template.type === 'investment_proposal') {
    coverChildren = [
      new Paragraph({
        style: 'Title',
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 240, line: 360 },
        keepNext: true,
        children: [new TextRun({
          text: title,
          font: runFont(profile.headingFont),
          size: 44,
          bold: true,
          color: '000000',
        })],
      }),
      bodyParagraph('各位投资决策委员会成员：', { firstLine: false, keepNext: true }),
      bodyParagraph(input.content.executiveSummary),
      bodyParagraph('在投资决策委员会审议通过后，将按照审议确定原则实施本次投资的具体操作；实际投资安排以完成尽调、正式投决及签署交易文件为准。'),
    ]
  } else {
    coverChildren = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 1150, after: 480 },
        children: [new TextRun({
          text: text(input.project.companyName, input.project.name),
          font: runFont(input.template.type === 'due_diligence_report'
            ? dueRuntimeFonts.song
            : DOCX_SONG_FONT),
          size: 44,
          bold: true,
          color: '000000',
        })],
      }),
      ...'尽职调查报告'.split('').map((character, index) => new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: index === 5 ? 900 : 0, line: 440 },
        keepNext: index < 5,
        children: [new TextRun({
          text: character,
          font: runFont(input.template.type === 'due_diligence_report'
            ? dueRuntimeFonts.song
            : DOCX_SONG_FONT),
          size: 44,
          bold: true,
          color: '000000',
        })],
      })),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 180 },
        children: [new TextRun({
          text: formatShanghaiDate(generatedAt, { year: 'numeric', month: 'long' }),
          font: runFont(input.template.type === 'due_diligence_report'
            ? dueRuntimeFonts.song
            : DOCX_SONG_FONT),
          size: 32,
          bold: true,
          color: '000000',
        })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 300 },
        children: [new TextRun({
          text: '浙江赛智伯乐股权投资管理有限公司',
          font: runFont(input.template.type === 'due_diligence_report'
            ? dueRuntimeFonts.song
            : DOCX_SONG_FONT),
          size: 32,
          bold: true,
          color: '000000',
        })],
      }),
    ]
  }

  const sections = input.template.type === 'due_diligence_report'
    ? [
      {
        properties: { page: basePage },
        children: coverChildren,
      },
      {
        properties: { page: { ...basePage, pageNumbers: { start: 1 } } },
        headers: templateHeader ? { default: templateHeader } : undefined,
        children: [
          new Paragraph({
            keepNext: true,
            spacing: { after: 160, line: 360 },
            children: [new TextRun({
              text: '目录',
              font: runFont(dueRuntimeFonts.heading),
              size: 28,
              bold: true,
              color: '000000',
            })],
          }),
          new TableOfContents('目录', {
            hyperlink: true,
            headingStyleRange: '1-2',
            useAppliedParagraphOutlineLevel: true,
            beginDirty: true,
            contentChildren: [
              ...DUE_DILIGENCE_OUTLINE.flatMap((group, groupIndex) => [
                new Paragraph({
                  keepNext: group.modules.length > 1,
                  spacing: { after: 80, line: 360 },
                  children: [new TextRun({
                    text: `${groupIndex + 1}、${group.title}`,
                    font: runFont(dueRuntimeFonts.heading),
                    size: 28,
                    bold: true,
                    color: '000000',
                  })],
                }),
                ...group.modules.map((moduleTitle, moduleIndex) => new Paragraph({
                  spacing: { after: 60, line: 330 },
                  indent: { left: 560 },
                  children: [new TextRun({
                    text: `${groupIndex + 1}.${moduleIndex + 1} ${moduleTitle}`,
                    font: runFont(dueRuntimeFonts.body),
                    size: 24,
                    color: '000000',
                  })],
                })),
              ]),
              new Paragraph({
                spacing: { after: 80, line: 360 },
                children: [new TextRun({
                  text: '投资结论及建议',
                  font: runFont(dueRuntimeFonts.heading),
                  size: 28,
                  bold: true,
                  color: '000000',
                })],
              }),
            ],
          }),
        ],
      },
      {
        ...commonSection,
        properties: { page: { ...basePage, pageNumbers: { start: 1 } } },
        children: contentChildren,
      },
    ]
    : [{
      ...commonSection,
      children: [...coverChildren, ...contentChildren],
    }]

  const doc = new Document({
    creator: '浙江赛智伯乐股权投资管理有限公司投资中台',
    title,
    description: `${input.template.label} AI 初稿；使用 docs 公司参考模板的版式规范`,
    features: input.template.type === 'due_diligence_report'
      ? { updateFields: true }
      : undefined,
    numbering: input.template.type === 'compliance_statement'
      ? {
          config: [
            {
              reference: 'compliance-level-1',
              levels: [{
                level: 0,
                format: LevelFormat.CHINESE_COUNTING,
                text: '%1、',
                alignment: AlignmentType.LEFT,
                suffix: LevelSuffix.NOTHING,
                style: {
                  run: { font: runFont(profile.bodyFont), size: 24, bold: true },
                  paragraph: { indent: { left: 720, hanging: 720 } },
                },
              }],
            },
            {
              reference: 'compliance-level-2',
              levels: [{
                level: 0,
                format: LevelFormat.DECIMAL,
                text: '（%1）',
                alignment: AlignmentType.LEFT,
                suffix: LevelSuffix.NOTHING,
                style: {
                  run: { font: runFont(profile.bodyFont), size: 24, bold: true },
                  paragraph: { indent: { left: 1140, hanging: 720 } },
                },
              }],
            },
          ],
        }
      : undefined,
    styles: {
      ...(input.template.type === 'due_diligence_report'
        ? {
            paragraphStyles: [
              {
                id: DUE_DILIGENCE_STYLES.level1,
                name: '尽调一级标题',
                basedOn: 'Normal',
                next: DUE_DILIGENCE_STYLES.body,
                quickFormat: true,
                run: {
                  font: runFont(dueRuntimeFonts.heading),
                  size: 30,
                  bold: true,
                  color: '000000',
                },
                paragraph: {
                  keepNext: true,
                  keepLines: true,
                  outlineLevel: 0,
                  spacing: { before: 240, after: 120, line: 360 },
                },
              },
              {
                id: DUE_DILIGENCE_STYLES.level2,
                name: '尽调二级标题',
                basedOn: 'Normal',
                next: DUE_DILIGENCE_STYLES.body,
                quickFormat: true,
                run: {
                  font: runFont(dueRuntimeFonts.level2),
                  size: 24,
                  bold: true,
                  color: '000000',
                },
                paragraph: {
                  keepNext: true,
                  keepLines: true,
                  outlineLevel: 1,
                  spacing: { before: 160, after: 60, line: 360 },
                },
              },
              {
                id: DUE_DILIGENCE_STYLES.body,
                name: '尽调正文',
                basedOn: 'Normal',
                next: DUE_DILIGENCE_STYLES.body,
                quickFormat: true,
                run: {
                  font: runFont(dueRuntimeFonts.body),
                  size: 24,
                  color: '000000',
                },
                paragraph: {
                  alignment: AlignmentType.JUSTIFIED,
                  indent: { firstLine: 480 },
                  spacing: { before: 0, after: 0, line: 360 },
                },
              },
              {
                id: DUE_DILIGENCE_STYLES.tableTitle,
                name: '尽调表题',
                basedOn: DUE_DILIGENCE_STYLES.body,
                next: DUE_DILIGENCE_STYLES.sourceNote,
                run: {
                  font: runFont(dueRuntimeFonts.body),
                  size: 24,
                  bold: true,
                  color: '000000',
                },
                paragraph: {
                  alignment: AlignmentType.LEFT,
                  keepNext: true,
                  indent: { firstLine: 0 },
                  spacing: { before: 160, after: 40, line: 320 },
                },
              },
              {
                id: DUE_DILIGENCE_STYLES.sourceNote,
                name: '尽调单位说明',
                basedOn: DUE_DILIGENCE_STYLES.body,
                next: DUE_DILIGENCE_STYLES.body,
                run: {
                  font: runFont(dueRuntimeFonts.body),
                  size: 18,
                  color: '000000',
                },
                paragraph: {
                  alignment: AlignmentType.RIGHT,
                  keepNext: true,
                  indent: { firstLine: 0 },
                  spacing: { before: 0, after: 60, line: 260 },
                },
              },
            ],
          }
        : {}),
      default: {
        document: {
          run: { font: runFont(profile.bodyFont), size: isProposal ? 28 : 24, color: '000000' },
          paragraph: { spacing: { after: isProposal ? 0 : 160, line: 360 } },
        },
        heading1: {
          run: { font: runFont(profile.headingFont), size: isProposal ? 28 : 30, bold: true, color: '000000' },
          paragraph: { spacing: { before: isProposal ? 240 : 300, after: isProposal ? 0 : 180 }, keepNext: true },
        },
        heading2: {
          run: { font: runFont(isProposal ? DOCX_KAITI_FONT : profile.bodyFont), size: isProposal ? 28 : 26, bold: false, color: '000000' },
          paragraph: { spacing: { before: isProposal ? 120 : 240, after: isProposal ? 0 : 120 }, keepNext: true },
        },
      },
    },
    sections,
  })
  await writeFile(input.outputPath, await Packer.toBuffer(doc))
  const outputZip = await JSZip.loadAsync(await readFile(input.outputPath))
  const templateZip = path.extname(input.template.referencePath).toLowerCase() === '.docx'
    ? await JSZip.loadAsync(await readFile(input.template.referencePath))
    : undefined
  // 投资提案按已蒸馏的精确令牌创建样式。不要在生成后覆盖 styles.xml 或
  // numbering.xml/fontTable.xml，否则新文档中的样式、编号或字体引用可能
  // 指向模板中不同的 ID，或删除运行时使用的中文字体声明。
  const templateParts = input.template.type === 'investment_proposal'
    ? []
    : [
        'word/styles.xml',
        'word/stylesWithEffects.xml',
        'word/numbering.xml',
        'word/theme/theme1.xml',
        'word/fontTable.xml',
      ]
  const appliedParts: string[] = []
  for (const part of templateParts) {
    const sourcePart = templateZip?.file(part)
    if (!sourcePart || !outputZip.file(part)) continue
    outputZip.file(part, await sourcePart.async('nodebuffer'))
    appliedParts.push(part)
  }
  if (input.template.type === 'due_diligence_report') {
    const fontTablePart = outputZip.file('word/fontTable.xml')
    if (fontTablePart) {
      outputZip.file(
        'word/fontTable.xml',
        ensureCrossPlatformChineseFontTable(await fontTablePart.async('string')),
      )
    }
  }
  if (input.template.type === 'compliance_statement') {
    const fontTablePart = outputZip.file('word/fontTable.xml')
    if (fontTablePart) {
      const fontTableXml = await fontTablePart.async('string')
      const compatibleFontTableXml = ensureDocxFontAltName(
        ensureDocxFontAltName(
          setDocxFontAltName(
            setDocxFontAltName(fontTableXml, '宋体', 'Songti SC'),
            '黑体',
            'STHeiti',
          ),
          'Songti SC',
          '宋体',
        ),
        'STHeiti',
        '黑体',
      )
      outputZip.file(
        'word/fontTable.xml',
        compatibleFontTableXml.replace(
          /<w:embed(?:Regular|Bold|Italic|BoldItalic)\b[^>]*\/>/g,
          '',
        ),
      )
    }
    const templateTheme = templateZip?.file('word/theme/theme1.xml')
    if (templateTheme && !outputZip.file('word/theme/theme1.xml')) {
      outputZip.file('word/theme/theme1.xml', await templateTheme.async('nodebuffer'))
      const relationshipsPart = outputZip.file('word/_rels/document.xml.rels')
      if (relationshipsPart) {
        let relationshipsXml = await relationshipsPart.async('string')
        if (!/relationships\/theme/.test(relationshipsXml)) {
          const usedIds = [...relationshipsXml.matchAll(/\bId="rId(\d+)"/g)]
            .map((match) => Number(match[1]))
          const nextId = Math.max(0, ...usedIds) + 1
          relationshipsXml = relationshipsXml.replace(
            '</Relationships>',
            `<Relationship Id="rId${nextId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`,
          )
          outputZip.file('word/_rels/document.xml.rels', relationshipsXml)
        }
      }
      const contentTypesPart = outputZip.file('[Content_Types].xml')
      if (contentTypesPart) {
        let contentTypesXml = await contentTypesPart.async('string')
        if (!contentTypesXml.includes('/word/theme/theme1.xml')) {
          contentTypesXml = contentTypesXml.replace(
            '</Types>',
            '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
          )
          outputZip.file('[Content_Types].xml', contentTypesXml)
        }
      }
      appliedParts.push('word/theme/theme1.xml')
    }
    const documentPart = outputZip.file('word/document.xml')
    const numberingPart = outputZip.file('word/numbering.xml')
    if (documentPart && numberingPart) {
      const documentXml = await documentPart.async('string')
      const templateListStyleId = complianceBlueprint?.primary.paragraphRoles.level1.styleId
      const mappedDocumentXml = documentXml
        .replace(
          /<w:numId w:val="([2-5])"\/>/g,
          (_match, value: string) => `<w:numId w:val="${({ 2: 1, 3: 2, 4: 3, 5: 4 } as Record<string, number>)[value]}"/>`,
        )
        // docx 会为编号段落写入内置 ListParagraph。合规模板的 styles.xml
        // 来自 WPS，实际列表样式是模板解析所得的数字 ID；若不映射，
        // Word XML 中虽然有 numPr，LibreOffice/PDF 却不会渲染可见编号。
        .replace(
          /<w:pStyle w:val="ListParagraph"\/>/g,
          templateListStyleId
            ? `<w:pStyle w:val="${templateListStyleId}"/>`
            : '',
        )
      let numberingXml = await numberingPart.async('string')
      numberingXml = numberingXml
        .split('japaneseCounting').join('chineseCounting')
        .split('宋体').join('Songti SC')
        .split('黑体').join('STHeiti')
      if (!/<w:num w:numId="4">/.test(numberingXml)) {
        numberingXml = numberingXml.replace(
          '</w:numbering>',
          '<w:num w:numId="4"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num></w:numbering>',
        )
      }
      outputZip.file('word/document.xml', mappedDocumentXml)
      outputZip.file('word/numbering.xml', numberingXml)
    }
  }
  await writeFile(input.outputPath, await outputZip.generateAsync({ type: 'nodebuffer' }))
  const templateCorpus = await Promise.all(
    (input.template.referencePaths?.length ? input.template.referencePaths : [input.template.referencePath])
      .map(async (referencePath) => ({
        fileName: path.basename(referencePath),
        sha256: createHash('sha256').update(await readFile(referencePath)).digest('hex'),
      })),
  )
  const templateCorpusSha256 = createHash('sha256')
    .update(templateCorpus
      .map((item) => `${item.fileName}:${item.sha256}`)
      .sort()
      .join('\n'))
    .digest('hex')
  return {
    pageIntent: input.template.type === 'due_diligence_report' ? 'long-form' : 'brief',
    templateApplied: true,
    templateSha256: input.template.type === 'due_diligence_report'
      ? templateCorpusSha256
      : templateCorpus.find((item) =>
        item.fileName === path.basename(input.template.referencePath))?.sha256
        ?? templateCorpus[0]?.sha256
        ?? '',
    templateCorpus,
    templateParts: appliedParts,
    typography: { body: profile.bodyFont, heading: profile.headingFont },
    ...(complianceBlueprint
      ? {
          blueprintSha256: complianceBlueprint.blueprintSha256,
          blueprintVersion: complianceBlueprint.version,
          sectionTree: complianceBlueprint.sectionTree,
        }
      : {}),
  }
}

function customPptSize(template: AiTemplateDefinition) {
  const match = template.customAnalysis?.formatProfile.pageSize.match(
    /([\d.]+)\s*[×x]\s*([\d.]+)\s*in/i,
  )
  const width = customNumber(match ? Number(match[1]) : null, 13.333, 7.5, 20)
  const height = customNumber(match ? Number(match[2]) : null, 7.5, 5.625, 15)
  return { width, height }
}

function validHex(value: string | undefined, fallback: string) {
  return value && /^[0-9A-F]{6}$/i.test(value) ? value.toUpperCase() : fallback
}

async function generateCustomTemplatePptx(input: {
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  pageCount?: string
}) {
  const analysis = input.template.customAnalysis
  if (!analysis || analysis.format !== 'pptx') throw new Error('上传 PPT 模板缺少格式分析')
  const profile = analysis.formatProfile
  const { width, height } = customPptSize(input.template)
  const font = profile.primaryFont || PPT_FONT
  const headingFont = profile.headingFont || font
  const primary = validHex(profile.colors[0], '3E3AAE')
  const secondary = validHex(profile.colors[1], '625FE7')
  const pale = validHex(profile.colors.find((color) => /^F/i.test(color)), 'F3F3FA')
  const titleSize = customNumber(profile.titleSizePt, 30, 22, 42)
  const headingSize = customNumber(profile.headingSizePt, 20, 16, 30)
  const bodySize = customNumber(profile.bodySizePt, 12, 9, 18)
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'UPLOADED_TEMPLATE', width, height })
  pptx.layout = 'UPLOADED_TEMPLATE'
  pptx.author = '浙江赛智伯乐股权投资管理有限公司投资中台'
  pptx.company = '浙江赛智伯乐股权投资管理有限公司'
  pptx.subject = input.content.title
  pptx.title = input.content.title
  pptx.theme = { headFontFace: headingFont, bodyFontFace: font }
  const references = usedSourceGroups(input.content, input.sources)
  const addSourceNotes = (slide: PptxGenJS.Slide, indexes: number[]) => {
    const validIndexes = [...new Set(indexes)]
      .filter((index) => Number.isInteger(index) && Boolean(input.sources[index]))
    if (!validIndexes.length) return
    slide.addNotes([
      '[Sources]',
      ...validIndexes.map((index) => {
        const source = input.sources[index]
        const locator = source.locator
          || (Number.isInteger(source.chunkIndex)
            ? `知识片段 ${source.chunkIndex}`
            : '文件级定位')
        const version = source.versionOrDate ? `；版本/日期 ${source.versionOrDate}` : ''
        return `- S${index + 1}；${source.sourceName}；${locator}${version}`
      }),
    ].join('\n'))
  }
  const marginX = width * 0.06
  const contentWidth = width - marginX * 2
  const footerY = height - 0.36
  const addFooter = (slide: PptxGenJS.Slide, page: number, source = '') => {
    slide.addShape(pptx.ShapeType.line, {
      x: marginX,
      y: footerY - 0.08,
      w: contentWidth,
      h: 0,
      line: { color: secondary, width: 0.6, transparency: 35 },
    })
    const footerText = `${input.project.name}　|　资料截止：${input.sourceCutoffDate}`
    slide.addText(`${footerText}${source ? `　|　来源：${source}` : ''}`, {
      x: marginX,
      y: footerY,
      w: contentWidth - 0.6,
      h: 0.18,
      fontFace: font,
      lang: 'zh-CN',
      fontSize: Math.max(6.5, bodySize - 4),
      color: '777777',
      margin: 0,
      fit: 'shrink',
      objectName: `slot.slide.${page}.footer_source`,
    })
    slide.addText(String(page), {
      x: width - marginX - 0.45,
      y: footerY,
      w: 0.45,
      h: 0.18,
      fontFace: font,
      lang: 'zh-CN',
      fontSize: Math.max(7, bodySize - 3),
      color: '777777',
      align: 'right',
      margin: 0,
      objectName: `slot.slide.${page}.page_number`,
    })
  }
  const addHeader = (slide: PptxGenJS.Slide, title: string, page: number, source = '') => {
    slide.background = { color: 'FFFFFF' }
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: width,
      h: Math.max(0.08, height * 0.018),
      fill: { color: primary },
      line: { transparency: 100 },
    })
    slide.addText(title, {
      x: marginX,
      y: height * 0.075,
      w: contentWidth,
      h: Math.max(0.36, height * 0.075),
      fontFace: headingFont,
      lang: 'zh-CN',
      fontSize: headingSize,
      bold: true,
      color: primary,
      margin: 0,
      fit: 'shrink',
      objectName: `slot.slide.${page}.title`,
    })
    addFooter(slide, page, source)
  }

  const cover = pptx.addSlide()
  cover.background = { color: 'FFFFFF' }
  cover.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: width,
    h: height * 0.08,
    fill: { color: primary },
    line: { transparency: 100 },
  })
  cover.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: height * 0.78,
    w: width,
    h: height * 0.22,
    fill: { color: pale },
    line: { transparency: 100 },
  })
  cover.addText(input.project.name, {
    x: marginX,
    y: height * 0.23,
    w: contentWidth,
    h: height * 0.13,
    fontFace: headingFont,
    lang: 'zh-CN',
    fontSize: titleSize,
    bold: true,
    color: primary,
    align: 'center',
    valign: 'middle',
    margin: 0,
    fit: 'shrink',
    objectName: 'cover.project_name',
  })
  cover.addText(input.content.title, {
    x: marginX,
    y: height * 0.41,
    w: contentWidth,
    h: height * 0.1,
    fontFace: headingFont,
    lang: 'zh-CN',
    fontSize: Math.max(18, headingSize),
    bold: true,
    color: '222222',
    align: 'center',
    valign: 'middle',
    margin: 0,
    fit: 'shrink',
    objectName: 'cover.document_title',
  })
  cover.addText(input.content.executiveSummary, {
    x: width * 0.16,
    y: height * 0.525,
    w: width * 0.68,
    h: height * 0.07,
    fontFace: font,
    lang: 'zh-CN',
    fontSize: Math.max(9, bodySize - 1),
    color: '444444',
    align: 'center',
    valign: 'middle',
    margin: 0,
    fit: 'shrink',
    objectName: 'cover.executive_summary',
  })
  cover.addText(`资料截止：${input.sourceCutoffDate}\n项目投资分析`, {
    x: width * 0.25,
    y: height * 0.6,
    w: width * 0.5,
    h: height * 0.09,
    fontFace: font,
    lang: 'zh-CN',
    fontSize: bodySize,
    color: '666666',
    align: 'center',
    margin: 0,
    fit: 'shrink',
    objectName: 'cover.date',
  })
  addSourceNotes(
    cover,
    input.content.executiveSummarySourceIndexes
      ?? input.content.sections.flatMap((section) =>
        section.findings.flatMap((finding) => finding.sourceIndexes)).slice(0, 8),
  )

  const requestedMax = Number.parseInt(String(input.pageCount || '20'), 10)
  const maxSlides = input.template.type === 'investment_recommendation_ppt'
    ? input.content.sections.length + 2
    : Number.isFinite(requestedMax)
      ? Math.max(5, Math.min(requestedMax, 30))
      : 20
  const selectedSections = input.content.sections.slice(0, Math.max(1, maxSlides - 2))
  selectedSections.forEach((section, index) => {
    const slide = pptx.addSlide()
    const sourceNames = uniqueBusinessSourceNames(section, input.sources)
    addHeader(slide, section.title, index + 2, sourceNames.join('、'))
    slide.addText(section.summary, {
      x: marginX,
      y: height * 0.18,
      w: contentWidth,
      h: height * 0.09,
      fontFace: headingFont,
      lang: 'zh-CN',
      fontSize: Math.max(bodySize + 1.5, 11),
      bold: true,
      color: primary,
      margin: 0.02,
      fit: 'shrink',
      objectName: `section.${index + 1}.summary`,
    })
    const firstTable = section.tables?.[0]
    if (firstTable?.rows.length && firstTable.columns.length >= 2) {
      slide.addTable([
        firstTable.columns.map((column) => ({
          text: column,
          options: { bold: true, color: 'FFFFFF', fill: { color: primary } },
        })),
        ...firstTable.rows.slice(0, 8).map((row) =>
          row.map((cell) => ({ text: cell, options: { color: '222222' } }))),
      ], {
        x: marginX,
        y: height * 0.32,
        w: contentWidth,
        h: height * 0.48,
        border: { type: 'solid', color: secondary, pt: 0.7 },
        fontFace: font,
        lang: 'zh-CN',
        fontSize: Math.max(8, bodySize - 1),
        margin: 0.08,
        valign: 'middle',
        breakLine: false,
        objectName: `section.${index + 1}.table.1`,
      })
      addSourceNotes(slide, [
        ...(section.summarySourceIndexes ?? []),
        ...firstTable.sourceIndexes,
      ])
      return
    }
    const findings = section.findings.slice(0, 5)
    const availableHeight = height * 0.54
    const rowHeight = availableHeight / Math.max(1, findings.length)
    findings.forEach((finding, findingIndex) => {
      const y = height * 0.31 + findingIndex * rowHeight
      slide.addText(finding.text, {
        x: marginX,
        y: y - 0.01,
        w: contentWidth,
        h: Math.max(0.4, rowHeight * 0.75),
        fontFace: font,
        lang: 'zh-CN',
        fontSize: bodySize,
        color: '222222',
        margin: 0.02,
        fit: 'shrink',
        valign: 'top',
        objectName: `section.${index + 1}.finding.${findingIndex + 1}.text`,
      })
    })
    addSourceNotes(slide, [
      ...(section.summarySourceIndexes ?? []),
      ...findings.flatMap((finding) => finding.sourceIndexes),
    ])
  })

  const referencesSlide = pptx.addSlide()
  addHeader(referencesSlide, '引用资料与责任声明', selectedSections.length + 2)
  const referenceLines = references.length
    ? references.slice(0, 16).map((reference) => bibliographyLine(reference))
    : ['本页仅列示正文实际使用且可定位的项目资料或公开来源。']
  referencesSlide.addText(referenceLines.map((line) => ({
    text: line,
    options: { bullet: { indent: 14 }, breakLine: true },
  })), {
    x: marginX,
    y: height * 0.2,
    w: contentWidth,
    h: height * 0.48,
    fontFace: font,
    lang: 'zh-CN',
    fontSize: Math.max(8.5, bodySize - 1),
    color: '222222',
    margin: 0.03,
    fit: 'shrink',
    breakLine: false,
    paraSpaceAfter: 7,
    objectName: 'references.entries',
  })
  referencesSlide.addShape(pptx.ShapeType.rect, {
    x: marginX,
    y: height * 0.73,
    w: contentWidth,
    h: height * 0.1,
    fill: { color: pale },
    line: { color: secondary, width: 0.6 },
  })
  referencesSlide.addText(input.template.disclaimer, {
    x: marginX + 0.2,
    y: height * 0.755,
    w: contentWidth - 0.4,
    h: height * 0.05,
    fontFace: font,
    lang: 'zh-CN',
    fontSize: Math.max(8, bodySize - 1.5),
    color: '555555',
    align: 'center',
    margin: 0,
    fit: 'shrink',
    objectName: 'references.disclaimer',
  })
  addSourceNotes(
    referencesSlide,
    usedBusinessSourceIndexes(input.content, input.sources.length),
  )
  await pptx.writeFile({ fileName: input.outputPath })
  const templateBuffer = await readFile(input.template.referencePath)
  const outputZip = await JSZip.loadAsync(await readFile(input.outputPath))
  for (const slidePart of Object.keys(outputZip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
    const slideFile = outputZip.file(slidePart)
    if (!slideFile) continue
    outputZip.file(
      slidePart,
      (await slideFile.async('string'))
        .replace(/lang="en-US"/g, 'lang="zh-CN"')
        .replace(/Arial Unicode MS/g, font),
    )
  }
  const themePart = outputZip.file('ppt/theme/theme1.xml')
  if (themePart) {
    outputZip.file(
      'ppt/theme/theme1.xml',
      (await themePart.async('string'))
        .replace(/<a:ea typeface="[^"]*"\s*\/>/g, `<a:ea typeface="${font}"/>`)
        .replace(/Arial Unicode MS/g, font),
    )
  }
  await writeFile(input.outputPath, await outputZip.generateAsync({ type: 'nodebuffer' }))
  return {
    slideCount: selectedSections.length + 2,
    editableLevel: 'core-elements',
    templateApplied: true,
    templateSha256: createHash('sha256').update(templateBuffer).digest('hex'),
    inheritedCompanyAssets: 0,
    cjkFont: font,
    cjkLanguage: 'zh-CN',
    customCanvas: { width, height },
    customStructureCount: input.template.sections.length,
  }
}

function uniqueBusinessSourceNames(
  section: BusinessContent['sections'][number],
  sources: EvidenceSource[],
) {
  return [...new Set(
    section.findings
      .flatMap((finding) => finding.sourceIndexes)
      .map((index) => sources[index]?.sourceName)
      .filter((value): value is string => Boolean(value)),
  )]
}

export async function generateBusinessPptx(input: {
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  pageCount?: string
  resumeFromDirectory?: string
  onProgress?: (
    update: { stage: string; progress: number },
  ) => void | Promise<void>
  onImageDeckReady?: (artifact: {
    path: string
    slideCount: number
    bytes: number
    sha256: string
    metadata: Record<string, unknown>
  }) => void | Promise<void>
}) {
  await mkdir(path.dirname(input.outputPath), { recursive: true })
  if (mustUseReferenceDrivenPptPipeline(input.template)) {
    const result = await generateInvestmentRecommendationPptWithGorden(input)
    assertInvestmentRecommendationSkillChain(result)
    return result
  }
  if (input.template.customAnalysis?.format === 'pptx') {
    return generateCustomTemplatePptx(input)
  }
  const templateBuffer = await readFile(input.template.referencePath)
  const templateZip = await JSZip.loadAsync(templateBuffer)
  const asDataUri = async (part: string, mime: string) => {
    const file = templateZip.file(part)
    return file ? `data:${mime};base64,${await file.async('base64')}` : undefined
  }
  // These are the only reusable, company-level assets in the approved sample:
  // mountain footer plus the two firm marks. Project portraits, product images,
  // certificates and investor logos are intentionally never imported.
  const templateAssets = {
    mountain: await asDataUri('ppt/media/image1.jpeg', 'image/jpeg'),
    logoPrimary: await asDataUri('ppt/media/image4.png', 'image/png'),
    logoSecondary: await asDataUri('ppt/media/image5.png', 'image/png'),
  }
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = '浙江赛智伯乐股权投资管理有限公司投资中台'
  pptx.company = '浙江赛智伯乐股权投资管理有限公司'
  pptx.subject = `${input.project.name}投资建议书`
  pptx.title = input.content.title
  pptx.theme = { headFontFace: PPT_FONT, bodyFontFace: PPT_FONT }
  const references = usedSourceGroups(input.content, input.sources)
  const defaultSourceLabel = references.length
    ? references.slice(0, 3).map((source) => source.sourceName).join('、')
    : '无可引用项目资料'
  const addSourceNotes = (slide: PptxGenJS.Slide, indexes: number[]) => {
    const validIndexes = [...new Set(indexes)]
      .filter((index) => Number.isInteger(index) && Boolean(input.sources[index]))
    if (!validIndexes.length) return
    slide.addNotes([
      '[Sources]',
      ...validIndexes.map((index) => {
        const source = input.sources[index]
        const locator = source.locator
          || (Number.isInteger(source.chunkIndex)
            ? `知识片段 ${source.chunkIndex}`
            : '文件级定位')
        const version = source.versionOrDate ? `；版本/日期 ${source.versionOrDate}` : ''
        return `- S${index + 1}；${source.sourceName}；${locator}${version}`
      }),
    ].join('\n'))
  }

  const addFooter = (slide: PptxGenJS.Slide, page: number, source = defaultSourceLabel) => {
    slide.addShape(pptx.ShapeType.line, {
      x: 0.55, y: 7.02, w: 12.25, h: 0,
      line: { color: 'B8B8C7', width: 0.6 },
      objectName: `slot.slide.${page}.footer_rule`,
    })
    slide.addText(`来源：${source}　|　资料截止：${input.sourceCutoffDate}`, {
      x: 0.62, y: 7.1, w: 10.9, h: 0.18, fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 7.2, color: '77778B', margin: 0, fit: 'shrink',
      objectName: `slot.slide.${page}.footer_source`,
    })
    slide.addText(String(page), {
      x: 12, y: 7.08, w: 0.45, h: 0.2, fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 8, color: '77778B', align: 'right', margin: 0,
      objectName: `slot.slide.${page}.page_number`,
    })
  }
  const addLogo = (slide: PptxGenJS.Slide) => {
    if (templateAssets.logoPrimary) {
      slide.addImage({ data: templateAssets.logoPrimary, x: 0.25, y: 0.12, w: 1.2, h: 0.34, transparency: 0 })
    }
    if (templateAssets.logoSecondary) {
      slide.addImage({ data: templateAssets.logoSecondary, x: 1.52, y: 0.12, w: 0.42, h: 0.34, transparency: 0 })
    }
  }
  const addChrome = (slide: PptxGenJS.Slide, sectionLabel: string, title: string, page: number, source?: string) => {
    slide.background = { color: 'FFFFFF' }
    slide.addShape(pptx.ShapeType.parallelogram, {
      x: 0, y: 0, w: 2.05, h: 0.52,
      fill: { color: TEMPLATE_PURPLE_DARK },
      line: { color: TEMPLATE_PURPLE_DARK, transparency: 100 },
    })
    slide.addText(sectionLabel, {
      x: 0.22, y: 0.13, w: 1.38, h: 0.18,
      fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 10, bold: true, color: 'FFFFFF', margin: 0, fit: 'shrink',
      objectName: `slot.slide.${page}.section_label`,
    })
    slide.addText(title, {
      x: 0.72, y: 0.72, w: 11.2, h: 0.42,
      fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 20, bold: true, color: TEMPLATE_PURPLE_DARK, margin: 0, fit: 'shrink',
      objectName: `slot.slide.${page}.title`,
    })
    slide.addShape(pptx.ShapeType.line, {
      x: 0.72, y: 1.22, w: 11.65, h: 0,
      line: { color: '444444', width: 0.8 },
    })
    addFooter(slide, page, source)
  }

  const cover = pptx.addSlide()
  cover.background = { color: 'FFFFFF' }
  addLogo(cover)
  if (templateAssets.mountain) {
    cover.addImage({ data: templateAssets.mountain, x: 0, y: 5.9, w: 13.33, h: 1.6, transparency: 0 })
  } else {
    cover.addShape(pptx.ShapeType.rect, { x: 0, y: 5.9, w: 13.33, h: 1.6, fill: { color: TEMPLATE_PALE }, line: { transparency: 100 } })
  }
  cover.addText(input.project.name, {
    x: 2.1, y: 1.55, w: 9.1, h: 0.66,
    fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 30, bold: true, color: TEMPLATE_PURPLE_DARK, margin: 0, fit: 'shrink', align: 'center',
    objectName: 'cover.project_name',
  })
  cover.addText('投资建议书', {
    x: 3.7, y: 2.48, w: 6, h: 0.44,
    fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 22, bold: true, color: '20202A', margin: 0, align: 'center',
    objectName: 'cover.document_title',
  })
  cover.addText('内部讨论稿', {
    x: 4.7, y: 3.08, w: 4, h: 0.3,
    fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 13, color: '666675', margin: 0, align: 'center',
    objectName: 'cover.draft_label',
  })
  cover.addText(`${generatedDateLabel(input.sourceCutoffDate)}\n仅限内部讨论，不构成最终投资决策`, {
    x: 4.25, y: 4.15, w: 4.8, h: 0.64,
    fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 10.5, color: '555566', margin: 0, align: 'center', breakLine: false,
    objectName: 'cover.date_and_disclaimer',
  })

  const requestedMax = Number.parseInt(String(input.pageCount ?? '15'), 10)
  const maxSlides = Number.isFinite(requestedMax) ? Math.max(8, Math.min(requestedMax, 20)) : 15
  const overview = pptx.addSlide()
  addChrome(overview, '项目概览', '项目核心信息', 2)
  overview.addText('以下信息均为可编辑原生表格；待核验项须以正式底稿和交易文件为准。', {
    x: 0.72, y: 1.48, w: 11.4, h: 0.3, fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 11.2, color: '555566', margin: 0,
  })
  overview.addTable([
    [
      { text: '公司主体', options: { bold: true, color: 'FFFFFF', fill: { color: TEMPLATE_PURPLE } } },
      { text: text(input.project.companyName), options: { color: '20202A' } },
      { text: '所属行业', options: { bold: true, color: 'FFFFFF', fill: { color: TEMPLATE_PURPLE } } },
      { text: text(input.project.industry), options: { color: '20202A' } },
    ],
    [
      { text: '业务模式', options: { bold: true, color: 'FFFFFF', fill: { color: TEMPLATE_PURPLE } } },
      { text: text(input.project.businessModel), options: { color: '20202A' } },
      { text: '目标市场', options: { bold: true, color: 'FFFFFF', fill: { color: TEMPLATE_PURPLE } } },
      { text: text(input.project.market), options: { color: '20202A' } },
    ],
    [
      { text: '融资安排', options: { bold: true, color: 'FFFFFF', fill: { color: TEMPLATE_PURPLE } } },
      { text: text(input.project.financing), options: { color: '20202A' } },
      { text: '估值口径', options: { bold: true, color: 'FFFFFF', fill: { color: TEMPLATE_PURPLE } } },
      { text: text(input.project.valuation), options: { color: '20202A' } },
    ],
  ], {
    x: 0.72,
    y: 1.95,
    w: 11.85,
    h: 2.18,
    colW: [1.35, 4.25, 1.35, 4.9],
    rowH: [0.68, 0.82, 0.68],
    border: { type: 'solid', color: 'B8B8C7', pt: 0.8 },
    fontFace: PPT_FONT,
    lang: 'zh-CN',
    fontSize: 11.2,
    margin: 0.12,
    valign: 'middle',
    breakLine: false,
    objectName: 'section.project_overview.core_facts',
  })
  overview.addShape(pptx.ShapeType.rect, {
    x: 0.72, y: 4.6, w: 11.85, h: 1.22,
    fill: { color: TEMPLATE_PALE }, line: { color: 'C9C8E8', width: 0.8 },
  })
  overview.addText('初步判断', {
    x: 0.98, y: 4.93, w: 1.25, h: 0.25, fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 12, bold: true, color: TEMPLATE_PURPLE_DARK, margin: 0,
  })
  overview.addText(input.content.executiveSummary, {
    x: 2.25, y: 4.83, w: 9.75, h: 0.56, fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 11.2, color: '20202A', margin: 0.02, fit: 'shrink',
    objectName: 'section.project_overview.investment_judgment',
  })
  addSourceNotes(
    overview,
    input.content.executiveSummarySourceIndexes
      ?? input.content.sections.flatMap((section) =>
        section.findings.flatMap((finding) => finding.sourceIndexes)).slice(0, 8),
  )

  const agenda = pptx.addSlide()
  addChrome(agenda, '目录', '投资建议书内容框架', 3)
  const agendaItems = input.content.sections.slice(0, 12)
  agendaItems.forEach((section, index) => {
    const column = index >= 6 ? 1 : 0
    const row = index % 6
    const x = 1.1 + column * 5.9
    const y = 1.65 + row * 0.72
    agenda.addText(String(index + 1).padStart(2, '0'), {
      x, y, w: 0.55, h: 0.25, fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 11, bold: true, color: TEMPLATE_PURPLE, margin: 0,
    })
    agenda.addText(section.title, {
      x: x + 0.65, y: y - 0.02, w: 4.65, h: 0.3, fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 12.5, color: '252532', margin: 0, fit: 'shrink',
      objectName: `slot.agenda.section_${index + 1}`,
    })
  })

  const repeatedInClosing = /^(?:投资结论|核心风险|尽调缺口|下一步建议)$/
  const narrativeSections = input.content.sections.filter((section) => !repeatedInClosing.test(section.title))
  const closingSections = input.content.sections.filter((section) => repeatedInClosing.test(section.title))
  const selectedSections = [...narrativeSections, ...closingSections].slice(0, Math.max(1, maxSlides - 5))
  selectedSections.forEach((section, index) => {
    const slide = pptx.addSlide()
    const sourceNames = [...new Set(section.findings.flatMap((f) => f.sourceIndexes).map((i) => input.sources[i]?.sourceName).filter(Boolean))]
    addChrome(slide, sectionLabelFor(section.title), section.title, index + 4, sourceNames.join('、') || '项目档案与已授权资料')
    slide.addText(section.summary, {
      x: 0.75, y: 1.48, w: 11.75, h: 0.55,
      fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 14.5, bold: true, color: TEMPLATE_PURPLE_DARK, margin: 0.02, fit: 'shrink', valign: 'middle',
      objectName: `section.${index + 1}.summary`,
    })
    const findings = section.findings.slice(0, 4)
    findings.forEach((finding, findingIndex) => {
      const y = 2.28 + findingIndex * 0.94
      const style = statusStyle[finding.status]
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.8, y, w: 1.12, h: 0.32,
        fill: { color: finding.status === '资料记载' ? 'EBEBFF' : style.fill },
        line: { color: finding.status === '资料记载' ? TEMPLATE_PURPLE : style.color, width: 0.6 },
        objectName: `section.${index + 1}.finding.${findingIndex + 1}.status_background`,
      })
      slide.addText(finding.status, {
        x: 0.84, y: y + 0.065, w: 1.03, h: 0.16,
        fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 8.5, bold: true,
        color: finding.status === '资料记载' ? TEMPLATE_PURPLE_DARK : style.color, align: 'center', margin: 0,
        objectName: `section.${index + 1}.finding.${findingIndex + 1}.status`,
      })
      slide.addText(finding.text, {
        x: 2.18, y: y - 0.04, w: 9.75, h: 0.48,
        fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 11.5, color: '20202A', margin: 0.02, fit: 'shrink', breakLine: false,
        objectName: `section.${index + 1}.finding.${findingIndex + 1}.text`,
      })
      const refs = sourceText(finding.sourceIndexes, input.sources)
      if (refs) slide.addText(refs, {
        x: 2.18, y: y + 0.52, w: 9.75, h: 0.16,
        fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 7.4, color: '77778B', margin: 0, fit: 'shrink',
        objectName: `section.${index + 1}.finding.${findingIndex + 1}.citation`,
      })
    })
    addSourceNotes(slide, [
      ...(section.summarySourceIndexes ?? []),
      ...findings.flatMap((finding) => finding.sourceIndexes),
    ])
  })

  const closing = pptx.addSlide()
  addChrome(closing, '投资结论', '投资判断仍取决于关键证据闭环', selectedSections.length + 4)
  const columns = [
    { title: '投资亮点', values: input.content.highlights, color: '226B47', fill: 'F2F8F4' },
    { title: '主要风险', values: input.content.risks, color: '9B3A3A', fill: 'FBF2F2' },
    { title: '资料缺口', values: input.content.missing, color: '9A6200', fill: 'FFF8E8' },
  ]
  columns.forEach((column, index) => {
    const x = 0.78 + index * 4.15
    closing.addShape(pptx.ShapeType.rect, { x, y: 1.72, w: 3.72, h: 4.65, fill: { color: column.fill }, line: { color: 'C9C8D8', width: 0.8 } })
    closing.addText(column.title, {
      x: x + 0.25, y: 2.02, w: 3.15, h: 0.3,
      fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 14, bold: true, color: column.color, margin: 0,
      objectName: `closing.column.${index + 1}.title`,
    })
    closing.addText(column.values.slice(0, 5).map((value) => ({ text: value, options: { bullet: { indent: 14 }, breakLine: true } })), {
      x: x + 0.27, y: 2.55, w: 3.05, h: 3.1,
      fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 10.8, color: '20202A', margin: 0.02, breakLine: false, fit: 'shrink', paraSpaceAfter: 8,
      objectName: `closing.column.${index + 1}.content`,
    })
  })
  addSourceNotes(
    closing,
    input.content.sections.flatMap((section) =>
      section.findings.flatMap((finding) => finding.sourceIndexes)),
  )

  const referencesSlide = pptx.addSlide()
  addChrome(referencesSlide, '附录', '引用资料与责任声明', selectedSections.length + 5, '正文实际引用来源见本页')
  const referenceLines = references.length
    ? references.slice(0, 12).map((source) => bibliographyLine(source))
    : ['当前项目知识库无可用引用资料；所有实质性内容均需补证并人工核验。']
  const columnsCount = referenceLines.length > 6 ? 2 : 1
  referenceLines.forEach((line, index) => {
    const column = columnsCount === 2 && index >= Math.ceil(referenceLines.length / 2) ? 1 : 0
    const row = columnsCount === 2 ? index % Math.ceil(referenceLines.length / 2) : index
    referencesSlide.addText(line, {
      x: 0.86 + column * 6.05,
      y: 1.58 + row * 0.62,
      w: columnsCount === 2 ? 5.55 : 11.55,
      h: 0.42,
      fontFace: PPT_FONT,
      lang: 'zh-CN',
      fontSize: 9.5,
      color: '252532',
      margin: 0,
      breakLine: false,
      fit: 'shrink',
      objectName: `references.entry.${index + 1}`,
    })
  })
  referencesSlide.addShape(pptx.ShapeType.rect, {
    x: 0.82, y: 5.65, w: 11.7, h: 0.78,
    fill: { color: TEMPLATE_PALE },
    line: { color: 'C9C8E8', width: 0.8 },
  })
  referencesSlide.addText(input.template.disclaimer, {
    x: 1.05, y: 5.9, w: 11.2, h: 0.28,
    fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 9.5, color: '555566', margin: 0, align: 'center', fit: 'shrink',
    objectName: 'references.disclaimer',
  })
  addSourceNotes(
    referencesSlide,
    usedBusinessSourceIndexes(input.content, input.sources.length),
  )
  await pptx.writeFile({ fileName: input.outputPath })
  const outputZip = await JSZip.loadAsync(await readFile(input.outputPath))
  const slideParts = Object.keys(outputZip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  for (const slidePart of slideParts) {
    const file = outputZip.file(slidePart)
    if (!file) continue
    const xml = await file.async('string')
    outputZip.file(
      slidePart,
      xml
        .replace(/lang="en-US"/g, 'lang="zh-CN"')
        .replace(/Arial Unicode MS/g, PPT_FONT),
    )
  }
  const themePart = outputZip.file('ppt/theme/theme1.xml')
  if (themePart) {
    const themeXml = await themePart.async('string')
    outputZip.file(
      'ppt/theme/theme1.xml',
      themeXml
        .replace(/<a:ea typeface="[^"]*"\s*\/>/g, `<a:ea typeface="${PPT_FONT}"/>`)
        .replace(/Arial Unicode MS/g, PPT_FONT),
    )
  }
  await writeFile(input.outputPath, await outputZip.generateAsync({ type: 'nodebuffer' }))
  return {
    slideCount: selectedSections.length + 5,
    editableLevel: 'core-elements',
    templateApplied: true,
    templateSha256: createHash('sha256').update(templateBuffer).digest('hex'),
    inheritedCompanyAssets: Object.values(templateAssets).filter(Boolean).length,
    cjkFont: PPT_FONT,
    cjkLanguage: 'zh-CN',
  }
}

export function mustUseReferenceDrivenPptPipeline(
  template: AiTemplateDefinition,
) {
  return template.type === 'investment_recommendation_ppt'
}

export function assertInvestmentRecommendationSkillChain(
  metadata: Record<string, unknown>,
) {
  const expectedSequence = [
    'create-reference-driven-editable-ppt',
    'GordenSuperPPTSkill',
    'GordenImagePPTGen',
    'pdf-to-editable-ppt',
  ]
  const workflowAudit = metadata.workflowAudit as Record<string, unknown> | undefined
  const strictSequence = Array.isArray(workflowAudit?.strictSequence)
    ? workflowAudit.strictSequence.map(String)
    : []
  const packageComponents = Array.isArray(workflowAudit?.packageComponents)
    ? workflowAudit.packageComponents.map(String)
    : []
  const valid = metadata.generationSkill === expectedSequence[0]
    && metadata.generationRuntime === 'create-reference-driven-editable-ppt'
    && metadata.templateApplied === false
    && metadata.editableLevel === 'all'
    && strictSequence.join('\u0000') === expectedSequence.join('\u0000')
    && /^[a-f0-9]{64}$/.test(String(workflowAudit?.packageSha256 || ''))
    && packageComponents.join('\u0000') === [
      'GordenSuperPPTSkill',
      'GordenImagePPTGen',
      'GordenImage2PPTX',
    ].join('\u0000')
    && workflowAudit?.skillInstructionsInjected === true
    && workflowAudit?.imageDeckPublishedBeforeEditable === true
    && workflowAudit?.pipelineHandoffPassed === true
  if (!valid) {
    throw Object.assign(
      new Error('投资建议书未完整执行图片版先交付、元素级可编辑版后交付的技能链路'),
      { code: 'INVESTMENT_PPT_SKILL_CHAIN_NOT_EXECUTED' },
    )
  }
}

export async function generateBusinessPptxPreview(input: {
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sourceCutoffDate: string
}) {
  await mkdir(path.dirname(input.outputPath), { recursive: true })
  const customCanvas = input.template.customAnalysis?.format === 'pptx'
    ? customPptSize(input.template)
    : undefined
  const width = 1600
  const height = customCanvas
    ? Math.round(width * customCanvas.height / customCanvas.width)
    : 900
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  const customProfile = input.template.customAnalysis?.formatProfile
  const previewFont = customProfile?.primaryFont || PPT_FALLBACK_FONT
  const fontStack = `"${previewFont}", "Hiragino Sans GB", sans-serif`
  if (input.template.customAnalysis?.format === 'pptx') {
    const primary = validHex(customProfile?.colors[0], '3E3AAE')
    const pale = validHex(customProfile?.colors.find((color) => /^F/i.test(color)), 'F3F3FA')
    context.fillStyle = '#FFFFFF'
    context.fillRect(0, 0, width, height)
    context.fillStyle = `#${primary}`
    context.fillRect(0, 0, width, Math.max(10, height * 0.08))
    context.fillStyle = `#${pale}`
    context.fillRect(0, height * 0.78, width, height * 0.22)
    context.textAlign = 'center'
    context.fillStyle = `#${primary}`
    context.font = `700 ${Math.round(height * 0.068)}px ${fontStack}`
    drawWrappedText(
      context,
      input.project.name,
      width / 2,
      height * 0.31,
      width * 0.78,
      height * 0.08,
      2,
    )
    context.fillStyle = '#222222'
    context.font = `700 ${Math.round(height * 0.047)}px ${fontStack}`
    drawWrappedText(
      context,
      input.content.title,
      width / 2,
      height * 0.5,
      width * 0.72,
      height * 0.06,
      2,
    )
    context.fillStyle = '#666666'
    context.font = `400 ${Math.round(height * 0.026)}px ${fontStack}`
    context.fillText(`资料截止：${input.sourceCutoffDate}`, width / 2, height * 0.67)
    await writeFile(input.outputPath, canvas.toBuffer('image/png'))
    return {
      width,
      height,
      previewSlide: 1,
      templateApplied: true,
      inheritedCompanyAssets: 0,
      cjkFont: previewFont,
      customTemplate: true,
    }
  }
  const templateZip = await JSZip.loadAsync(await readFile(input.template.referencePath))

  context.fillStyle = '#FFFFFF'
  context.fillRect(0, 0, width, height)
  const drawTemplateImage = async (part: string, x: number, y: number, w: number, h: number) => {
    const file = templateZip.file(part)
    if (!file) return
    const image = await loadImage(await file.async('nodebuffer'))
    context.drawImage(image, x, y, w, h)
  }
  await drawTemplateImage('ppt/media/image1.jpeg', 0, 708, width, 192)
  await drawTemplateImage('ppt/media/image4.png', 30, 22, 145, 42)
  await drawTemplateImage('ppt/media/image5.png', 184, 22, 50, 42)

  context.textAlign = 'center'
  context.fillStyle = `#${TEMPLATE_PURPLE_DARK}`
  context.font = `700 58px ${fontStack}`
  drawWrappedText(context, input.project.name, 800, 280, 1050, 70, 2)
  context.fillStyle = '#20202A'
  context.font = `700 42px ${fontStack}`
  context.fillText('投资建议书', 800, 430)
  context.fillStyle = '#666675'
  context.font = `400 24px ${fontStack}`
  context.fillText('内部讨论稿', 800, 490)
  context.font = `400 18px ${fontStack}`
  context.fillText(`资料截止：${input.sourceCutoffDate}`, 800, 590)
  context.fillText('仅限内部讨论，不构成最终投资决策', 800, 625)
  context.textAlign = 'left'

  await writeFile(input.outputPath, canvas.toBuffer('image/png'))
  return {
    width,
    height,
    previewSlide: 1,
    templateApplied: true,
    inheritedCompanyAssets: 3,
    cjkFont: PPT_FALLBACK_FONT,
  }
}

export function makeArtifactFileName(
  projectName: string,
  template: AiTemplateDefinition,
  timestamp = Date.now(),
  generatedTitle?: string,
) {
  const documentName = template.type === 'investment_recommendation_ppt'
    ? '投资建议书'
    : template.type === 'custom_template_document' && generatedTitle
      ? generatedTitle
      : template.label
  return `${safeName(projectName)}_${safeName(documentName)}_${timestamp}.${template.outputFormat}`
}

export function renderBusinessMarkdown(input: {
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
}) {
  if (input.template.type === 'compliance_statement') {
    const sectionByTitle = new Map(input.content.sections.map((section) => [section.title, section]))
    const findingTexts = (title: string) => (sectionByTitle.get(title)?.findings ?? [])
      .map((finding) => sanitizeClientVisibleEvidenceWording(
        finding.text.replace(/^\s*\d+[、.．]\s*/, ''),
      ))
      .filter(Boolean)
    const lines = [
      `# ${input.content.title}`,
      '',
      '## 一、公司情况介绍',
    ]
    ;(['公司简介', '核心团队', '产品及技术'] as const).forEach((title, index) => {
      lines.push('', `### （${index + 1}）${title}`, '', ...findingTexts(title))
    })
    lines.push('', '## 二、投资理由', '')
    findingTexts('投资理由').slice(0, 5).forEach((value, index) => {
      lines.push(`${index + 1}、${value}`, '')
    })
    lines.push('## 三、投资计划', '', ...findingTexts('投资计划'))
    lines.push('', '## 四、投资情形分析', '')
    findingTexts('投资情形分析').slice(0, 7).forEach((value, index) => {
      lines.push(`${index + 1}、${value}`, '')
    })
    const conclusion = findingTexts('结论')
    lines.push(
      ...(conclusion.length ? conclusion : [input.content.executiveSummary]),
      '',
      '浙江赛智伯乐股权投资管理有限公司',
      '',
      complianceDateLabel(new Date()),
    )
    return `${lines.join('\n')}\n`
  }

  const lines = [
    `# ${input.content.title}`,
    '',
    `> ${input.template.disclaimer}`,
    '',
    `- 项目：${input.project.name}`,
    `- 公司主体：${text(input.project.companyName)}`,
    `- 资料截止日：${input.sourceCutoffDate}`,
    `- 版式：${input.template.customAnalysis ? '用户上传模板' : input.template.label}`,
    '',
    '## 摘要',
    '',
    input.content.executiveSummary,
  ]
  const emitted = new Set<string>()
  input.content.sections.forEach((section, sectionIndex) => {
    lines.push('', `## ${sectionIndex + 1}. ${section.title}`, '', section.summary)
    section.findings.forEach((finding) => {
      if (emitted.has(finding.text)) return
      emitted.add(finding.text)
      const refs = finding.sourceIndexes
        .map((index) => input.sources[index] ? `[S${index + 1}]` : '')
        .filter(Boolean)
        .join(' ')
      lines.push(
        '',
        input.template.type === 'custom_template_document'
          ? `${sanitizeClientVisibleEvidenceWording(finding.text)}${refs ? ` ${refs}` : ''}`
          : `- ${sanitizeClientVisibleEvidenceWording(finding.text)}${refs ? ` ${refs}` : ''}`,
      )
    })
  })
  lines.push('', '## 引用资料', '')
  const references = usedSourceGroups(input.content, input.sources)
  if (references.length) {
    references.forEach((source) => {
      lines.push(`- ${bibliographyLine(source)}`)
    })
  } else {
    lines.push('- 当前项目知识库无可用引用资料。')
  }
  return `${lines.join('\n')}\n`
}
