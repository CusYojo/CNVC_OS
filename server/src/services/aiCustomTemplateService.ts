import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import JSZip from 'jszip'
import { db } from '../db/client.js'
import {
  aiCustomTemplates,
  auditLogs,
  chatConversations,
  projects,
  type AiCustomTemplateAnalysis,
} from '../db/schema.js'
import {
  AI_TEMPLATE_DRIVEN_SKILL_NAME,
  getAiSkillDirectory,
  loadAiSkill,
  type LoadedAiSkill,
} from './aiSkillService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'
import { convertUploadedInvestmentPdfTemplate } from './aiInvestmentTemplateConversionService.js'

const MAX_TEMPLATE_BYTES = 25 * 1024 * 1024
// 用户上传文件继续限制为 25MB；PDF 可编辑化会嵌入页面图片、OCR 文本和形状，
// 中间 PPTX 通常明显大于源 PDF，因此使用独立的内部产物上限。
const MAX_CONVERTED_TEMPLATE_BYTES = 100 * 1024 * 1024
const CUSTOM_TEMPLATE_DATA_ROOT = path.resolve(
  process.env.AI_CUSTOM_TEMPLATE_DATA_ROOT
    || process.env.AI_CUSTOM_TEMPLATE_ROOT
    || path.join(process.cwd(), 'server', 'ai-template-data'),
)
const LEGACY_CUSTOM_TEMPLATE_ROOT = path.resolve(
  path.join(process.cwd(), 'server', 'ai-template-skills'),
)

type TemplateUser = {
  uid: string
  name: string
  role: string
}

type ParagraphProfile = {
  text: string
  styleId: string
  styleName: string
  sizePt: number | null
  font: string
  level: number
}

export type ParsedAiCustomTemplate = {
  analysis: AiCustomTemplateAnalysis
  outputFormat: 'docx' | 'pptx'
}

export type AiCustomTemplateProgressUpdate = {
  stage: string
  progress: number
}

type AiCustomTemplateCreateOptions = {
  onProgress?: (
    update: AiCustomTemplateProgressUpdate,
  ) => void | Promise<void>
}

async function reportTemplateProgress(
  options: AiCustomTemplateCreateOptions,
  stage: string,
  progress: number,
) {
  try {
    await options.onProgress?.({ stage, progress })
  } catch (error) {
    console.warn('[template-analysis] 进度更新失败:', (error as Error).message)
  }
}

function typedError(message: string, status: number, code: string) {
  return Object.assign(new Error(message), { status, code })
}

function xmlDecode(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function attr(xml: string, name: string) {
  return xml.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1] ?? ''
}

function textNodes(xml: string, tag: 'w:t' | 'a:t') {
  const escaped = tag.replace(':', '\\:')
  return [...xml.matchAll(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi'))]
    .map((match) => xmlDecode(match[1]).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function safeFileName(value: string) {
  const base = String(value || '').split(/[/\\]/).pop() || ''
  const clean = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180)
  return clean || `template-${Date.now()}`
}

function countValues(values: Array<string | number>) {
  const counts = new Map<string, number>()
  values.forEach((value) => {
    const key = String(value).trim()
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  })
  return [...counts.entries()].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0]))
}

function mostFrequent(values: Array<string | number>, fallback = '') {
  return countValues(values)[0]?.[0] ?? fallback
}

function unique(values: string[], limit = 12) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function versionAnalysis(analysis: AiCustomTemplateAnalysis): AiCustomTemplateAnalysis {
  const { analysisVersion: _analysisVersion, ...withoutVersion } = analysis
  const normalized = {
    ...withoutVersion,
    schemaVersion: '1.0' as const,
  }
  const digest = createHash('sha256').update(canonicalJson(normalized)).digest('hex')
  return {
    ...normalized,
    analysisVersion: `sha256-${digest.slice(0, 12)}`,
  }
}

function isManagedTemplatePath(candidate: string) {
  const resolved = path.resolve(candidate)
  return [CUSTOM_TEMPLATE_DATA_ROOT, LEGACY_CUSTOM_TEMPLATE_ROOT]
    .some((root) => resolved.startsWith(`${root}${path.sep}`))
}

function summarize(value: string, limit = 260) {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return '该结构在模板中未提供示例正文，生成时应根据项目证据补充。'
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
}

function purposeFor(title: string) {
  if (/封面|标题/.test(title)) return '展示文档名称、项目主体、日期及必要的保密标识。'
  if (/目录|议程/.test(title)) return '展示全文结构及阅读顺序，不承载项目事实。'
  if (/摘要|概要|结论|建议/.test(title)) return '归纳核心判断、决策建议、前提条件及仍需核验事项。'
  if (/公司|项目|主体|概况|介绍/.test(title)) return '说明公司主体、发展阶段、业务定位和项目基本情况。'
  if (/团队|治理|股权/.test(title)) return '说明团队履历、组织治理、股权结构及稳定性。'
  if (/产品|技术|研发|知识产权/.test(title)) return '说明产品体系、核心技术、研发进展、壁垒和验证情况。'
  if (/行业|市场|竞争|产业链/.test(title)) return '分析市场空间、行业趋势、竞争格局及项目相对位置。'
  if (/业务|商业模式|客户|运营|经营/.test(title)) return '说明商业模式、客户验证、收入来源、交付及运营进展。'
  if (/财务|估值|融资|投资|交易|回报/.test(title)) return '说明财务表现、融资估值、交易安排、测算假设和投资回报。'
  if (/风险|合规|尽调|缺口|核验/.test(title)) return '列示风险、合规事项、证据缺口、影响及后续核验动作。'
  if (/引用|附件|附录/.test(title)) return '列示正文实际使用的来源、补充材料或责任声明。'
  return '按照模板示例的表达顺序，使用当前项目证据完成本结构的专业说明。'
}

function requirementsFor(title: string, sample: string) {
  const requirements = [
    '只使用当前项目字段、用户明确输入和已授权资料，不复制模板中的示例项目事实。',
    '每项事实或数字保留来源；以当前项目资料库为主要依据，未覆盖事项仅标记为待核验。',
    '可见标题、章节标题和正文必须针对当前项目重新生成，不复用模板原文。',
  ]
  if (/财务|估值|融资|投资|交易|回报/.test(title)) {
    requirements.push('财务和交易数据注明期间、单位、口径及历史实际/预测属性。')
  }
  if (/风险|合规|尽调|缺口|核验/.test(title)) {
    requirements.push('按照事项、证据、影响和后续动作组织内容，不输出无依据的确定性结论。')
  }
  if (/团队|客户|产品|技术/.test(title)) {
    requirements.push('区分企业自述、原始记录、第三方资料和 AI 分析。')
  }
  if (sample.includes('表') || sample.includes('：')) {
    requirements.push('模板以字段或表格组织信息时，保持相同的信息层级和字段顺序。')
  }
  return requirements
}

function headingLevel(text: string, styleId: string, styleName: string, sizePt: number | null, bodySize: number) {
  if (/title|标题|文档标题/i.test(`${styleId} ${styleName}`)) return 0
  const styleMatch = `${styleId} ${styleName}`.match(/heading\s*([1-6])|标题\s*([1-6一二三四五六])/i)
  if (styleMatch) {
    const raw = styleMatch[1] || styleMatch[2]
    const chinese = '一二三四五六'.indexOf(raw)
    return chinese >= 0 ? chinese + 1 : Math.max(1, Number(raw) || 1)
  }
  if (/^第[一二三四五六七八九十\d]+[章节部分篇]/.test(text)) return 1
  if (/^[一二三四五六七八九十]+[、.．]\s*/.test(text)) return 1
  if (/^(?:（[一二三四五六七八九十]+）|\([一二三四五六七八九十]+\))/.test(text)) return 2
  const decimal = text.match(/^(\d+(?:\.\d+){0,4})[、.．\s]/)
  if (decimal) return Math.min(4, decimal[1].split('.').length)
  if (sizePt && sizePt >= bodySize + 4 && text.length <= 80) return 1
  if (sizePt && sizePt >= bodySize + 2 && text.length <= 60) return 2
  return -1
}

function buildStructures(paragraphs: ParagraphProfile[]) {
  const bodySizes = paragraphs
    .filter((paragraph) => paragraph.text.length > 30 && paragraph.sizePt)
    .map((paragraph) => paragraph.sizePt as number)
  const bodySize = Number(mostFrequent(bodySizes, '12'))
  const profiled = paragraphs.map((paragraph) => ({
    ...paragraph,
    level: headingLevel(
      paragraph.text,
      paragraph.styleId,
      paragraph.styleName,
      paragraph.sizePt,
      bodySize,
    ),
  }))
  const headingIndexes = profiled
    .map((paragraph, index) => ({ paragraph, index }))
    .filter(({ paragraph, index }) =>
      paragraph.level >= 0
      && paragraph.text.length <= 100
      && !(index > 0 && /^(?:表|图)\s*\d+/i.test(paragraph.text)))
  const usableHeadings = headingIndexes.filter(({ paragraph, index }) =>
    index > 0 || paragraph.level > 0)
  if (!usableHeadings.length) {
    const content = profiled.map((paragraph) => paragraph.text).join(' ')
    return [{
      order: 1,
      title: '正文',
      level: 1,
      contentPurpose: purposeFor('正文'),
      contentSummary: summarize(content),
      contentRequirements: requirementsFor('正文', content),
    }]
  }
  return usableHeadings.slice(0, 80).map(({ paragraph, index }, headingIndex) => {
    const nextIndex = usableHeadings[headingIndex + 1]?.index ?? profiled.length
    const sample = profiled.slice(index + 1, nextIndex)
      .map((item) => item.text)
      .join(' ')
    return {
      order: headingIndex + 1,
      title: paragraph.text.replace(/\s+/g, ' ').trim(),
      level: Math.max(1, paragraph.level),
      contentPurpose: purposeFor(paragraph.text),
      contentSummary: summarize(sample),
      contentRequirements: requirementsFor(paragraph.text, sample),
    }
  })
}

async function analyzeDocx(zip: JSZip, fileName: string): Promise<ParsedAiCustomTemplate> {
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) throw typedError('DOCX 缺少 word/document.xml，文件可能已损坏', 400, 'INVALID_TEMPLATE')
  const stylesXml = await zip.file('word/styles.xml')?.async('string') ?? ''
  const styleMap = new Map<string, { name: string; font: string; sizePt: number | null; line: string }>()
  const styleFonts: string[] = []
  const styleSizes: number[] = []
  const lineSpacings: string[] = []
  for (const match of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const styleId = attr(match[1], 'w:styleId')
    const body = match[2]
    const name = xmlDecode(attr(body.match(/<w:name\b[^>]*\/>/)?.[0] ?? '', 'w:val'))
    const fontsTag = body.match(/<w:rFonts\b[^>]*\/>/)?.[0] ?? ''
    const font = attr(fontsTag, 'w:eastAsia') || attr(fontsTag, 'w:ascii') || attr(fontsTag, 'w:hAnsi')
    const sizeRaw = attr(body.match(/<w:sz\b[^>]*\/>/)?.[0] ?? '', 'w:val')
    const sizePt = sizeRaw ? Number(sizeRaw) / 2 : null
    const spacingTag = body.match(/<w:spacing\b[^>]*\/>/)?.[0] ?? ''
    const lineRaw = attr(spacingTag, 'w:line')
    const lineRule = attr(spacingTag, 'w:lineRule')
    const line = lineRaw
      ? lineRule === 'exact'
        ? `固定值 ${Math.round(Number(lineRaw) / 20 * 10) / 10} pt`
        : `${Math.round(Number(lineRaw) / 240 * 100) / 100} 倍`
      : ''
    if (font) styleFonts.push(font)
    if (sizePt) styleSizes.push(sizePt)
    if (line) lineSpacings.push(line)
    if (styleId) styleMap.set(styleId, { name, font, sizePt, line })
  }

  const paragraphs: ParagraphProfile[] = []
  const runFonts: string[] = []
  const runSizes: number[] = []
  const alignments: string[] = []
  const colors: string[] = []
  for (const match of documentXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const body = match[1]
    const paragraphText = textNodes(body, 'w:t').join('').replace(/\s+/g, ' ').trim()
    if (!paragraphText) continue
    const styleId = attr(body.match(/<w:pStyle\b[^>]*\/>/)?.[0] ?? '', 'w:val')
    const style = styleMap.get(styleId)
    const fontsTag = body.match(/<w:rFonts\b[^>]*\/>/)?.[0] ?? ''
    const font = attr(fontsTag, 'w:eastAsia')
      || attr(fontsTag, 'w:ascii')
      || attr(fontsTag, 'w:hAnsi')
      || style?.font
      || ''
    const sizeRaw = attr(body.match(/<w:sz\b[^>]*\/>/)?.[0] ?? '', 'w:val')
    const sizePt = sizeRaw ? Number(sizeRaw) / 2 : style?.sizePt ?? null
    const alignment = attr(body.match(/<w:jc\b[^>]*\/>/)?.[0] ?? '', 'w:val')
    const color = attr(body.match(/<w:color\b[^>]*\/>/)?.[0] ?? '', 'w:val')
    if (font) runFonts.push(font)
    if (sizePt) runSizes.push(sizePt)
    if (alignment) alignments.push(alignment)
    if (/^[0-9A-F]{6}$/i.test(color)) colors.push(color.toUpperCase())
    paragraphs.push({
      text: paragraphText,
      styleId,
      styleName: style?.name ?? '',
      sizePt,
      font,
      level: -1,
    })
  }
  if (!paragraphs.length) throw typedError('DOCX 未提取到可分析的正文', 400, 'EMPTY_TEMPLATE')

  const sizes = [...runSizes, ...styleSizes]
  const bodySize = Number(mostFrequent(
    paragraphs.filter((item) => item.text.length > 30 && item.sizePt).map((item) => item.sizePt as number),
    mostFrequent(sizes, '12'),
  ))
  const headingSizes = paragraphs
    .filter((item) => item.text.length <= 80 && item.sizePt && item.sizePt > bodySize)
    .map((item) => item.sizePt as number)
  const pageTag = documentXml.match(/<w:pgSz\b[^>]*\/>/)?.[0] ?? ''
  const marginTag = documentXml.match(/<w:pgMar\b[^>]*\/>/)?.[0] ?? ''
  const widthDxa = Number(attr(pageTag, 'w:w')) || 11906
  const heightDxa = Number(attr(pageTag, 'w:h')) || 16838
  const cm = (dxa: number) => Math.round(dxa / 567 * 10) / 10
  const margin = (name: string) => cm(Number(attr(marginTag, `w:${name}`)) || 0)
  const headers = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => /^word\/header\d+\.xml$/.test(name))
      .map(async (name) => textNodes(await zip.file(name)!.async('string'), 'w:t').join(' ')),
  )
  const footers = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => /^word\/footer\d+\.xml$/.test(name))
      .map(async (name) => textNodes(await zip.file(name)!.async('string'), 'w:t').join(' ')),
  )
  const paragraphAfterValues = [...stylesXml.matchAll(/<w:spacing\b[^>]*w:after="(\d+)"/g)]
    .map((match) => Number(match[1]) / 20)
    .filter((value) => value > 0)
  const fonts = unique([...runFonts, ...styleFonts], 10)
  const structures = buildStructures(paragraphs)
  return {
    outputFormat: 'docx',
    analysis: {
      format: 'docx',
      fileName,
      formatProfile: {
        fonts,
        primaryFont: mostFrequent(
          paragraphs.filter((item) => item.text.length > 30).map((item) => item.font),
          fonts[0] || '宋体',
        ),
        headingFont: mostFrequent(
          paragraphs.filter((item) => item.text.length <= 80 && item.sizePt && item.sizePt > bodySize).map((item) => item.font),
          fonts[0] || '黑体',
        ),
        titleSizePt: sizes.length ? Math.max(...sizes) : null,
        headingSizePt: headingSizes.length ? Number(mostFrequent(headingSizes)) : null,
        bodySizePt: Number.isFinite(bodySize) ? bodySize : null,
        lineSpacing: mostFrequent(lineSpacings, '模板未显式设置，按正文样式继承'),
        paragraphSpacing: paragraphAfterValues.length
          ? `段后 ${Math.round(Number(mostFrequent(paragraphAfterValues)) * 10) / 10} pt`
          : '模板未显式设置',
        alignment: unique(alignments.map((value) => ({
          center: '居中',
          both: '两端对齐',
          left: '左对齐',
          right: '右对齐',
        }[value] || value)), 6),
        pageSize: `${cm(widthDxa)} × ${cm(heightDxa)} cm`,
        margins: `上 ${margin('top')} cm、下 ${margin('bottom')} cm、左 ${margin('left')} cm、右 ${margin('right')} cm`,
        orientation: widthDxa > heightDxa ? '横向' : '纵向',
        colors: unique(colors, 8),
        header: summarize(headers.filter(Boolean).join('；'), 120),
        footer: summarize(footers.filter(Boolean).join('；'), 120),
        hasPageNumbers: /<w:instrText[^>]*>\s*(?:PAGE|NUMPAGES)\b/i.test(
          `${documentXml}${footers.join(' ')}`,
        ),
        tableCount: (documentXml.match(/<w:tbl\b/g) || []).length,
        imageCount: Object.keys(zip.files).filter((name) => /^word\/media\//.test(name)).length,
      },
      structures,
      summary: `已从可编辑 Word 模板中识别 ${structures.length} 个结构、${fonts.length} 种主要字体、${(documentXml.match(/<w:tbl\b/g) || []).length} 个表格和 ${Object.keys(zip.files).filter((name) => /^word\/media\//.test(name)).length} 个图片资源。`,
    },
  }
}

async function analyzePptx(zip: JSZip, fileName: string): Promise<ParsedAiCustomTemplate> {
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('string')
  if (!presentationXml) throw typedError('PPTX 缺少 ppt/presentation.xml，文件可能已损坏', 400, 'INVALID_TEMPLATE')
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) =>
      Number(left.match(/slide(\d+)/)?.[1]) - Number(right.match(/slide(\d+)/)?.[1]))
  if (!slideNames.length) throw typedError('PPTX 未包含可分析的幻灯片', 400, 'EMPTY_TEMPLATE')
  const themeXml = await zip.file('ppt/theme/theme1.xml')?.async('string') ?? ''
  const fonts = unique([
    ...[...themeXml.matchAll(/<(?:a:latin|a:ea|a:cs)\b[^>]*typeface="([^"]*)"/g)].map((match) => match[1]),
  ])
  const sizes: number[] = []
  const colors: string[] = []
  const alignments: string[] = []
  const structures: AiCustomTemplateAnalysis['structures'] = []
  let tableCount = 0
  for (const [index, slideName] of slideNames.entries()) {
    const slideXml = await zip.file(slideName)!.async('string')
    const texts = textNodes(slideXml, 'a:t')
    const title = texts[0] || `第 ${index + 1} 页`
    const body = texts.slice(1).join('；')
    for (const match of slideXml.matchAll(/\bsz="(\d+)"/g)) {
      const size = Number(match[1]) / 100
      if (size >= 5 && size <= 100) sizes.push(size)
    }
    colors.push(...[...slideXml.matchAll(/<a:srgbClr\b[^>]*val="([0-9A-F]{6})"/gi)]
      .map((match) => match[1].toUpperCase()))
    alignments.push(...[...slideXml.matchAll(/<a:pPr\b[^>]*algn="([^"]+)"/g)]
      .map((match) => match[1]))
    tableCount += (slideXml.match(/<a:tbl\b/g) || []).length
    structures.push({
      order: index + 1,
      title: summarize(title, 100),
      level: 1,
      contentPurpose: purposeFor(title),
      contentSummary: summarize(body),
      contentRequirements: requirementsFor(title, body),
    })
  }
  const sizeTag = presentationXml.match(/<p:sldSz\b[^>]*\/>/)?.[0] ?? ''
  const width = Number(attr(sizeTag, 'cx')) || 12192000
  const height = Number(attr(sizeTag, 'cy')) || 6858000
  const inches = (emu: number) => Math.round(emu / 914400 * 100) / 100
  const titleSize = sizes.length ? Math.max(...sizes) : null
  const bodyCandidates = sizes.filter((size) => size < (titleSize ?? 100) - 2)
  const primaryFont = fonts.find((font) => font && !font.startsWith('+')) || '微软雅黑'
  return {
    outputFormat: 'pptx',
    analysis: {
      format: 'pptx',
      fileName,
      formatProfile: {
        fonts,
        primaryFont,
        headingFont: primaryFont,
        titleSizePt: titleSize,
        headingSizePt: sizes.length ? Number(mostFrequent(sizes.filter((size) => size >= 18), String(titleSize ?? 24))) : null,
        bodySizePt: bodyCandidates.length ? Number(mostFrequent(bodyCandidates)) : null,
        lineSpacing: '按幻灯片文本框及母版段落设置继承',
        paragraphSpacing: '按幻灯片文本框及母版段落设置继承',
        alignment: unique(alignments.map((value) => ({
          ctr: '居中',
          just: '两端对齐',
          l: '左对齐',
          r: '右对齐',
        }[value] || value)), 6),
        pageSize: `${inches(width)} × ${inches(height)} in`,
        margins: 'PPTX 使用文本框坐标定位，无统一页边距',
        orientation: width > height ? '横向' : '纵向',
        colors: unique(colors, 10),
        header: '按幻灯片母版和版式继承',
        footer: '按幻灯片母版和版式继承',
        hasPageNumbers: structures.some((item) => /页码|page/i.test(item.contentSummary)),
        tableCount,
        imageCount: Object.keys(zip.files).filter((name) => /^ppt\/media\//.test(name)).length,
      },
      structures,
      summary: `已从可编辑 PowerPoint 模板中识别 ${structures.length} 页结构、${fonts.length} 种主题字体、${tableCount} 个表格和 ${Object.keys(zip.files).filter((name) => /^ppt\/media\//.test(name)).length} 个媒体资源。`,
    },
  }
}

export async function analyzeAiCustomTemplateBuffer(
  buffer: Buffer,
  fileName: string,
  options: {
    maxBytes?: number
    tooLargeMessage?: string
    tooLargeCode?: string
  } = {},
): Promise<ParsedAiCustomTemplate> {
  const maxBytes = options.maxBytes ?? MAX_TEMPLATE_BYTES
  if (buffer.length > maxBytes) {
    throw typedError(
      options.tooLargeMessage ?? '模板文件不能超过 25MB',
      413,
      options.tooLargeCode ?? 'TEMPLATE_TOO_LARGE',
    )
  }
  if (!buffer.subarray(0, 2).equals(Buffer.from('PK'))) {
    throw typedError('模板必须是有效的 DOCX 或 PPTX 文件', 400, 'INVALID_TEMPLATE')
  }
  const zip = await JSZip.loadAsync(buffer).catch(() => {
    throw typedError('模板压缩结构已损坏，无法分析', 400, 'INVALID_TEMPLATE')
  })
  const extension = path.extname(fileName).toLowerCase()
  const parsed = extension === '.docx' && zip.file('word/document.xml')
    ? await analyzeDocx(zip, fileName)
    : extension === '.pptx' && zip.file('ppt/presentation.xml')
      ? await analyzePptx(zip, fileName)
      : undefined
  if (parsed) {
    return {
      ...parsed,
      analysis: versionAnalysis(parsed.analysis),
    }
  }
  throw typedError('仅支持可编辑的 .docx 和 .pptx 模板，且文件扩展名必须与实际格式一致', 400, 'UNSUPPORTED_TEMPLATE')
}

async function assertProjectAndConversationAccess(
  user: TemplateUser,
  projectId: string,
  conversationId?: string,
) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw typedError('项目不存在', 404, 'NOT_FOUND')
  const collaborators = Array.isArray(project.collaborators) ? project.collaborators : []
  const allowed = user.role === '系统管理员'
    || !project.createdBy
    || project.createdBy === user.uid
    || project.owner === user.name
    || collaborators.includes(user.name)
  if (!allowed) throw typedError('无权访问该项目', 403, 'FORBIDDEN')
  if (conversationId) {
    const [conversation] = await db.select().from(chatConversations)
      .where(and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.userId, user.uid),
      ))
      .limit(1)
    if (!conversation) throw typedError('会话不存在或不属于当前用户', 404, 'CONVERSATION_NOT_FOUND')
    if (conversation.projectId !== projectId) {
      throw typedError('会话所属项目与模板项目不一致', 409, 'CONVERSATION_PROJECT_MISMATCH')
    }
  }
  return project
}

function publicTemplate(row: typeof aiCustomTemplates.$inferSelect) {
  const {
    storagePath: _storagePath,
    skillName: _skillName,
    skillPath: _skillPath,
    skillVersion: _skillVersion,
    ...safe
  } = row
  const analysis = versionAnalysis(row.analysis as AiCustomTemplateAnalysis)
  return {
    ...safe,
    analysis,
    analysisVersion: analysis.analysisVersion,
  }
}

export async function createAiCustomTemplate(user: TemplateUser, input: {
  projectId: string
  conversationId?: string
  name: string
  dataBase64: string
  purpose?: 'custom_template_document' | 'investment_recommendation_ppt'
}, options: AiCustomTemplateCreateOptions = {}) {
  const project = await assertProjectAndConversationAccess(
    user,
    input.projectId,
    input.conversationId,
  )
  await reportTemplateProgress(options, '项目权限校验完成，正在读取模板', 8)
  const fileName = safeFileName(input.name)
  const base64 = input.dataBase64.includes(',')
    ? input.dataBase64.slice(input.dataBase64.indexOf(',') + 1)
    : input.dataBase64
  if (base64.length > Math.ceil(MAX_TEMPLATE_BYTES / 3) * 4 + 16) {
    throw typedError('模板文件不能超过 25MB', 413, 'TEMPLATE_TOO_LARGE')
  }
  const buffer = Buffer.from(base64, 'base64')
  if (!buffer.length) throw typedError('模板内容为空或 Base64 非法', 400, 'INVALID_TEMPLATE')
  await reportTemplateProgress(options, '模板上传完成，正在检查文件格式', 12)
  const purpose = input.purpose ?? 'custom_template_document'
  const extension = path.extname(fileName).toLowerCase()
  if (
    purpose === 'investment_recommendation_ppt'
    && extension !== '.pdf'
    && extension !== '.pptx'
  ) {
    throw typedError(
      '投资建议书模板仅支持 PDF 或 PPTX',
      400,
      'UNSUPPORTED_INVESTMENT_TEMPLATE',
    )
  }
  const templateId = randomUUID()
  const templateRoot = path.join(
    CUSTOM_TEMPLATE_DATA_ROOT,
    user.uid,
    input.projectId,
    input.conversationId || 'project',
    templateId,
  )
  await mkdir(templateRoot, { recursive: true })
  await reportTemplateProgress(options, '已创建安全工作区，正在准备解析', 15)
  try {
    let assetBuffer = buffer
    let assetFileName = fileName
    let parsed: ParsedAiCustomTemplate
    if (extension === '.pdf') {
      if (purpose !== 'investment_recommendation_ppt') {
        throw typedError(
          'PDF 模板仅用于投资建议书 PPT；通用上传模板仍只支持 DOCX 或 PPTX',
          400,
          'UNSUPPORTED_TEMPLATE',
        )
      }
      const sourcePdfPath = path.join(templateRoot, fileName)
      assetFileName = `${path.basename(fileName, extension)}-editable.pptx`
      const outputPptxPath = path.join(templateRoot, assetFileName)
      const conversionWorkDir = path.join(templateRoot, 'conversion')
      await writeFile(sourcePdfPath, buffer)
      await reportTemplateProgress(options, 'PDF 已保存，正在分析页面与图片对象', 18)
      const conversion = await convertUploadedInvestmentPdfTemplate({
        sourcePdfPath,
        outputPptxPath,
        workDir: conversionWorkDir,
        onProgress: options.onProgress,
      })
      assetBuffer = conversion.outputBuffer
      await reportTemplateProgress(options, '转换交接检查通过，正在识别 PPTX 结构', 95)
      const converted = await analyzeAiCustomTemplateBuffer(
        assetBuffer,
        assetFileName,
        {
          maxBytes: MAX_CONVERTED_TEMPLATE_BYTES,
          tooLargeMessage: 'PDF 转换后的可编辑 PPTX 不能超过 100MB，请压缩模板图片后重试',
          tooLargeCode: 'CONVERTED_TEMPLATE_TOO_LARGE',
        },
      )
      parsed = {
        ...converted,
        analysis: versionAnalysis({
          ...converted.analysis,
          fileName,
          summary: `源 PDF 已通过 pdf-to-editable-ppt 转为可编辑 PPTX。${converted.analysis.summary}`,
        }),
      }
    } else {
      await reportTemplateProgress(
        options,
        extension === '.pptx'
          ? '正在识别幻灯片结构、字体和内容槽位'
          : '正在识别文档结构、字体和段落样式',
        35,
      )
      parsed = await analyzeAiCustomTemplateBuffer(buffer, fileName)
      await reportTemplateProgress(options, '模板结构识别完成，正在整理分析结果', 88)
    }

    if (purpose === 'investment_recommendation_ppt' && parsed.outputFormat !== 'pptx') {
      throw typedError(
        '投资建议书模板必须能解析为 PPTX',
        400,
        'INVESTMENT_TEMPLATE_FORMAT_MISMATCH',
      )
    }
    const assetPath = path.join(templateRoot, assetFileName)
    const analysisPath = path.join(templateRoot, 'template-analysis.json')
    await reportTemplateProgress(options, '正在保存模板与结构分析结果', 97)
    await Promise.all([
      extension === '.pdf' ? Promise.resolve() : writeFile(assetPath, assetBuffer),
      writeFile(
        analysisPath,
        `${JSON.stringify(parsed.analysis, null, 2)}\n`,
        'utf8',
      ),
    ])
    const skillName = purpose === 'investment_recommendation_ppt'
      ? 'create-reference-driven-editable-ppt'
      : AI_TEMPLATE_DRIVEN_SKILL_NAME
    const skill = await loadAiSkill(skillName)
    await reportTemplateProgress(options, '正在登记模板并完成审计记录', 99)
    const sha256 = createHash('sha256').update(assetBuffer).digest('hex')
    const mimeType = parsed.outputFormat === 'pptx'
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const [row] = await db.insert(aiCustomTemplates).values({
      id: templateId,
      userId: user.uid,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originalFileName: fileName,
      format: parsed.outputFormat,
      mimeType,
      fileSize: assetBuffer.length,
      sha256,
      storagePath: assetPath,
      analysis: parsed.analysis,
      skillName,
      skillPath: getAiSkillDirectory(skillName),
      skillVersion: skill.version,
      status: 'succeeded',
    }).returning()
    await db.insert(auditLogs).values({
      userId: user.uid,
      userName: user.name,
      module: 'AI 智能助手',
      action: purpose === 'investment_recommendation_ppt'
        ? '上传并分析投资建议书模板'
        : '上传并分析文档模板',
      target: `${project.name}：${fileName}`,
    })
    return publicTemplate(row)
  } catch (error) {
    await rm(templateRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function listAiCustomTemplates(
  userId: string,
  options: { projectId?: string; conversationId?: string } = {},
) {
  const conditions = [eq(aiCustomTemplates.userId, userId)]
  if (options.projectId) conditions.push(eq(aiCustomTemplates.projectId, options.projectId))
  if (options.conversationId) conditions.push(eq(aiCustomTemplates.conversationId, options.conversationId))
  const rows = await db.select().from(aiCustomTemplates)
    .where(and(...conditions))
    .orderBy(desc(aiCustomTemplates.createdAt))
    .limit(50)
  return rows.map(publicTemplate)
}

export async function getAiCustomTemplate(
  userId: string,
  templateId: string,
) {
  const [row] = await db.select().from(aiCustomTemplates)
    .where(and(eq(aiCustomTemplates.id, templateId), eq(aiCustomTemplates.userId, userId)))
    .limit(1)
  return row ? publicTemplate(row) : undefined
}

/**
 * 会话中的“生成 PPT”指令只能复用当前会话或当前项目级模板，绝不跨用
 * 其他会话上传的模板。返回最近一次分析成功且绑定三技能编排器的 PPTX。
 */
export async function findLatestInvestmentPptTemplate(input: {
  userId: string
  projectId: string
  conversationId: string
}) {
  const [row] = await db.select().from(aiCustomTemplates)
    .where(and(
      eq(aiCustomTemplates.userId, input.userId),
      eq(aiCustomTemplates.projectId, input.projectId),
      eq(aiCustomTemplates.skillName, 'create-reference-driven-editable-ppt'),
      eq(aiCustomTemplates.format, 'pptx'),
      eq(aiCustomTemplates.status, 'succeeded'),
      or(
        eq(aiCustomTemplates.conversationId, input.conversationId),
        isNull(aiCustomTemplates.conversationId),
      ),
    ))
    .orderBy(desc(aiCustomTemplates.createdAt))
    .limit(1)
  return row ? publicTemplate(row) : undefined
}

export async function resolveAiCustomTemplateForTask(input: {
  userId: string
  projectId: string
  conversationId?: string
  templateId: string
  taskType?: 'custom_template_document' | 'investment_recommendation_ppt'
}): Promise<{
  row: typeof aiCustomTemplates.$inferSelect
  template: AiTemplateDefinition
  skill: LoadedAiSkill
}> {
  const [row] = await db.select().from(aiCustomTemplates)
    .where(and(
      eq(aiCustomTemplates.id, input.templateId),
      eq(aiCustomTemplates.userId, input.userId),
      eq(aiCustomTemplates.projectId, input.projectId),
    ))
    .limit(1)
  if (!row) throw typedError('上传模板不存在或不属于当前项目', 404, 'CUSTOM_TEMPLATE_NOT_FOUND')
  if (row.conversationId && row.conversationId !== input.conversationId) {
    throw typedError('上传模板属于其他会话', 409, 'CUSTOM_TEMPLATE_CONVERSATION_MISMATCH')
  }
  const resolvedAsset = path.resolve(row.storagePath)
  if (!isManagedTemplatePath(resolvedAsset)) {
    throw typedError('上传模板存储路径无效', 500, 'CUSTOM_TEMPLATE_PATH_INVALID')
  }
  const taskType = input.taskType ?? 'custom_template_document'
  const skillName = taskType === 'investment_recommendation_ppt'
    ? 'create-reference-driven-editable-ppt'
    : AI_TEMPLATE_DRIVEN_SKILL_NAME
  const [assetStat, skill] = await Promise.all([
    stat(resolvedAsset).catch(() => null),
    loadAiSkill(skillName),
  ])
  if (!assetStat?.isFile() || !existsSync(resolvedAsset)) {
    throw typedError('上传模板文件已丢失', 503, 'CUSTOM_TEMPLATE_FILE_MISSING')
  }
  const analysis = versionAnalysis(row.analysis as AiCustomTemplateAnalysis)
  if (taskType === 'investment_recommendation_ppt' && row.format !== 'pptx') {
    throw typedError(
      '投资建议书任务只能使用 PDF 转换产物或原生 PPTX 模板',
      409,
      'INVESTMENT_TEMPLATE_FORMAT_MISMATCH',
    )
  }
  const sectionTitles = [...new Set(analysis.structures
    .filter((item, index) =>
      !(analysis.format === 'pptx' && index === 0)
      && !/(?:封面|目录|议程|文档标题|引用资料|责任声明)/i.test(item.title.trim()))
    .map((item) => item.title.trim())
    .filter(Boolean))]
    .slice(0, 40)
  const outputFormat = row.format === 'pptx' ? 'pptx' : 'docx'
  const sourceWasPdf = path.extname(row.originalFileName).toLowerCase() === '.pdf'
  const conversionHandoffPath = sourceWasPdf
    ? path.join(path.dirname(resolvedAsset), 'conversion', 'conversion-handoff.json')
    : undefined
  if (
    conversionHandoffPath
    && (!isManagedTemplatePath(conversionHandoffPath) || !existsSync(conversionHandoffPath))
  ) {
    throw typedError(
      'PDF 模板转换交接证书已丢失',
      503,
      'PDF_TEMPLATE_HANDOFF_MISSING',
    )
  }
  const isInvestmentPpt = taskType === 'investment_recommendation_ppt'
  return {
    row: {
      ...row,
      analysis,
      skillName,
      skillPath: getAiSkillDirectory(skillName),
      skillVersion: skill.version,
    },
    skill,
    template: {
      type: taskType,
      skillName,
      label: path.basename(row.originalFileName, path.extname(row.originalFileName)).slice(0, 80),
      description: isInvestmentPpt
        ? '严格依据用户上传模板的版式、结构和页面职责生成投资建议书'
        : '复用用户上传模板的版式与结构，为当前项目生成内部投资分析材料',
      outputFormat,
      templateVersion: `${skill.version}+${analysis.analysisVersion}`,
      referencePath: resolvedAsset,
      editableLevel: outputFormat === 'pptx' ? 'core-elements' : 'text-and-structure',
      sections: sectionTitles.length ? sectionTitles : ['正文'],
      requiredParameters: isInvestmentPpt
        ? ['projectId', 'sourceCutoffDate', 'customTemplateId', 'language', 'structureMode']
        : ['projectId', 'sourceCutoffDate', 'customTemplateId'],
      disclaimer: isInvestmentPpt
        ? '本演示文稿仅供内部审议，不构成最终投资决策。'
        : '本报告以当前项目资料库为主要依据，并按关键缺口采用可核验的定向公开补全；结论以文内所列来源和资料截止日为边界。',
      ...(isInvestmentPpt
        ? {
            workflowSkillNames: [
              'create-reference-driven-editable-ppt',
              'GordenSuperPPTSkill',
              'pdf-to-editable-ppt',
            ] as const,
            templateSourceMode: sourceWasPdf ? 'pdf-converted' as const : 'native-pptx' as const,
            ...(conversionHandoffPath ? { conversionHandoffPath } : {}),
          }
        : {}),
      customAnalysis: analysis,
    },
  }
}

export function getAiCustomTemplateRoot() {
  return CUSTOM_TEMPLATE_DATA_ROOT
}
