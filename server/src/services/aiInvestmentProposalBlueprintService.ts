import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { PDFParse } from 'pdf-parse'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'

export const INVESTMENT_PROPOSAL_BLUEPRINT_VERSION = 'proposal-blueprint-20260727-v7-limited-draft'
export const CURRENT_PROJECT_NO_DATA = '当前项目暂无相关资料。'
const CORE_STANDARD_SHA256 = 'b1c0145946c78ec3d5d8d3c7ebe4b027601464a8d7e27bd60bb0a677ef1e1563'

export type InvestmentProposalAnalysisKind =
  | 'company_profile'
  | 'team'
  | 'equity'
  | 'product_technology'
  | 'operations'
  | 'financials'
  | 'financing_history'
  | 'transaction_plan'
  | 'protective_terms'
  | 'forecast_return'
  | 'comparable_valuation'
  | 'investment_highlights'
  | 'risk_summary'
  | 'conclusion'

export type InvestmentProposalTableKind =
  | 'equity_structure'
  | 'financial_summary'
  | 'financing_history'
  | 'transaction_plan'
  | 'forecast_return'
  | 'comparable_valuation'

export type InvestmentProposalBlueprintSection = {
  id: string
  title: string
  level: 1 | 2 | 3
  parentId?: string
  required: true
  container?: boolean
  analysisKind?: InvestmentProposalAnalysisKind
  evidenceKeywords: string[]
  tableKind?: InvestmentProposalTableKind
}

export type ParsedInvestmentProposalTemplate = {
  fileName: string
  absolutePath: string
  extension: '.docx' | '.pdf'
  sha256: string
  bytes: number
  pageCount?: number
  headings: string[]
  textSample: string
  docx?: {
    sectionCount: number
    pageWidthDxa?: number
    pageHeightDxa?: number
    marginsDxa?: {
      top?: number
      right?: number
      bottom?: number
      left?: number
      header?: number
      footer?: number
    }
    paragraphStyles: Array<{ styleId: string; styleName: string; text: string }>
    headerText: string
    footerText: string
    tableCount: number
    hasPageField: boolean
  }
}

export type InvestmentProposalDocumentBlueprint = {
  version: string
  templateVersion: string
  corpusSha256: string
  coreStandardPath: string
  coreStandardSha256: string
  templates: ParsedInvestmentProposalTemplate[]
  page: {
    widthDxa: 11906
    heightDxa: 16838
    marginTopDxa: 1440
    marginRightDxa: 1800
    marginBottomDxa: 1440
    marginLeftDxa: 1800
    headerDxa: 720
    footerDxa: 720
  }
  typography: {
    titlePt: 16
    heading1Pt: 14
    heading2Pt: 14
    heading3Pt: 12
    bodyPt: 12
    tablePt: 10.5
    notePt: 10.5
    titleFontRole: 'sans'
    heading1FontRole: 'sans'
    heading2FontRole: 'kaiti'
    heading3FontRole: 'fangsong'
    bodyFontRole: 'fangsong'
  }
  fixedBlocks: {
    salutation: '各位投资决策委员会成员：'
    authorization: string
    managementCompany: '浙江赛智伯乐股权投资管理有限公司'
    headerCompany: '浙江赛智伯乐投资管理有限公司'
    noDataText: typeof CURRENT_PROJECT_NO_DATA
  }
  sections: InvestmentProposalBlueprintSection[]
  requiredAnalysisKinds: InvestmentProposalAnalysisKind[]
  expectedTemplateFingerprints: Record<string, string>
}

const EXPECTED_TEMPLATE_FINGERPRINTS: Record<string, string> = {
  '佳量脑科学项目投资提案0622(1).docx': '0686dc7cd3bc3f098f6d046239c84ae885e1df03bf8719057e8688a14ec90385',
  '1.众创叁期对飞阔科技的投资提案(1).docx': '2693a3836cfc25ea3ef848c35678a5b4b583b02b3b7b9ece1182cf52654d93c8',
  '1. 轻蜓光电投资提案(1).pdf': '8b809e914febf9dc37e1f949c396923157856f5afb618540c02d73cd19448fab',
  '1. 普雷赛斯投资提案(1).pdf': 'c8faeb9085e8548ff6e30a3ed113d35efe20586566f43edcb7b950b953362032',
  '微纳核芯投资提案 -东阳基金(2).pdf': 'dfc08421503e549718f9a8c056716d121f12aa7687a411a4d8fe23a6a5a2a174',
  '微纳核芯投资提案 -众创基金(3).pdf': '18c114ab79279db7f9efc45a623ca9c502664ba97b52987f54502fdc0a7478dc',
  '关于宁波赛智具身股权投资合伙企业（有限合伙）对北京中数睿智科技有限公司实施股权投资的提案(1).pdf':
    'f0e01d2016ebebe925d61405c2fbb272993af023964045bd5ed1ad7e9a3373f7',
  '德塔智能投资提案.pdf': '1ca7df95a1ba50e633fac56d041ec29d28c93aff49ad13d1131d81d17839f2ad',
  '蓝成应急投资提案(1).pdf': '3905bc12a9d1794d7ee77882f77a7150d5c365d7c4bb657da98c76df3cd49fa5',
}

const section = (
  id: string,
  title: string,
  level: 1 | 2 | 3,
  evidenceKeywords: string[],
  options: Partial<Omit<InvestmentProposalBlueprintSection, 'id' | 'title' | 'level' | 'required' | 'evidenceKeywords'>> = {},
): InvestmentProposalBlueprintSection => ({
  id,
  title,
  level,
  required: true,
  evidenceKeywords,
  ...options,
})

// 核心规范归纳出的稳定六章、17 节结构。模板差异不得扩展这棵树。
const BLUEPRINT_SECTIONS: InvestmentProposalBlueprintSection[] = [
  section('company', '一、基本情况简介', 1, ['基本情况', '公司', '项目'], { container: true }),
  section('company.profile', '（一）公司简介', 2, ['公司', '成立', '主体', '注册', '定位', '主营'], {
    parentId: 'company',
    analysisKind: 'company_profile',
  }),
  section('company.team', '（二）核心团队', 2, ['团队', '创始人', '高管', '履历', '任职', '背调'], {
    parentId: 'company',
    analysisKind: 'team',
  }),
  section('company.equity', '（三）公司股权结构', 2, ['股权', '股东', '持股', '实控人', '工商', '章程'], {
    parentId: 'company',
    analysisKind: 'equity',
    tableKind: 'equity_structure',
  }),
  section('company.product', '（四）产品及技术', 2, ['产品', '技术', '研发', '专利', '知识产权', '临床', '测试'], {
    parentId: 'company',
    analysisKind: 'product_technology',
  }),
  section('company.operations', '（五）运营摘要', 2, ['运营', '客户', '合同', '订单', '交付', '回款', '产能', '渠道'], {
    parentId: 'company',
    analysisKind: 'operations',
  }),
  section('company.financials', '（六）财务摘要', 2, ['财务', '审计', '收入', '成本', '毛利', '净利润', '现金流', '资产负债'], {
    parentId: 'company',
    analysisKind: 'financials',
    tableKind: 'financial_summary',
  }),
  section('transaction', '二、交易条件', 1, ['交易', '投资', '融资', '估值', '条款'], { container: true }),
  section('transaction.history', '（一）历史融资情况', 2, ['历史融资', '轮次', '投资方', '融资金额', '投后估值'], {
    parentId: 'transaction',
    analysisKind: 'financing_history',
    tableKind: 'financing_history',
  }),
  section('transaction.plan', '（二）本轮公司估值和投资方案', 2, ['本轮', '估值', '投资金额', '增资', '老股', '股比', '交易方案'], {
    parentId: 'transaction',
    analysisKind: 'transaction_plan',
    tableKind: 'transaction_plan',
  }),
  section('transaction.protection', '（三）风险控制及保护性条款', 2, ['保护性条款', '交割', '董事会', '否决权', '反稀释', '回购', '清算'], {
    parentId: 'transaction',
    analysisKind: 'protective_terms',
  }),
  section('business-plan', '三、公司业务计划', 1, ['业务计划', '经营计划', '预测', '市场', '上市', '退出'], { container: true }),
  section('business-plan.forecast', '（一）经营预测与回报测算', 2, ['预测', '预算', '收入', '利润', '估值', '退出', '回报', 'IRR', 'MOIC'], {
    parentId: 'business-plan',
    analysisKind: 'forecast_return',
    tableKind: 'forecast_return',
  }),
  section('business-plan.comparables', '（二）可比公司估值比较', 2, ['可比公司', '估值', '市值', 'PE', 'PS', 'EV', '倍数'], {
    parentId: 'business-plan',
    analysisKind: 'comparable_valuation',
    tableKind: 'comparable_valuation',
  }),
  section('highlights', '四、项目亮点总结', 1, ['投资亮点', '投资价值', '优势', '验证', '成长', '投资逻辑'], {
    analysisKind: 'investment_highlights',
  }),
  section('risks', '五、风险提示与对策', 1, ['风险', '不确定性', '合规', '财务', '市场', '技术', '触发条件', '缓释', '责任人', '时点'], {
    analysisKind: 'risk_summary',
  }),
  section('conclusion', '六、结论', 1, ['结论', '建议', '条件', '下一步', '否决'], {
    analysisKind: 'conclusion',
  }),
]

export const INVESTMENT_PROPOSAL_SECTION_TITLES = BLUEPRINT_SECTIONS.map((item) => item.title)

const REQUIRED_ANALYSIS_KINDS: InvestmentProposalAnalysisKind[] = [
  'investment_highlights',
  'risk_summary',
  'conclusion',
]

const xmlEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeXmlText(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => xmlEntities[name] ?? '')
}

function attr(xml: string, name: string) {
  return xml.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1]
}

function numericAttr(xml: string, name: string) {
  const value = attr(xml, name)
  return value === undefined ? undefined : Number.parseInt(value, 10)
}

function textFromXml(xml: string) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1]))
    .join('')
    .trim()
}

function normalizedHeading(value: string) {
  return value
    .replace(/\s+/g, '')
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, '')
    .replace(/^[（(][一二三四五六七八九十]+[）)]\s*/, '')
    .replace(/^[0-9]+(?:\.[0-9]+)*[、.．]?\s*/, '')
    .trim()
}

function isHeadingCandidate(value: string) {
  const text = value.trim()
  if (!text || text.length > 45) return false
  return /^(?:[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[）)]|[0-9]+(?:\.[0-9]+)*[、.．])/.test(text)
    || /(基本情况|公司简介|核心团队|股权结构|产品及技术|运营摘要|财务摘要|交易条件|交易方案|投资方案|保护性条款|业务计划|业绩预测|回报测算|市场空间|可比公司|估值比较|项目亮点|风险提示|结论)$/.test(text)
}

async function parseDocxTemplate(absolutePath: string, buffer: Buffer, sha256: string) {
  const zip = await JSZip.loadAsync(buffer)
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) throw new Error(`投资提案 DOCX 缺少 document.xml：${path.basename(absolutePath)}`)
  const stylesXml = await zip.file('word/styles.xml')?.async('string') ?? ''
  const styleNames = new Map<string, string>()
  for (const match of stylesXml.matchAll(/<w:style\b[\s\S]*?<\/w:style>/g)) {
    const styleId = attr(match[0], 'w:styleId')
    const styleName = match[0].match(/<w:name\b[^>]*w:val="([^"]+)"/)?.[1]
    if (styleId) styleNames.set(styleId, decodeXmlText(styleName ?? styleId))
  }
  const paragraphStyles: Array<{ styleId: string; styleName: string; text: string }> = []
  const headings: string[] = []
  for (const match of documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const paragraphXml = match[0]
    const text = textFromXml(paragraphXml)
    if (!text) continue
    const styleId = paragraphXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1] ?? ''
    const styleName = styleNames.get(styleId) ?? styleId
    paragraphStyles.push({ styleId, styleName, text })
    if (
      isHeadingCandidate(text)
      || /(?:一标|二标|三标|标题|heading)/i.test(styleName)
    ) {
      headings.push(text)
    }
  }
  const sectionCount = (documentXml.match(/<w:sectPr\b/g) || []).length
  const finalSection = [...documentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].at(-1)?.[0] ?? ''
  const pageSize = finalSection.match(/<w:pgSz\b[^>]*\/>/)?.[0] ?? ''
  const margins = finalSection.match(/<w:pgMar\b[^>]*\/>/)?.[0] ?? ''
  const headerNames = Object.keys(zip.files).filter((name) => /^word\/header\d+\.xml$/.test(name))
  const footerNames = Object.keys(zip.files).filter((name) => /^word\/footer\d+\.xml$/.test(name))
  const headerText = (await Promise.all(headerNames.map(async (name) =>
    textFromXml(await zip.file(name)!.async('string'))))).filter(Boolean).join('；')
  const footerXml = (await Promise.all(footerNames.map(async (name) =>
    zip.file(name)!.async('string')))).join('\n')
  return {
    fileName: path.basename(absolutePath),
    absolutePath,
    extension: '.docx' as const,
    sha256,
    bytes: buffer.length,
    headings: [...new Set(headings)],
    textSample: paragraphStyles.slice(0, 20).map((item) => item.text).join('\n').slice(0, 4000),
    docx: {
      sectionCount,
      pageWidthDxa: numericAttr(pageSize, 'w:w'),
      pageHeightDxa: numericAttr(pageSize, 'w:h'),
      marginsDxa: {
        top: numericAttr(margins, 'w:top'),
        right: numericAttr(margins, 'w:right'),
        bottom: numericAttr(margins, 'w:bottom'),
        left: numericAttr(margins, 'w:left'),
        header: numericAttr(margins, 'w:header'),
        footer: numericAttr(margins, 'w:footer'),
      },
      paragraphStyles,
      headerText,
      footerText: textFromXml(footerXml),
      tableCount: (documentXml.match(/<w:tbl\b/g) || []).length,
      hasPageField: /PAGE/.test(footerXml),
    },
  } satisfies ParsedInvestmentProposalTemplate
}

async function parsePdfTemplate(absolutePath: string, buffer: Buffer, sha256: string) {
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    const lines = result.text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    return {
      fileName: path.basename(absolutePath),
      absolutePath,
      extension: '.pdf' as const,
      sha256,
      bytes: buffer.length,
      pageCount: result.total,
      headings: [...new Set(lines.filter(isHeadingCandidate))],
      textSample: lines.slice(0, 80).join('\n').slice(0, 4000),
    } satisfies ParsedInvestmentProposalTemplate
  } finally {
    await parser.destroy()
  }
}

export async function parseInvestmentProposalTemplate(absolutePath: string) {
  const extension = path.extname(absolutePath).toLowerCase()
  if (extension !== '.docx' && extension !== '.pdf') {
    throw new Error(`不支持的投资提案模板格式：${path.basename(absolutePath)}`)
  }
  const [buffer, fileStat] = await Promise.all([readFile(absolutePath), stat(absolutePath)])
  if (!fileStat.isFile() || buffer.length < 1000) {
    throw new Error(`投资提案模板为空或不完整：${path.basename(absolutePath)}`)
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  return extension === '.docx'
    ? parseDocxTemplate(absolutePath, buffer, sha256)
    : parsePdfTemplate(absolutePath, buffer, sha256)
}

function validateParsedTemplates(templates: ParsedInvestmentProposalTemplate[]) {
  const issues: string[] = []
  if (templates.length !== Object.keys(EXPECTED_TEMPLATE_FINGERPRINTS).length) {
    issues.push(`模板数量应为 ${Object.keys(EXPECTED_TEMPLATE_FINGERPRINTS).length}，实际为 ${templates.length}`)
  }
  const byName = new Map(templates.map((template) => [template.fileName, template]))
  Object.entries(EXPECTED_TEMPLATE_FINGERPRINTS).forEach(([fileName, expected]) => {
    const parsed = byName.get(fileName)
    if (!parsed) issues.push(`缺少模板：${fileName}`)
    else if (parsed.sha256 !== expected) issues.push(`模板摘要发生变化：${fileName}`)
  })
  const docxTemplates = templates.filter((template) => template.extension === '.docx')
  if (docxTemplates.length !== 2) issues.push(`可编辑 DOCX 模板应为 2 份，实际为 ${docxTemplates.length}`)
  docxTemplates.forEach((template) => {
    if (template.docx?.pageWidthDxa !== 11906 || template.docx?.pageHeightDxa !== 16838) {
      issues.push(`${template.fileName} 不是预期 A4 页面几何`)
    }
    if (!template.docx?.headerText) issues.push(`${template.fileName} 缺少模板页眉`)
    if (!template.docx?.hasPageField) issues.push(`${template.fileName} 缺少页码字段`)
  })
  const corpusHeadings = templates.flatMap((template) => template.headings).map(normalizedHeading)
  ;[
    '基本情况简介',
    '交易条件',
    '公司业务计划',
    '项目亮点总结',
    '风险提示与对策',
    '结论',
  ].forEach((required) => {
    if (!corpusHeadings.some((heading) => heading.includes(required) || required.includes(heading))) {
      issues.push(`模板语料未解析出稳定章节：${required}`)
    }
  })
  if (!templates.some((template) => template.textSample.includes('各位投资决策委员会成员：'))) {
    issues.push('模板语料未解析出固定投委会称谓')
  }
  if (issues.length) {
    throw Object.assign(new Error(`投资提案模板解析失败：${issues.join('；')}`), {
      code: 'INVESTMENT_PROPOSAL_TEMPLATE_INVALID',
      issues,
    })
  }
}

let cachedBlueprint: {
  cacheKey: string
  blueprint: InvestmentProposalDocumentBlueprint
} | undefined

export async function loadInvestmentProposalBlueprint(
  template: Pick<AiTemplateDefinition, 'templateVersion' | 'referencePath' | 'referencePaths' | 'disclaimer'>,
) {
  const referencePaths = [...new Set([template.referencePath, ...(template.referencePaths ?? [])])]
  const coreStandardPath = path.resolve(
    path.dirname(template.referencePath),
    '..',
    '投资提案模板分析',
    '投资提案模板核心规范.md',
  )
  const stats = await Promise.all([...referencePaths, coreStandardPath].map(async (referencePath) => {
    const fileStat = await stat(referencePath)
    return `${referencePath}:${fileStat.size}:${fileStat.mtimeMs}`
  }))
  const cacheKey = createHash('sha256')
    .update(template.templateVersion)
    .update('\n')
    .update(stats.join('\n'))
    .digest('hex')
  if (cachedBlueprint?.cacheKey === cacheKey) return cachedBlueprint.blueprint

  const [templates, coreStandard] = await Promise.all([
    Promise.all(referencePaths.map(parseInvestmentProposalTemplate)),
    readFile(coreStandardPath, 'utf8'),
  ])
  validateParsedTemplates(templates)
  const coreStandardSha256 = createHash('sha256').update(coreStandard).digest('hex')
  const coreRequiredRules = [
    '用户本次明确输入',
    '文档主标题 | 黑体 | 16pt',
    '正文行距 | 固定值 24pt',
    '不设置独立封面',
    '一、基本情况简介',
    '六、结论',
    '用户补充内容单独标注为“用户补充输入”',
    '联网公开信息只作为补充线索',
    '正文末尾不增加“免责声明”或“引用资料”板块',
  ]
  const missingCoreRules = coreRequiredRules.filter((rule) => !coreStandard.includes(rule))
  if (coreStandardSha256 !== CORE_STANDARD_SHA256 || missingCoreRules.length) {
    throw Object.assign(new Error('投资提案核心规范发生变化，需先同步 Blueprint 与 Formatter'), {
      code: 'INVESTMENT_PROPOSAL_CORE_STANDARD_INVALID',
      expectedSha256: CORE_STANDARD_SHA256,
      actualSha256: coreStandardSha256,
      missingRules: missingCoreRules,
    })
  }
  const corpusSha256 = createHash('sha256')
    .update(templates.map((item) => `${item.fileName}:${item.sha256}`).sort().join('\n'))
    .digest('hex')
  const blueprint: InvestmentProposalDocumentBlueprint = {
    version: INVESTMENT_PROPOSAL_BLUEPRINT_VERSION,
    templateVersion: template.templateVersion,
    corpusSha256,
    coreStandardPath,
    coreStandardSha256,
    templates,
    page: {
      widthDxa: 11906,
      heightDxa: 16838,
      marginTopDxa: 1440,
      marginRightDxa: 1800,
      marginBottomDxa: 1440,
      marginLeftDxa: 1800,
      headerDxa: 720,
      footerDxa: 720,
    },
    typography: {
      titlePt: 16,
      heading1Pt: 14,
      heading2Pt: 14,
      heading3Pt: 12,
      bodyPt: 12,
      tablePt: 10.5,
      notePt: 10.5,
      titleFontRole: 'sans',
      heading1FontRole: 'sans',
      heading2FontRole: 'kaiti',
      heading3FontRole: 'fangsong',
      bodyFontRole: 'fangsong',
    },
    fixedBlocks: {
      salutation: '各位投资决策委员会成员：',
      authorization:
        '在投资决策委员会审议通过后，将按照审议确定原则实施本次投资的具体操作；实际投资安排以完成尽调、正式投决及签署交易文件为准。',
      managementCompany: '浙江赛智伯乐股权投资管理有限公司',
      headerCompany: '浙江赛智伯乐投资管理有限公司',
      noDataText: CURRENT_PROJECT_NO_DATA,
    },
    sections: BLUEPRINT_SECTIONS,
    requiredAnalysisKinds: REQUIRED_ANALYSIS_KINDS,
    expectedTemplateFingerprints: { ...EXPECTED_TEMPLATE_FINGERPRINTS },
  }
  cachedBlueprint = { cacheKey, blueprint }
  return blueprint
}

export function proposalSectionsForChapter(
  blueprint: InvestmentProposalDocumentBlueprint,
  rootId: string,
) {
  const descendants = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    blueprint.sections.forEach((item) => {
      if (item.parentId && descendants.has(item.parentId) && !descendants.has(item.id)) {
        descendants.add(item.id)
        changed = true
      }
    })
  }
  return blueprint.sections.filter((item) => descendants.has(item.id))
}

export function proposalSectionByTitle(
  blueprint: InvestmentProposalDocumentBlueprint,
  title: string,
) {
  return blueprint.sections.find((item) => item.title === title)
}

export function proposalLeafSections(blueprint: InvestmentProposalDocumentBlueprint) {
  return blueprint.sections.filter((item) => !item.container)
}

export function investmentProposalBlueprintPrompt(
  blueprint: InvestmentProposalDocumentBlueprint,
  sectionIds?: ReadonlySet<string>,
) {
  return JSON.stringify({
    version: blueprint.version,
    fixedNoDataText: blueprint.fixedBlocks.noDataText,
    sections: blueprint.sections
      .filter((item) => !sectionIds || sectionIds.has(item.id))
      .map((item) => ({
        id: item.id,
        title: item.title,
        level: item.level,
        parentId: item.parentId,
        container: Boolean(item.container),
        analysisKind: item.analysisKind,
        tableKind: item.tableKind,
      })),
  })
}
