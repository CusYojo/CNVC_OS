import type {
  BusinessContent,
  BusinessFinding,
  BusinessSection,
  BusinessTable,
  EvidenceSource,
} from './aiBusinessContentService.js'
import {
  CURRENT_PROJECT_NO_DATA,
  proposalLeafSections,
  proposalSectionByTitle,
  type InvestmentProposalBlueprintSection,
  type InvestmentProposalDocumentBlueprint,
} from './aiInvestmentProposalBlueprintService.js'
import type { InvestmentProposalEvidencePlan } from './aiInvestmentProposalEvidenceService.js'
import { comparisonKey, isNearDuplicate } from './aiEvidenceQualityService.js'
import {
  containsInvestmentProposalAiStyleBoilerplate,
  containsInvestmentProposalColonLabel,
  containsInvestmentProposalInlineSubheading,
  containsInvestmentProposalProseLabel,
  containsInvestmentProposalSourceProcessWording,
  containsInvestmentProposalWebArtifact,
} from './aiInvestmentProposalTextService.js'

export type InvestmentProposalReviewIssue = {
  severity: 'error' | 'warning'
  code: string
  message: string
  sectionId?: string
  findingIndex?: number
  tableIndex?: number
}

export type InvestmentProposalReviewResult = {
  passed: boolean
  issues: InvestmentProposalReviewIssue[]
  checked: {
    sectionCount: number
    leafSectionCount: number
    findingCount: number
    tableCount: number
    citedFindingCount: number
    missingEvidenceSectionCount: number
  }
}

const STATUS_VALUES = new Set<BusinessFinding['status']>([
  '资料记载',
  'AI推断',
  '待核验',
  '资料缺口',
])

const TEMPLATE_SAMPLE_TERMS = [
  '佳量脑科学',
  '飞阔科技',
  '轻蜓光电',
  '普雷赛斯',
  '微纳核芯',
  '中数睿智',
  '德塔智能',
  '蓝成应急',
  'Epilcure',
  'BCMod',
]

const UNSUPPORTED_CERTAINTY = /(?:行业第一|绝对领先|唯一|必然|确保|确定性强|毫无风险|无可替代)/
const MISSING_ACTION = /(?:需补充|尚待提供|未提供|无法判断|待取得|待访谈|待核验|资料缺口)/
const INTERNAL_ERROR_TEXT =
  /(?:HTTP\s*\d{3}|LLM\s*(?:请求|响应|返回|错误|异常|失败|超时|中断)|网关(?:错误|异常|失败)|错误编号|错误码|invalid_request_error|unsupported_value|请求重试\d*失败|模型请求(?:失败|中断|异常))/i
const EVIDENCE_PROCESS_OR_BOILERPLATE =
  /(?:证据属性|Q&A\s*分类|页面标题|发布主体|访问日期|页面正文摘录|内容指纹|项目大模型|来源网址|原文链接|京ICP备|京公网安备|Copyright\s*©|All Rights Reserved|免责声明|使用条款|隐私政策|财经\s+焦点\s+股票|innoHere英诺嘿呀\s+首页|首页\s+权威榜\s+价值榜|行业数据\s+产业图谱\s+行业研究|企业入驻\s+小程序\s+(?:登录|登入))/i
const PRODUCT_OR_TECHNOLOGY_NAME =
  /(?:[A-Za-z][A-Za-z0-9.+/_ -]{1,30}|[\u3400-\u9fffA-Za-z0-9.+/_ -]{2,32})(?:平台|系统|引擎|模型|算法|框架|软件|硬件|机器人|芯片|设备)/
const PRODUCT_TECHNOLOGY_DETAIL =
  /(?:模型|算法|框架|架构|模块|多模态|视觉|推理|训练|蒸馏|参数|数据集|API|SDK|传感|控制|编译|上线|发布|内测|商业化|部署|知识产权|专利|软件著作权)/i
const RISK_REQUIRED_PARTS = [
  { label: '触发条件', pattern: /(?:触发|若|如|一旦|当|条件)/ },
  { label: '潜在影响', pattern: /(?:影响|导致|造成|可能|风险)/ },
  { label: '缓释或核验动作', pattern: /(?:缓释|核验|补充|取得|审查|跟踪|设置|落实|完成)/ },
  { label: '责任主体', pattern: /(?:责任|投资团队|项目组|法务|财务|管理层|公司|董事会)/ },
  { label: '执行时点', pattern: /(?:时点|交割前|投决前|签约前|持续|定期|截至|阶段|完成后)/ },
]

const DELIVERY_LIMITATION_CODES = new Set([
  'MISSING_EVIDENCE_RESEARCH_REQUIRED',
  'EVIDENCE_AVAILABLE_BUT_MISSING',
])

export function isInvestmentProposalDeliveryLimitation(code: string) {
  return DELIVERY_LIMITATION_CODES.has(code)
}

export function containsInvestmentProposalInternalErrorText(value: string) {
  return INTERNAL_ERROR_TEXT.test(value)
}

function numericTokens(value: string) {
  return [...new Set(
    value.match(/(?<![A-Za-z])(?:\d{1,4}(?:[.,]\d+)*%?)(?![A-Za-z])/g) ?? [],
  )]
    .map((token) => token.replace(/,/g, ''))
    .filter((token) => !/^0+$/.test(token))
}

function normalizeNumericText(value: string) {
  return value.replace(/,/g, '').replace(/\s+/g, '')
}

function citedText(indexes: number[], sources: EvidenceSource[]) {
  return indexes.map((index) => sources[index]?.content ?? '').join('\n')
}

function issue(
  issues: InvestmentProposalReviewIssue[],
  value: Omit<InvestmentProposalReviewIssue, 'severity'> & { severity?: 'error' | 'warning' },
) {
  issues.push({ severity: value.severity ?? 'error', ...value })
}

function safeNoDataFinding(topic: string): BusinessFinding {
  const clientTopic = topic
    .replace(/^\s*(?:[一二三四五六七八九十]+、|[（(][一二三四五六七八九十]+[）)])\s*/, '')
    .trim()
  return {
    text: `${CURRENT_PROJECT_NO_DATA}需核验${clientTopic}相关关键事实后再行分析。`,
    status: '资料缺口',
    sourceIndexes: [],
  }
}

export function safeInvestmentProposalSection(
  title: string,
  topic = title,
): BusinessSection {
  return {
    title,
    summary: CURRENT_PROJECT_NO_DATA,
    findings: [safeNoDataFinding(topic)],
    tables: [],
  }
}

function reviewFinding(input: {
  finding: BusinessFinding
  section: BusinessSection
  sectionId: string
  findingIndex: number
  sources: EvidenceSource[]
  allowedSourceIndexes?: ReadonlySet<number>
  projectIdentity: string
  issues: InvestmentProposalReviewIssue[]
}) {
  const {
    finding,
    section,
    sectionId,
    findingIndex,
    sources,
    allowedSourceIndexes,
    projectIdentity,
    issues,
  } = input
  const location = { sectionId, findingIndex }
  if (!finding.text.trim()) {
    issue(issues, { ...location, code: 'EMPTY_FINDING', message: `${section.title}包含空事实项` })
    return
  }
  if (containsInvestmentProposalInternalErrorText(finding.text)) {
    issue(issues, {
      ...location,
      code: 'INTERNAL_ERROR_TEXT_LEAK',
      message: `${section.title}包含仅供系统内部记录的技术错误信息`,
    })
  }
  if (containsInvestmentProposalSourceProcessWording(finding.text)) {
    issue(issues, {
      ...location,
      code: 'SOURCE_PROCESS_WORDING_LEAK',
      message: `${section.title}向客户暴露了项目资料、会议纪要或原始文件等内部取证过程`,
    })
  }
  if (containsInvestmentProposalAiStyleBoilerplate(finding.text)) {
    issue(issues, {
      ...location,
      code: 'AI_STYLE_BOILERPLATE',
      message: `${section.title}包含模板化的 AI 套话，应改为以公司、产品、人员、交易或经营事实为主语的直接陈述`,
    })
  }
  if (EVIDENCE_PROCESS_OR_BOILERPLATE.test(finding.text)) {
    issue(issues, {
      ...location,
      code: 'EVIDENCE_PROCESS_TEXT_LEAK',
      message: `${section.title}包含网页导航、站点页脚或内部取证过程文字`,
    })
  }
  if (containsInvestmentProposalWebArtifact(finding.text)) {
    issue(issues, {
      ...location,
      code: 'WEB_ARTIFACT_TEXT_LEAK',
      message: `${section.title}包含网页折叠态或原文链接元数据`,
    })
  }
  if (containsInvestmentProposalProseLabel(finding.text)) {
    issue(issues, {
      ...location,
      code: 'CLIENT_PROSE_LABEL_LEAK',
      message: `${section.title}使用了重复的“判断/依据/影响/待办”底稿标签`,
    })
  }
  if (containsInvestmentProposalColonLabel(finding.text)) {
    issue(issues, {
      ...location,
      code: 'CLIENT_COLON_LABEL_LEAK',
      message: `${section.title}使用了“订单节奏：”一类冒号引导标签，需改写为完整自然段`,
    })
  }
  if (containsInvestmentProposalInlineSubheading(finding.text)) {
    issue(issues, {
      ...location,
      code: 'INLINE_NUMBERED_SUBHEADING_LEAK',
      message: `${section.title}在正文中使用了数字小标题，需合并为连续自然段`,
    })
  }
  if (/[\r\n]/.test(finding.text)) {
    issue(issues, {
      ...location,
      code: 'CLIENT_MANUAL_BREAK_LEAK',
      message: `${section.title}在单个正文 finding 内使用了手动换行，需合并为一个连续自然段`,
    })
  }
  if (!STATUS_VALUES.has(finding.status)) {
    issue(issues, { ...location, code: 'INVALID_STATUS', message: `${section.title}包含非法证据状态` })
  }
  const validIndexes = finding.sourceIndexes.filter((index) =>
    Number.isInteger(index) && index >= 0 && index < sources.length)
  if (validIndexes.length !== finding.sourceIndexes.length) {
    issue(issues, { ...location, code: 'INVALID_CITATION', message: `${section.title}包含越界引用` })
  }
  if (
    (finding.status === '资料记载' || finding.status === 'AI推断')
    && validIndexes.length === 0
  ) {
    issue(issues, {
      ...location,
      code: 'CITATION_REQUIRED',
      message: `${finding.status}必须引用当前项目证据`,
    })
  }
  if (
    validIndexes.length > 0
    && validIndexes.every((index) => sources[index]?.sourceType.startsWith('public_web'))
    && finding.status !== '待核验'
  ) {
    issue(issues, {
      ...location,
      code: 'PUBLIC_WEB_REQUIRES_VERIFICATION',
      message: `${section.title}仅由资料库中的公开线索支持，证据状态必须为“待核验”`,
    })
  }
  if (
    validIndexes.length === 0
    && finding.status !== '资料缺口'
    && !finding.text.startsWith(CURRENT_PROJECT_NO_DATA)
    && !MISSING_ACTION.test(finding.text)
  ) {
    issue(issues, {
      ...location,
      code: 'UNCITED_CLAIM',
      message: `${section.title}包含无引用的事实或判断`,
    })
  }
  if (finding.status === '资料缺口') {
    if (!finding.text.startsWith(CURRENT_PROJECT_NO_DATA)) {
      issue(issues, {
        ...location,
        code: 'NO_DATA_TEXT_REQUIRED',
        message: `资料缺口必须以“${CURRENT_PROJECT_NO_DATA}”开头`,
      })
    }
    if (validIndexes.length > 0) {
      issue(issues, {
        ...location,
        code: 'MISSING_WITH_CITATION',
        message: '资料缺口不得附带事实引用',
      })
    }
  }
  if (allowedSourceIndexes && validIndexes.some((index) => !allowedSourceIndexes.has(index))) {
    issue(issues, {
      ...location,
      code: 'CITATION_OUTSIDE_SECTION_EVIDENCE',
      message: `${section.title}引用了未进入本章节 Evidence Packet 的来源`,
    })
  }
  const support = normalizeNumericText(citedText(validIndexes, sources))
  numericTokens(finding.text).forEach((token) => {
    if (validIndexes.length && !support.includes(normalizeNumericText(token))) {
      issue(issues, {
        ...location,
        code: 'UNSUPPORTED_NUMBER',
        message: `${section.title}中的数字“${token}”未出现在所引证据中`,
      })
    }
  })
  TEMPLATE_SAMPLE_TERMS.forEach((term) => {
    if (finding.text.includes(term) && !projectIdentity.includes(term)) {
      issue(issues, {
        ...location,
        code: 'TEMPLATE_SAMPLE_LEAK',
        message: `${section.title}疑似泄露模板项目事实：${term}`,
      })
    }
  })
  if (UNSUPPORTED_CERTAINTY.test(finding.text)) {
    issue(issues, {
      ...location,
      code: 'UNSUPPORTED_CERTAINTY',
      message: `${section.title}使用了无条件确定性表达`,
    })
  }
}

function reviewTable(input: {
  table: BusinessTable
  section: BusinessSection
  sectionId: string
  tableKind?: InvestmentProposalBlueprintSection['tableKind']
  tableIndex: number
  sources: EvidenceSource[]
  allowedSourceIndexes?: ReadonlySet<number>
  issues: InvestmentProposalReviewIssue[]
}) {
  const {
    table,
    section,
    sectionId,
    tableKind,
    tableIndex,
    sources,
    allowedSourceIndexes,
    issues,
  } = input
  const location = { sectionId, tableIndex }
  const headerText = table.columns.join(' ')
  const requiredHeaderGroups: Partial<Record<
    NonNullable<InvestmentProposalBlueprintSection['tableKind']>,
    RegExp[]
  >> = {
    equity_structure: [/股东|股东姓名|股东名称/, /持股比例|股权比例|比例/],
    financial_summary: [/期间|年度|年份|报告期|科目/, /收入|营收|利润|现金流|成本|毛利|资产|负债/],
    financing_history: [/时间|日期|轮次/, /金额|估值|投资方|投资机构|工具/],
    transaction_plan: [
      /投资形式|投资方式|交易方式|增资|老股/,
      /金额|估值|股比|持股比例/,
      /投前|投后|资金用途|交割/,
    ],
    forecast_return: [/年度|年份|期间|A\/E/i, /收入|营收|利润|退出|回报|IRR|MOIC|估值|倍数/i],
    comparable_valuation: [/公司|企业|标的|可比/, /估值|市值|PE|PS|EV|倍数/i],
  }
  if (
    tableKind
    && requiredHeaderGroups[tableKind]?.some((pattern) => !pattern.test(headerText))
  ) {
    issue(issues, {
      ...location,
      code: 'TABLE_SCHEMA_MISMATCH',
      message: `${section.title}表头不符合“${tableKind}”结构化数据槽位`,
    })
  }
  if (tableKind === 'equity_structure') {
    const ratioColumnIndex = table.columns.findIndex((column) =>
      /持股比例|股权比例|比例/.test(column))
    if (
      ratioColumnIndex < 0
      || table.rows.some((row) => !/^\s*\d+(?:\.\d+)?%\s*$/.test(row[ratioColumnIndex] ?? ''))
    ) {
      issue(issues, {
        ...location,
        code: 'EQUITY_RATIO_REQUIRED',
        message: `${section.title}股权表必须逐行提供证据支持的明确持股比例`,
      })
    }
  }
  const clientTableText = [table.title, headerText, ...table.rows.flat()].join(' ')
  if (containsInvestmentProposalSourceProcessWording(clientTableText)) {
    issue(issues, {
      ...location,
      code: 'TABLE_SOURCE_PROCESS_WORDING_LEAK',
      message: `${section.title}表格向客户暴露了内部取证过程`,
    })
  }
  if (containsInvestmentProposalAiStyleBoilerplate(clientTableText)) {
    issue(issues, {
      ...location,
      code: 'TABLE_AI_STYLE_BOILERPLATE',
      message: `${section.title}表格包含模板化的 AI 套话`,
    })
  }
  if (EVIDENCE_PROCESS_OR_BOILERPLATE.test(clientTableText)) {
    issue(issues, {
      ...location,
      code: 'TABLE_EVIDENCE_PROCESS_TEXT_LEAK',
      message: `${section.title}表格包含网页导航、站点页脚或内部取证过程文字`,
    })
  }
  if (table.columns.length < 2 || table.columns.length > 8) {
    issue(issues, { ...location, code: 'INVALID_TABLE_COLUMNS', message: `${section.title}表格列数必须为 2–8` })
  }
  if (!table.rows.length || table.rows.length > 30) {
    issue(issues, { ...location, code: 'INVALID_TABLE_ROWS', message: `${section.title}表格行数必须为 1–30` })
  }
  if (table.rows.some((row) => row.length !== table.columns.length)) {
    issue(issues, { ...location, code: 'TABLE_SHAPE_MISMATCH', message: `${section.title}表格行列不一致` })
  }
  const validIndexes = table.sourceIndexes.filter((index) =>
    Number.isInteger(index) && index >= 0 && index < sources.length)
  if (!validIndexes.length) {
    issue(issues, { ...location, code: 'TABLE_CITATION_REQUIRED', message: `${section.title}表格必须引用当前项目证据` })
  }
  if (
    validIndexes.length > 0
    && validIndexes.every((index) => sources[index]?.sourceType.startsWith('public_web'))
    && table.status !== '待核验'
  ) {
    issue(issues, {
      ...location,
      code: 'PUBLIC_WEB_TABLE_REQUIRES_VERIFICATION',
      message: `${section.title}表格仅由资料库中的公开线索支持，证据状态必须为“待核验”`,
    })
  }
  if (allowedSourceIndexes && validIndexes.some((index) => !allowedSourceIndexes.has(index))) {
    issue(issues, {
      ...location,
      code: 'TABLE_CITATION_OUTSIDE_SECTION',
      message: `${section.title}表格引用了未进入本章节 Evidence Packet 的来源`,
    })
  }
  const support = normalizeNumericText(citedText(validIndexes, sources))
  const tableText = [...table.columns, ...table.rows.flat()].join(' ')
  const supportKey = comparisonKey(citedText(validIndexes, sources))
  const unsupportedCells = table.rows
    .flat()
    .map((cell) => cell.trim())
    .filter((cell) => {
      const key = comparisonKey(cell)
      return key.length >= 2
        && key.length <= 40
        && !/^(?:无|未知|未披露|未透露|待核验|不适用|N\/?A)$/i.test(cell)
        && !supportKey.includes(key)
    })
  if (validIndexes.length && unsupportedCells.length) {
    issue(issues, {
      ...location,
      code: 'TABLE_CELL_UNSUPPORTED',
      message: `${section.title}表格存在未在引用证据中逐字出现的单元格：${unsupportedCells.slice(0, 3).join('、')}`,
    })
  }
  numericTokens(tableText).forEach((token) => {
    if (!support.includes(normalizeNumericText(token))) {
      issue(issues, {
        ...location,
        code: 'UNSUPPORTED_TABLE_NUMBER',
        message: `${section.title}表格数字“${token}”未出现在所引证据中`,
      })
    }
  })
}

export function reviewInvestmentProposalContent(input: {
  content: BusinessContent
  blueprint: InvestmentProposalDocumentBlueprint
  evidencePlan: InvestmentProposalEvidencePlan
  sources: EvidenceSource[]
  projectName: string
  companyName?: string | null
  sectionIds?: ReadonlySet<string>
}): InvestmentProposalReviewResult {
  const {
    content,
    blueprint,
    evidencePlan,
    sources,
    projectName,
    companyName,
    sectionIds,
  } = input
  const issues: InvestmentProposalReviewIssue[] = []
  const expectedDefinitions = blueprint.sections.filter((definition) =>
    !sectionIds || sectionIds.has(definition.id))
  const expectedTitles = expectedDefinitions.map((definition) => definition.title)
  const actualTitles = content.sections.map((section) => section.title)
  if (
    actualTitles.length !== expectedTitles.length
    || actualTitles.some((title, index) => title !== expectedTitles[index])
  ) {
    issue(issues, {
      code: 'SECTION_TREE_MISMATCH',
      message: `章节必须逐字、逐序匹配 Blueprint；预期 ${expectedTitles.length} 节，实际 ${actualTitles.length} 节`,
    })
  }
  if (!content.title.includes('提案') || !(content.title.includes(companyName || '') || content.title.includes(projectName))) {
    issue(issues, { code: 'INVALID_TITLE', message: '主标题未按目标公司投资提案格式生成' })
  }
  if (containsInvestmentProposalInternalErrorText(content.executiveSummary)) {
    issue(issues, {
      code: 'INTERNAL_ERROR_TEXT_LEAK',
      message: '执行摘要包含仅供系统内部记录的技术错误信息',
    })
  }
  if (containsInvestmentProposalSourceProcessWording(content.executiveSummary)) {
    issue(issues, {
      code: 'SOURCE_PROCESS_WORDING_LEAK',
      message: '执行摘要向客户暴露了项目资料、会议纪要或原始文件等内部取证过程',
    })
  }
  if (containsInvestmentProposalAiStyleBoilerplate(content.executiveSummary)) {
    issue(issues, {
      code: 'AI_STYLE_BOILERPLATE',
      message: '执行摘要包含模板化的 AI 套话，应改为直接的提案说明',
    })
  }
  const projectIdentity = `${projectName} ${companyName ?? ''}`
  const evidenceBySection = new Map(evidencePlan.sections.map((section) => [
    section.sectionId,
    new Set(section.sourceIndexes),
  ]))
  const coverageBySection = new Map(evidencePlan.sections.map((section) => [
    section.sectionId,
    section.coverage,
  ]))
  const priorFindings: string[] = []

  expectedDefinitions.forEach((definition, expectedIndex) => {
    const sectionValue = content.sections[expectedIndex]
      ?? content.sections.find((section) => section.title === definition.title)
    if (!sectionValue) {
      issue(issues, {
        sectionId: definition.id,
        code: 'MISSING_SECTION',
        message: `缺少章节：${definition.title}`,
      })
      return
    }
    if (definition.container) {
      if (sectionValue.findings.length || (sectionValue.tables?.length ?? 0) > 0) {
        issue(issues, {
          sectionId: definition.id,
          code: 'CONTAINER_HAS_CONTENT',
          message: `容器章节“${definition.title}”不得与子章节重复承载正文`,
        })
      }
      return
    }
    if (containsInvestmentProposalInternalErrorText(sectionValue.summary)) {
      issue(issues, {
        sectionId: definition.id,
        code: 'INTERNAL_ERROR_TEXT_LEAK',
        message: `章节“${definition.title}”摘要包含仅供系统内部记录的技术错误信息`,
      })
    }
    if (containsInvestmentProposalSourceProcessWording(sectionValue.summary)) {
      issue(issues, {
        sectionId: definition.id,
        code: 'SOURCE_PROCESS_WORDING_LEAK',
        message: `章节“${definition.title}”摘要向客户暴露了内部取证过程`,
      })
    }
    if (containsInvestmentProposalAiStyleBoilerplate(sectionValue.summary)) {
      issue(issues, {
        sectionId: definition.id,
        code: 'AI_STYLE_BOILERPLATE',
        message: `章节“${definition.title}”摘要包含模板化的 AI 套话`,
      })
    }
    if (!sectionValue.findings.length) {
      issue(issues, {
        sectionId: definition.id,
        code: 'EMPTY_SECTION',
        message: `章节“${definition.title}”没有正文或资料缺口说明`,
      })
      return
    }
    if (coverageBySection.get(definition.id) === 'missing') {
      issue(issues, {
        severity: 'warning',
        sectionId: definition.id,
        code: 'MISSING_EVIDENCE_RESEARCH_REQUIRED',
        message: `章节“${definition.title}”没有项目资料库证据；受限初稿中保留资料缺口并提示补充原始资料`,
      })
    } else if (sectionValue.findings.every((finding) => finding.status === '资料缺口')) {
      issue(issues, {
        // 章节生成阶段仍先要求模型按已有 Evidence 重生；两次生成后若仍无法
        // 形成受支持的结论，全篇 Reviewer 将其降级为可交付限制项。
        severity: sectionIds ? 'error' : 'warning',
        sectionId: definition.id,
        code: 'EVIDENCE_AVAILABLE_BUT_MISSING',
        message: `章节“${definition.title}”已有项目资料，但未形成可安全引用的结论；受限初稿中保留资料缺口`,
      })
    }
    if (
      definition.analysisKind === 'product_technology'
      && sectionValue.findings.some((finding) => finding.status !== '资料缺口')
    ) {
      const productText = sectionValue.findings
        .filter((finding) => finding.status !== '资料缺口')
        .map((finding) => finding.text)
        .join(' ')
      if (!PRODUCT_OR_TECHNOLOGY_NAME.test(productText)) {
        issue(issues, {
          sectionId: definition.id,
          code: 'PRODUCT_NAME_OR_FORM_REQUIRED',
          message: '产品及技术必须写出当前项目可识别的具体产品、平台、系统、模型、算法或技术架构名称',
        })
      }
      if (!PRODUCT_TECHNOLOGY_DETAIL.test(productText)) {
        issue(issues, {
          sectionId: definition.id,
          code: 'PRODUCT_TECHNOLOGY_DETAIL_REQUIRED',
          message: '产品及技术必须包含功能、关键模块、技术路径或成熟度中的至少一项具体信息',
        })
      }
      const packet = evidencePlan.sections.find((item) => item.sectionId === definition.id)
      const localSourceIndexes = new Set(
        (packet?.sourceIndexes ?? []).filter((index) =>
          !sources[index]?.sourceType.startsWith('public_web')),
      )
      const citedIndexes = new Set(
        sectionValue.findings
          .filter((finding) => finding.status !== '资料缺口')
          .flatMap((finding) => finding.sourceIndexes),
      )
      if (
        localSourceIndexes.size > 0
        && ![...citedIndexes].some((index) => localSourceIndexes.has(index))
      ) {
        issue(issues, {
          sectionId: definition.id,
          code: 'PRODUCT_LOCAL_EVIDENCE_BYPASSED',
          message: '产品及技术已有本地项目资料，不得仅使用公开网页的泛化介绍代替具体产品和技术内容',
        })
      }
    }
    const primaryConclusionFindingIndex = definition.analysisKind === 'conclusion'
      ? sectionValue.findings.findIndex((finding) => finding.status !== '资料缺口')
      : -1
    sectionValue.findings.forEach((finding, findingIndex) => {
      reviewFinding({
        finding,
        section: sectionValue,
        sectionId: definition.id,
        findingIndex,
        sources,
        allowedSourceIndexes: evidenceBySection.get(definition.id),
        projectIdentity,
        issues,
      })
      if (definition.analysisKind === 'risk_summary' && finding.status !== '资料缺口') {
        const missingParts = RISK_REQUIRED_PARTS
          .filter((part) => !part.pattern.test(finding.text))
          .map((part) => part.label)
        if (missingParts.length) {
          issue(issues, {
            sectionId: definition.id,
            findingIndex,
            code: 'RISK_ACTION_CHAIN_INCOMPLETE',
            message: `风险项缺少：${missingParts.join('、')}`,
          })
        }
      }
      if (
        definition.analysisKind === 'conclusion'
        && findingIndex === primaryConclusionFindingIndex
        && finding.status !== '资料缺口'
        && (
          !/(?:进入初筛|继续跟踪|申请立项|启动尽调|提请上会|提交投决|暂缓推进|归档)/.test(finding.text)
          || !/(?:建议|推进|暂停|重新评估|初筛|跟踪|立项|尽调|上会|投决|归档)/.test(finding.text)
          || !/(?:在.+后|完成|落实|经.+确认|若|如|前提|条件)/.test(finding.text)
        )
      ) {
        issue(issues, {
          sectionId: definition.id,
          findingIndex,
          code: 'CONDITIONAL_CONCLUSION_REQUIRED',
          message: '结论必须结合当前项目阶段给出一个推进、暂缓或归档主建议，并包含明确的前置条件、下一步动作和 OA 流转边界',
        })
      }
      if (isNearDuplicate(finding.text, priorFindings, 0.86)) {
        issue(issues, {
          severity: 'warning',
          sectionId: definition.id,
          findingIndex,
          code: 'DUPLICATE_FINDING',
          message: `章节“${definition.title}”与前文存在近似重复`,
        })
      } else {
        priorFindings.push(finding.text)
      }
    })
    ;(sectionValue.tables ?? []).forEach((table, tableIndex) => reviewTable({
      table,
      section: sectionValue,
      sectionId: definition.id,
      tableKind: definition.tableKind,
      tableIndex,
      sources,
      allowedSourceIndexes: evidenceBySection.get(definition.id),
      issues,
    }))
  })

  blueprint.requiredAnalysisKinds.forEach((kind) => {
    const definition = blueprint.sections.find((item) => item.analysisKind === kind)
    if (!definition || (sectionIds && !sectionIds.has(definition.id))) return
    if (!content.sections.some((section) => section.title === definition.title)) {
      issue(issues, {
        sectionId: definition.id,
        code: 'REQUIRED_ANALYSIS_MISSING',
        message: `缺少必做分析：${definition.title}`,
      })
    }
  })

  return {
    passed: !issues.some((item) => item.severity === 'error'),
    issues,
    checked: {
      sectionCount: content.sections.length,
      leafSectionCount: proposalLeafSections(blueprint).filter((section) =>
        !sectionIds || sectionIds.has(section.id)).length,
      findingCount: content.sections.reduce((count, section) => count + section.findings.length, 0),
      tableCount: content.sections.reduce((count, section) => count + (section.tables?.length ?? 0), 0),
      citedFindingCount: content.sections.reduce(
        (count, section) => count + section.findings.filter((finding) => finding.sourceIndexes.length).length,
        0,
      ),
      missingEvidenceSectionCount: expectedDefinitions.filter((definition) =>
        !definition.container && coverageBySection.get(definition.id) === 'missing').length,
    },
  }
}

export function reviewIssuesForPrompt(review: InvestmentProposalReviewResult) {
  return review.issues
    .filter((item) => item.severity === 'error')
    .slice(0, 20)
    .map((item) => `${item.code}：${item.message}`)
    .join('\n')
}

export function proposalSectionIdForTitle(
  blueprint: InvestmentProposalDocumentBlueprint,
  title: string,
) {
  return proposalSectionByTitle(blueprint, title)?.id
}
