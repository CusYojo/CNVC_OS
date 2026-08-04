import type {
  BusinessContent,
  BusinessFinding,
  BusinessSection,
  BusinessTable,
  EvidenceSource,
} from './aiBusinessContentService.js'
import {
  proposalLeafSections,
  proposalSectionByTitle,
  type InvestmentProposalBlueprintSection,
  type InvestmentProposalDocumentBlueprint,
} from './aiInvestmentProposalBlueprintService.js'
import type { InvestmentProposalEvidencePlan } from './aiInvestmentProposalEvidenceService.js'
import { comparisonKey, isNearDuplicate } from './aiEvidenceQualityService.js'
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
  { label: '具体风险或触发情形', pattern: /(?:风险|触发|若|如|一旦|当|条件|尚未|不足|依赖|波动|不确定|受限|缺乏)/ },
  { label: '潜在影响', pattern: /(?:影响|导致|造成|可能使|可能导致|不利于|制约|削弱|增加|降低|延迟|受阻|损失)/ },
]
const RISK_SECTION_ACTION = /(?:缓释|核验|补充|取得|审查|跟踪|设置|落实|完成|确认|复核|约定|查验)/

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
  const fallbacks: Record<string, string> = {
    公司简介: '公司的法律主体、成立时间、注册地和主营业务尚未明确，申请立项前应取得工商档案、公司章程和业务说明并完成核对。',
    核心团队: '核心团队成员、任职履历、职责分工和全职状态尚未明确，申请立项前应取得管理层简历、任职证明和组织架构并完成访谈。',
    公司股权结构: '公司完整股东名单、持股比例、实际控制人及特别权利安排尚未明确，申请立项前应取得最新公司章程、股东名册和工商档案并完成核对。',
    产品及技术: '公司的具体产品、技术架构、知识产权和产品化进度尚未明确，申请立项前应取得产品说明、技术文档和知识产权清单并完成技术访谈。',
    运营摘要: '公司的客户构成、订单、交付、回款和渠道情况尚未明确，申请立项前应取得客户清单、合同台账、交付记录和回款凭证并完成核对。',
    财务摘要: '公司的收入、成本、利润、现金流和资产负债情况尚未明确，申请立项前应取得财务报表、审计报告和主要科目明细并完成核对。',
    历史融资情况: '公司的历次融资轮次、金额、估值、投资方和股权变动尚未明确，申请立项前应取得增资协议、股权转让文件和融资后股权表并完成核对。',
    本轮公司估值和投资方案: '本轮融资金额、估值、投资工具、拟出让股比和资金用途尚未明确，进入交易谈判前应取得公司正式融资方案并核对核心条款。',
    风险控制及保护性条款: '本轮交易的治理权、信息权、优先权、反稀释和退出安排尚未明确，签署交易文件前应形成完整条款清单并由法务审核。',
    经营预测与回报测算: '公司的经营预测、关键假设、退出口径和回报测算尚未明确，提请投决前应取得管理层预测模型并完成敏感性复核。',
    可比公司估值比较: '可比公司的筛选口径、估值时点和核心倍数尚未明确，提请投决前应统一数据口径并完成可比估值复核。',
    项目亮点总结: '尚无足以支撑投资亮点的可核验事实，项目负责人应先补齐团队、技术、客户和经营数据，再据此提炼项目的核心优势及成立条件。',
    风险提示与对策: '项目在经营、技术、合规和交易层面的关键风险及触发条件尚未明确，申请立项前应形成风险清单并明确核验责任人与完成时点。',
    结论: '交易方案、核心风险和前置条件尚未明确，暂不进入下一决策环节；项目负责人应补齐关键事实并完成复核后重新提交。',
  }
  return {
    text: fallbacks[clientTopic]
      ?? `${clientTopic}涉及的关键事实尚未明确，进入下一阶段前应补充相关文件并完成核对。`,
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
    summary: '',
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
  if (containsInvestmentProposalConversationalWording(finding.text)) {
    issue(issues, {
      ...location,
      code: 'CONVERSATIONAL_TRANSCRIPT_LEAK',
      message: `${section.title}直接保留了交流口语或转录语气，应提炼为正式、克制的书面陈述`,
    })
  }
  if (containsInvestmentProposalLongQuotedExcerpt(finding.text)) {
    issue(issues, {
      ...location,
      code: 'LONG_QUOTED_EVIDENCE_LEAK',
      message: `${section.title}包含长段引号摘录，应先概括事实再写入正文`,
    })
  }
  if (containsInvestmentProposalFormulaicAnalysisWrapper(finding.text)) {
    issue(issues, {
      ...location,
      code: 'FORMULAIC_ANALYSIS_WRAPPER',
      message: `${section.title}使用了机械的判断或核验套句，应结合本节具体事实自然表述`,
    })
  }
  if (containsInvestmentProposalGenericNoDataPreface(finding.text)) {
    issue(issues, {
      ...location,
      code: 'GENERIC_NO_DATA_PREFACE',
      message: `${section.title}使用了统一的无资料判定前缀，应直接写明尚未明确的具体事项`,
    })
  }
  if (containsInvestmentProposalAbnormalSpacing(finding.text)) {
    issue(issues, {
      ...location,
      code: 'ABNORMAL_TYPOGRAPHY_SPACING',
      message: `${section.title}包含中文字符、数字单位或标点附近的异常空格`,
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
    && !MISSING_ACTION.test(finding.text)
  ) {
    issue(issues, {
      ...location,
      code: 'UNCITED_CLAIM',
      message: `${section.title}包含无引用的事实或判断`,
    })
  }
  if (finding.status === '资料缺口') {
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
  if ([table.title, ...table.columns, ...table.rows.flat()]
    .some((value) => containsInvestmentProposalAbnormalSpacing(value))) {
    issue(issues, {
      ...location,
      code: 'TABLE_ABNORMAL_TYPOGRAPHY_SPACING',
      message: `${section.title}表格包含异常中文排版空格`,
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
  if (containsInvestmentProposalConversationalWording(content.executiveSummary)) {
    issue(issues, {
      code: 'CONVERSATIONAL_TRANSCRIPT_LEAK',
      message: '执行摘要包含交流口语或转录语气，应改为正式书面陈述',
    })
  }
  if (containsInvestmentProposalLongQuotedExcerpt(content.executiveSummary)) {
    issue(issues, {
      code: 'LONG_QUOTED_EVIDENCE_LEAK',
      message: '执行摘要包含长段引号摘录，应先概括事实再写入正文',
    })
  }
  if (containsInvestmentProposalFormulaicAnalysisWrapper(content.executiveSummary)) {
    issue(issues, {
      code: 'FORMULAIC_ANALYSIS_WRAPPER',
      message: '执行摘要使用机械判断套句，应按具体投资事项自然表述',
    })
  }
  if (containsInvestmentProposalAbnormalSpacing(content.executiveSummary)) {
    issue(issues, {
      code: 'ABNORMAL_TYPOGRAPHY_SPACING',
      message: '执行摘要包含异常中文排版空格',
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
    if (containsInvestmentProposalConversationalWording(sectionValue.summary)) {
      issue(issues, {
        sectionId: definition.id,
        code: 'CONVERSATIONAL_TRANSCRIPT_LEAK',
        message: `章节“${definition.title}”摘要包含交流口语或转录语气`,
      })
    }
    if (containsInvestmentProposalLongQuotedExcerpt(sectionValue.summary)) {
      issue(issues, {
        sectionId: definition.id,
        code: 'LONG_QUOTED_EVIDENCE_LEAK',
        message: `章节“${definition.title}”摘要包含长段引号摘录`,
      })
    }
    if (containsInvestmentProposalFormulaicAnalysisWrapper(sectionValue.summary)) {
      issue(issues, {
        sectionId: definition.id,
        code: 'FORMULAIC_ANALYSIS_WRAPPER',
        message: `章节“${definition.title}”摘要使用了机械判断套句`,
      })
    }
    if (containsInvestmentProposalAbnormalSpacing(sectionValue.summary)) {
      issue(issues, {
        sectionId: definition.id,
        code: 'ABNORMAL_TYPOGRAPHY_SPACING',
        message: `章节“${definition.title}”摘要包含异常中文排版空格`,
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
    const sectionNarrative = sectionValue.findings
      .filter((finding) => finding.status !== '资料缺口')
      .map((finding) => finding.text)
      .join(' ')
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
    if (
      definition.analysisKind === 'risk_summary'
      && sectionNarrative
      && !RISK_SECTION_ACTION.test(sectionNarrative)
    ) {
      issue(issues, {
        sectionId: definition.id,
        code: 'RISK_ACTION_MISSING',
        message: '风险章节必须至少给出一项与主要风险对应的缓释或核验安排，但不要求每条风险重复责任人和时点',
      })
    }
    if (
      definition.analysisKind === 'conclusion'
      && primaryConclusionFindingIndex >= 0
      && (
        !/(?:进入初筛|继续(?:跟踪|观察)|申请立项|启动尽调|提请上会|提交投决|暂缓(?:推进)?|暂停推进|归档|终止)/.test(sectionNarrative)
        || !/(?:完成|落实|确认|若|如|前提|条件|取决于|待.+(?:确认|完成|落实)|(?:交割|投决|签约|审批|立项|尽调|上会)前|(?:完成|确认|落实)后)/.test(sectionNarrative)
        || !/(?:下一步|应|优先|补齐|核实|核对|取得|完成|落实|确认)/.test(sectionNarrative)
      )
    ) {
      issue(issues, {
        sectionId: definition.id,
        findingIndex: primaryConclusionFindingIndex,
        code: 'CONDITIONAL_CONCLUSION_REQUIRED',
        message: '结论须用自然语言给出与当前阶段匹配的明确方向，并说明成立条件和下一步动作；不得用“推进下一阶段”等空泛表述替代具体判断',
      })
    }
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
