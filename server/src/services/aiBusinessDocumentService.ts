import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx'
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BusinessContent, EvidenceSource } from './aiBusinessContentService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'

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

const BLUE = '1B4685'
const DARK = '17243A'
const MUTED = '5E6D82'
const LIGHT_BLUE = 'EEF4FB'
const LINE = 'D8E2EF'
const AMBER = 'FFF5D9'
const RED = 'FDECEC'
const GREEN = 'EAF7F0'
const TEMPLATE_PURPLE = '625FE7'
const TEMPLATE_PURPLE_DARK = '3E3AAE'
const TEMPLATE_PALE = 'F3F3FA'
const DOCX_SANS_FONT = process.env.AI_DOCUMENT_SANS_FONT || '黑体'
const DOCX_SONG_FONT = process.env.AI_DOCUMENT_SONG_FONT || '宋体'
const DOCX_FANGSONG_FONT = process.env.AI_DOCUMENT_FANGSONG_FONT || '仿宋'
const PPT_FONT = process.env.AI_PRESENTATION_FONT || '微软雅黑'
const PPT_FALLBACK_FONT = process.env.AI_PRESENTATION_FALLBACK_FONT || 'Hiragino Sans GB'

const docxFont = (eastAsia: string) => ({
  ascii: 'Arial',
  hAnsi: 'Arial',
  cs: 'Times New Roman',
  eastAsia,
})

function docxTemplateProfile(template: AiTemplateDefinition) {
  if (template.type === 'compliance_statement') {
    return {
      bodyFont: DOCX_SONG_FONT,
      headingFont: DOCX_SANS_FONT,
      accent: '1F4E79',
      coverTitle: `关于${template.label.replace('合规性说明', '')}`,
      header: '',
    }
  }
  return {
    bodyFont: DOCX_FANGSONG_FONT,
    headingFont: DOCX_SANS_FONT,
    accent: TEMPLATE_PURPLE_DARK,
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

const safeName = (value: string) => value.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
const text = (value: unknown, fallback = '待核验') => String(value ?? '').trim() || fallback
const generatedDateLabel = (sourceCutoffDate: string) => `资料截止：${sourceCutoffDate}`

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
  const names = [...new Set(indexes.map((index) => sources[index]?.sourceName).filter(Boolean))]
  return names.length ? `来源：${names.join('、')}` : ''
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
    spacing: { before: options.before ?? 0, after: options.after ?? 140, line: 330 },
    indent: options.firstLine ? { firstLine: options.firstLine } : undefined,
    alignment: options.align,
    keepNext: options.keepNext,
  })
}

function keyValueCell(label: string, value: string, labelCell = false, font = DOCX_SONG_FONT, accent = BLUE) {
  return new TableCell({
    width: { size: labelCell ? 1350 : 3150, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    shading: labelCell ? { type: ShadingType.CLEAR, fill: 'E9E9E9' } : undefined,
    margins: { top: 120, bottom: 120, left: 140, right: 140 },
    children: [paragraph(labelCell ? label : value, {
      bold: labelCell,
      color: labelCell ? accent : '000000',
      size: 22,
      after: 0,
      font,
    })],
  })
}

export async function generateBusinessDocx(input: {
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  generatedAt?: Date
}) {
  await mkdir(path.dirname(input.outputPath), { recursive: true })
  const generatedAt = input.generatedAt ?? new Date()
  const profile = docxTemplateProfile(input.template)
  const runFont = (font = profile.bodyFont) => docxFont(font)
  const heading = (value: string, level: 1 | 2 = 1, pageBreakBefore = false) => new Paragraph({
    pageBreakBefore,
    keepNext: true,
    spacing: {
      before: level === 1 ? 300 : 220,
      after: level === 1 ? 180 : 120,
      line: 360,
    },
    children: [new TextRun({
      text: value,
      font: runFont(level === 1 ? profile.headingFont : profile.bodyFont),
      size: level === 1 ? 30 : 26,
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
    size: options.size ?? 24,
    bold: options.bold,
    firstLine: options.firstLine === false ? 0 : 480,
    keepNext: options.keepNext,
    after: 160,
  })
  const templateHeader = profile.header
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
  const metadataTable = new Table({
    width: { size: 9000, type: WidthType.DXA },
    columnWidths: [1350, 3150, 1350, 3150],
    rows: [
      new TableRow({
        children: [
          keyValueCell('公司主体', '', true, profile.bodyFont, profile.accent),
          keyValueCell('', text(input.project.companyName), false, profile.bodyFont, profile.accent),
          keyValueCell('所属行业', '', true, profile.bodyFont, profile.accent),
          keyValueCell('', text(input.project.industry), false, profile.bodyFont, profile.accent),
        ],
      }),
      new TableRow({
        children: [
          keyValueCell('项目阶段', '', true, profile.bodyFont, profile.accent),
          keyValueCell('', text(input.project.stage), false, profile.bodyFont, profile.accent),
          keyValueCell('资料截止日', '', true, profile.bodyFont, profile.accent),
          keyValueCell('', input.sourceCutoffDate, false, profile.bodyFont, profile.accent),
        ],
      }),
      new TableRow({
        children: [
          keyValueCell('文件性质', '', true, profile.bodyFont, profile.accent),
          keyValueCell('', 'AI 辅助生成的内部初稿', false, profile.bodyFont, profile.accent),
          keyValueCell('生成时间', '', true, profile.bodyFont, profile.accent),
          keyValueCell('', generatedAt.toLocaleString('zh-CN'), false, profile.bodyFont, profile.accent),
        ],
      }),
    ],
  })
  const disclaimerParagraph = new Paragraph({
    spacing: { before: 260, after: 220, line: 330 },
    border: { top: { color: '888888', size: 6, style: BorderStyle.SINGLE } },
    children: [new TextRun({
      text: input.template.disclaimer,
      font: runFont(profile.bodyFont),
      size: 20,
      color: '555555',
      italics: true,
    })],
  })

  const contentChildren: Array<Paragraph | Table> = [
    heading('摘要'),
    bodyParagraph(input.content.executiveSummary),
  ]

  if (input.template.type === 'compliance_statement') {
    const verified = input.content.sections.flatMap((section) => section.findings)
      .filter((finding) => finding.status === '资料记载')
      .slice(0, 5)
    const pending = input.content.sections.flatMap((section) => section.findings)
      .filter((finding) => finding.status === '待核验' || finding.status === 'AI推断')
      .slice(0, 5)
    const complianceBlocks = [
      { title: '已核验事实', values: verified.map((finding) => finding.text), tone: '226B47' },
      { title: '风险提示', values: input.content.risks, tone: '9B3A3A' },
      { title: '待核验事项', values: pending.map((finding) => finding.text), tone: '9A6200' },
      { title: '资料缺口', values: input.content.missing, tone: 'A13B3B' },
      { title: '免责声明', values: [input.template.disclaimer], tone: '8A5B00' },
    ]
    complianceBlocks.forEach((block) => {
      contentChildren.push(heading(block.title, 2))
      const values = block.values.length ? block.values : ['当前无可列示内容，须由法务或风控人员补充核验。']
      values.forEach((value, valueIndex) => contentChildren.push(new Paragraph({
        spacing: { after: 120, line: 360 },
        indent: { left: 420, hanging: 300 },
        keepNext: valueIndex < values.length - 1,
        children: [
          new TextRun({ text: '• ', font: runFont(profile.bodyFont), size: 24, color: block.tone, bold: true }),
          new TextRun({ text: value, font: runFont(profile.bodyFont), size: 24, color: '000000' }),
        ],
      })))
    })
  }

  input.content.sections.forEach((section, sectionIndex) => {
    const shouldBreak = input.template.type === 'due_diligence_report'
      ? sectionIndex > 0
      : input.template.type === 'investment_proposal' && sectionIndex > 0 && sectionIndex % 2 === 0
    contentChildren.push(heading(`${sectionIndex + 1}. ${section.title}`, 1, shouldBreak))
    contentChildren.push(bodyParagraph(section.summary, {
      bold: true,
      color: profile.accent,
      firstLine: false,
      keepNext: section.findings.length > 0,
    }))
    section.findings.forEach((finding, findingIndex) => {
      const style = statusStyle[finding.status]
      const refs = sourceText(finding.sourceIndexes, input.sources)
      contentChildren.push(new Paragraph({
        spacing: { after: 150, line: 360 },
        keepNext: findingIndex < section.findings.length - 1,
        indent: { firstLine: 480 },
        children: [
          new TextRun({ text: `【${finding.status}】`, bold: true, color: style.color, size: 22, font: runFont(profile.bodyFont) }),
          new TextRun({ text: finding.text, color: '000000', size: 24, font: runFont(profile.bodyFont) }),
          ...(refs ? [new TextRun({ text: `\n${refs}`, color: '666666', size: 18, font: runFont(profile.bodyFont), italics: true })] : []),
        ],
      }))
    })
  })

  const addListSection = (title: string, values: string[], tone: string) => {
    contentChildren.push(heading(title))
    const safeValues = values.length ? values : ['当前无可列示内容，需补充资料后核验。']
    safeValues.forEach((value) => contentChildren.push(new Paragraph({
      spacing: { after: 120, line: 360 },
      indent: { left: 420, hanging: 300 },
      children: [
        new TextRun({ text: '• ', font: runFont(profile.bodyFont), size: 24, color: tone, bold: true }),
        new TextRun({ text: value, font: runFont(profile.bodyFont), size: 24, color: '000000' }),
      ],
    })))
  }
  addListSection('投资亮点', input.content.highlights, '226B47')
  addListSection('主要风险', input.content.risks, '9B3A3A')
  addListSection('资料缺口与后续核验', input.content.missing, '9A6200')

  contentChildren.push(heading('引用资料', 1, true))
  if (input.sources.length) {
    input.sources.forEach((source, index) => contentChildren.push(paragraph(
      `[S${index + 1}] ${source.sourceName}，${source.sourceType}，片段 ${source.chunkIndex ?? index}`,
      { size: 19, color: '555555', after: 90, font: profile.bodyFont, firstLine: 0 },
    )))
  } else {
    contentChildren.push(paragraph('当前项目知识库无可用引用资料；所有实质性内容均需补证并人工核验。', {
      color: 'A13B3B',
      size: 22,
      font: profile.bodyFont,
    }))
  }

  const basePage = {
    size: { width: 11906, height: 16838 },
    margin: { top: 1440, right: 1800, bottom: 1498, left: 1800, header: 720, footer: 720 },
    pageNumbers: { start: 1 },
  }
  const commonSection = {
    properties: { page: basePage },
    headers: templateHeader ? { default: templateHeader } : undefined,
    footers: { default: pageFooter },
  }
  const title = input.template.type === 'compliance_statement'
    ? `关于${input.project.name}项目投资合规性的说明`
    : `${input.project.name}${input.template.label}`
  const coverChildren: Array<Paragraph | Table> = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: input.template.type === 'due_diligence_report' ? 1800 : 420, after: 320 },
      children: [new TextRun({
        text: '浙江赛智伯乐股权投资管理有限公司',
        font: runFont(profile.headingFont),
        size: 24,
        bold: true,
        color: '000000',
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: input.template.type === 'due_diligence_report' ? 1000 : 300, after: 420, line: 420 },
      children: [new TextRun({
        text: title,
        font: runFont(profile.headingFont),
        size: input.template.type === 'due_diligence_report' ? 44 : 36,
        bold: true,
        color: '000000',
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 500 },
      children: [new TextRun({
        text: '（AI 辅助初稿）',
        font: runFont(profile.bodyFont),
        size: 24,
        color: '555555',
      })],
    }),
    metadataTable,
    disclaimerParagraph,
  ]
  if (input.template.type === 'due_diligence_report') {
    coverChildren.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1200 },
      children: [new TextRun({
        text: generatedAt.toLocaleDateString('zh-CN'),
        font: runFont(profile.bodyFont),
        size: 24,
        color: '000000',
      })],
    }))
  }

  const sections = input.template.type === 'due_diligence_report'
    ? [
      {
        properties: { page: basePage },
        children: coverChildren,
      },
      {
        ...commonSection,
        properties: { page: { ...basePage, pageNumbers: { start: 1 } } },
        children: [
          heading('目录'),
          ...input.template.sections.map((section, index) => new Paragraph({
            spacing: { after: 140 },
            children: [
              new TextRun({ text: `${index + 1}. ${section}`, font: runFont(profile.bodyFont), size: 24, color: '000000' }),
            ],
          })),
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
    title: input.content.title,
    description: `${input.template.label} AI 初稿；使用 docs 公司参考模板的版式规范`,
    styles: {
      default: {
        document: {
          run: { font: runFont(profile.bodyFont), size: 24, color: '000000' },
          paragraph: { spacing: { after: 160, line: 360 } },
        },
        heading1: {
          run: { font: runFont(profile.headingFont), size: 30, bold: true, color: '000000' },
          paragraph: { spacing: { before: 300, after: 180 }, keepNext: true },
        },
        heading2: {
          run: { font: runFont(profile.bodyFont), size: 26, bold: true, color: '000000' },
          paragraph: { spacing: { before: 240, after: 120 }, keepNext: true },
        },
      },
    },
    sections,
  })
  await writeFile(input.outputPath, await Packer.toBuffer(doc))
  const templateBuffer = await readFile(input.template.referencePath)
  const outputZip = await JSZip.loadAsync(await readFile(input.outputPath))
  const templateZip = await JSZip.loadAsync(templateBuffer)
  const templateParts = [
    'word/theme/theme1.xml',
    'word/fontTable.xml',
  ]
  const appliedParts: string[] = []
  for (const part of templateParts) {
    const sourcePart = templateZip.file(part)
    if (!sourcePart || !outputZip.file(part)) continue
    outputZip.file(part, await sourcePart.async('nodebuffer'))
    appliedParts.push(part)
  }
  await writeFile(input.outputPath, await outputZip.generateAsync({ type: 'nodebuffer' }))
  return {
    pageIntent: input.template.type === 'due_diligence_report' ? 'long-form' : 'brief',
    templateApplied: true,
    templateSha256: createHash('sha256').update(templateBuffer).digest('hex'),
    templateParts: appliedParts,
    typography: { body: profile.bodyFont, heading: profile.headingFont },
  }
}

export async function generateBusinessPptx(input: {
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  pageCount?: string
}) {
  await mkdir(path.dirname(input.outputPath), { recursive: true })
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

  const addFooter = (slide: PptxGenJS.Slide, page: number, source = '项目档案与已授权资料') => {
    slide.addShape(pptx.ShapeType.line, { x: 0.55, y: 7.02, w: 12.25, h: 0, line: { color: 'B8B8C7', width: 0.6 } })
    slide.addText(`来源：${source}　|　资料截止：${input.sourceCutoffDate}`, {
      x: 0.62, y: 7.1, w: 10.9, h: 0.18, fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 7.2, color: '77778B', margin: 0, fit: 'shrink',
    })
    slide.addText(String(page), {
      x: 12, y: 7.08, w: 0.45, h: 0.2, fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 8, color: '77778B', align: 'right', margin: 0,
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
    })
    slide.addText(title, {
      x: 0.72, y: 0.72, w: 11.2, h: 0.42,
      fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 20, bold: true, color: TEMPLATE_PURPLE_DARK, margin: 0, fit: 'shrink',
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
  })
  cover.addText('投资建议书', {
    x: 3.7, y: 2.48, w: 6, h: 0.44,
    fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 22, bold: true, color: '20202A', margin: 0, align: 'center',
  })
  cover.addText('AI 辅助初稿', {
    x: 4.7, y: 3.08, w: 4, h: 0.3,
    fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 13, color: '666675', margin: 0, align: 'center',
  })
  cover.addText(`${generatedDateLabel(input.sourceCutoffDate)}\n仅限内部讨论，不构成最终投资决策`, {
    x: 4.25, y: 4.15, w: 4.8, h: 0.64,
    fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 10.5, color: '555566', margin: 0, align: 'center', breakLine: false,
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
      { text: '项目阶段', options: { bold: true, color: 'FFFFFF', fill: { color: TEMPLATE_PURPLE } } },
      { text: text(input.project.stage), options: { color: '20202A' } },
      { text: '融资安排', options: { bold: true, color: 'FFFFFF', fill: { color: TEMPLATE_PURPLE } } },
      { text: text(input.project.financing), options: { color: '20202A' } },
    ],
    [
      { text: '估值口径', options: { bold: true, color: 'FFFFFF', fill: { color: TEMPLATE_PURPLE } } },
      { text: text(input.project.valuation), options: { color: '20202A' } },
      { text: '资料截止日', options: { bold: true, color: 'FFFFFF', fill: { color: TEMPLATE_PURPLE } } },
      { text: input.sourceCutoffDate, options: { color: '20202A' } },
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
  })

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
    })
  })

  const selectedSections = input.content.sections.slice(0, Math.max(1, maxSlides - 5))
  selectedSections.forEach((section, index) => {
    const slide = pptx.addSlide()
    const sourceNames = [...new Set(section.findings.flatMap((f) => f.sourceIndexes).map((i) => input.sources[i]?.sourceName).filter(Boolean))]
    addChrome(slide, sectionLabelFor(section.title), section.title, index + 4, sourceNames.join('、') || '项目档案与已授权资料')
    slide.addText(section.summary, {
      x: 0.75, y: 1.48, w: 11.75, h: 0.55,
      fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 14.5, bold: true, color: TEMPLATE_PURPLE_DARK, margin: 0.02, fit: 'shrink', valign: 'middle',
    })
    const findings = section.findings.slice(0, 4)
    findings.forEach((finding, findingIndex) => {
      const y = 2.28 + findingIndex * 0.94
      const style = statusStyle[finding.status]
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.8, y, w: 1.12, h: 0.32,
        fill: { color: finding.status === '资料记载' ? 'EBEBFF' : style.fill },
        line: { color: finding.status === '资料记载' ? TEMPLATE_PURPLE : style.color, width: 0.6 },
      })
      slide.addText(finding.status, {
        x: 0.84, y: y + 0.065, w: 1.03, h: 0.16,
        fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 8.5, bold: true,
        color: finding.status === '资料记载' ? TEMPLATE_PURPLE_DARK : style.color, align: 'center', margin: 0,
      })
      slide.addText(finding.text, {
        x: 2.18, y: y - 0.04, w: 9.75, h: 0.48,
        fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 11.5, color: '20202A', margin: 0.02, fit: 'shrink', breakLine: false,
      })
      const refs = sourceText(finding.sourceIndexes, input.sources)
      if (refs) slide.addText(refs, {
        x: 2.18, y: y + 0.52, w: 9.75, h: 0.16,
        fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 7.4, color: '77778B', margin: 0, fit: 'shrink',
      })
    })
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
    })
    closing.addText(column.values.slice(0, 5).map((value) => ({ text: value, options: { bullet: { indent: 14 }, breakLine: true } })), {
      x: x + 0.27, y: 2.55, w: 3.05, h: 3.1,
      fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 10.8, color: '20202A', margin: 0.02, breakLine: false, fit: 'shrink', paraSpaceAfter: 8,
    })
  })

  const thanks = pptx.addSlide()
  thanks.background = { color: 'FFFFFF' }
  addLogo(thanks)
  if (templateAssets.mountain) {
    thanks.addImage({ data: templateAssets.mountain, x: 0, y: 5.9, w: 13.33, h: 1.6, transparency: 0 })
  }
  thanks.addText('谢谢观看！', {
    x: 3.7, y: 2.45, w: 6, h: 0.62,
    fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 30, bold: true, color: TEMPLATE_PURPLE_DARK, margin: 0, align: 'center',
  })
  thanks.addText(input.template.disclaimer, {
    x: 3.15, y: 3.45, w: 7, h: 0.5,
    fontFace: PPT_FONT, lang: 'zh-CN', fontSize: 10, color: '555566', margin: 0, align: 'center', fit: 'shrink',
  })
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

export async function generateBusinessPptxPreview(input: {
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sourceCutoffDate: string
}) {
  await mkdir(path.dirname(input.outputPath), { recursive: true })
  const width = 1600
  const height = 900
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  const fontStack = `"${PPT_FALLBACK_FONT}", "Hiragino Sans GB", sans-serif`
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
  context.fillText('AI 辅助初稿', 800, 490)
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

export function makeArtifactFileName(projectName: string, template: AiTemplateDefinition, timestamp = Date.now()) {
  return `${safeName(projectName)}_${template.label}_${timestamp}.${template.outputFormat}`
}

export function renderBusinessMarkdown(input: {
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
}) {
  const lines = [
    `# ${input.content.title}`,
    '',
    `> ${input.template.disclaimer}`,
    '',
    `- 项目：${input.project.name}`,
    `- 公司主体：${text(input.project.companyName)}`,
    `- 资料截止日：${input.sourceCutoffDate}`,
    '- 版式：公司标准模板',
    '',
    '## 摘要',
    '',
    input.content.executiveSummary,
  ]
  if (input.template.type === 'compliance_statement') {
    const verified = input.content.sections.flatMap((section) => section.findings)
      .filter((finding) => finding.status === '资料记载')
      .map((finding) => finding.text)
      .slice(0, 8)
    const pending = input.content.sections.flatMap((section) => section.findings)
      .filter((finding) => finding.status === '待核验' || finding.status === 'AI推断')
      .map((finding) => finding.text)
      .slice(0, 8)
    const blocks = [
      ['已核验事实', verified],
      ['风险提示', input.content.risks],
      ['待核验事项', pending],
      ['资料缺口', input.content.missing],
      ['免责声明', [input.template.disclaimer]],
    ] as const
    blocks.forEach(([title, values]) => {
      lines.push('', `## ${title}`, '', ...(values.length ? values : ['当前无可列示内容，须由法务或风控人员补充核验。']).map((value) => `- ${value}`))
    })
  }
  input.content.sections.forEach((section, sectionIndex) => {
    lines.push('', `## ${sectionIndex + 1}. ${section.title}`, '', section.summary)
    section.findings.forEach((finding) => {
      const refs = finding.sourceIndexes
        .map((index) => input.sources[index] ? `[S${index + 1}]` : '')
        .filter(Boolean)
        .join(' ')
      lines.push('', `- **${finding.status}** ${finding.text}${refs ? ` ${refs}` : ''}`)
    })
  })
  const appendList = (title: string, values: string[]) => {
    lines.push('', `## ${title}`, '', ...values.map((value) => `- ${value}`))
  }
  appendList('投资亮点', input.content.highlights)
  appendList('主要风险', input.content.risks)
  appendList('资料缺口与后续核验', input.content.missing)
  lines.push('', '## 引用资料', '')
  if (input.sources.length) {
    input.sources.forEach((source, index) => {
      lines.push(`- [S${index + 1}] ${source.sourceName}；${source.sourceType}；片段 ${source.chunkIndex ?? index}`)
    })
  } else {
    lines.push('- 当前项目知识库无可用引用资料。')
  }
  return `${lines.join('\n')}\n`
}
