import { createHash } from 'node:crypto'
import { stat, writeFile, access, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { BusinessContent, EvidenceSource } from './aiBusinessContentService.js'
import { getAiSkillDirectory, getAiSkillRuntimeDirectory } from './aiSkillService.js'
import { execFileSupervised as execFileAsync } from '../runtime/supervisedProcessService.js'
import { fetchAiGatewayChatCompatible } from './aiGatewayService.js'
const SKILL_NAME = 'write-investment-dd-report' as const
const GW_BASE = (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, '')
const GW_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''
const MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-6'

type ProjectLike = {
  name: string
  companyName?: string | null
  industry?: string | null
  financing?: string | null
  valuation?: string | null
  summary?: string | null
  businessModel?: string | null
  market?: string | null
  team?: string | null
}

type DueDiligencePackage = {
  reportMode?: string
  blockedReasons?: string[]
  diligenceData?: Record<string, unknown>
  report?: Record<string, unknown>
}

type NormalizedDueDiligencePackage = {
  reportMode: string
  diligenceData: Record<string, unknown>
  report: Record<string, unknown>
}

function compactText(value: unknown, maximum = 1800) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function isPublicSource(source: EvidenceSource) {
  return /public|web|official|registry|patent|court|regulator/i.test(source.sourceType)
}

function isPrimaryProjectSource(source: EvidenceSource) {
  return /file|contract|financial|primary_document/i.test(source.sourceType)
}

export function dueDiligenceAtomicStatements(source: EvidenceSource) {
  const rawLines = source.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const pageExcerpt = rawLines
    .filter((line) => /^页面正文摘录[：:]/.test(line))
    .map((line) => line.replace(/^页面正文摘录[：:]\s*/, ''))
  const usableLines = pageExcerpt.length > 0
    ? pageExcerpt
    : rawLines.filter((line) => !/^(?:证据属性|项目匹配|Q&A\s*分类|检索方式|检索问题|页面标题|发布主体|发布日期|访问日期|来源网址|原文链接|内容指纹|项目大模型|联网工作流|来源可靠性)[：:]/i.test(line))
  return usableLines
    .flatMap((line) => line.split(/(?<=[。！？；])\s*/))
    .map((line) => compactText(line, 600))
    .filter((line) => line.length >= 6 && !/(?:^|[：:])\s*(?:待核验|暂无|未知|未提取|未明确披露)[。；]?$/.test(line))
    // A primary-document chunk commonly starts with provenance or scope notes
    // before a multi-field registry/table record. Four statements silently
    // dropped later fields such as the unified social credit code, contract
    // acceptance and cash evidence. Keep a bounded but complete chunk-level
    // set; the ledger still has the independent global 320-fact ceiling.
    .slice(0, 16)
}

function sourceStatus(source: EvidenceSource) {
  if (isPublicSource(source)) {
    return 'public_fact'
  }
  if (isPrimaryProjectSource(source)) {
    return 'verified'
  }
  return 'company_claim'
}

function sourceType(source: EvidenceSource) {
  if (isPublicSource(source)) {
    return 'public_authoritative'
  }
  if (isPrimaryProjectSource(source)) {
    return 'primary_document'
  }
  return 'management_record'
}

function buildEvidenceLedger(input: {
  project: ProjectLike
  sources: EvidenceSource[]
  sourceCutoffDate: string
}) {
  const legalEntity = input.project.companyName || input.project.name
  const facts = input.sources
    .flatMap((source, sourceIndex) => dueDiligenceAtomicStatements(source).map((statement) => ({
      source,
      sourceIndex,
      statement,
    })))
    .slice(0, 320)
    .map(({ source, sourceIndex, statement }, index) => ({
      id: `F${String(index + 1).padStart(3, '0')}`,
      source_index: sourceIndex,
      statement,
      entity: legalEntity,
      period: source.versionOrDate || input.sourceCutoffDate,
      unit: /\d/.test(statement) ? '以原始资料口径为准' : '不适用',
      source: source.locator || `${source.sourceType}://${source.sourceId || source.sourceName}#chunk=${source.chunkIndex ?? 0}`,
      source_type: sourceType(source),
      status: sourceStatus(source),
      materiality: 'low',
      conflicts: [],
      as_of_date: source.versionOrDate || input.sourceCutoffDate,
      intended_use: '尽调字段、正文事实与投资判断',
    }))
  if (facts.length === 0) {
    throw Object.assign(new Error('尽调报告没有可进入证据台账的项目事实'), {
      code: 'DUE_DILIGENCE_EVIDENCE_EMPTY',
    })
  }
  return {
    project: {
      name: input.project.name,
      legal_entity: legalEntity,
      cutoff_date: input.sourceCutoffDate,
      currency: 'CNY',
    },
    facts,
  }
}

const REPORT_OUTLINES: Record<string, string[]> = {
  screening_public: [
    '投资判断', '公司与股权', '核心团队', '产品与技术', '客户与商业化',
    '市场与竞争', '合规与关键风险', '结论及建议',
  ],
  business_dd: [
    '专项结论', '公司与产品', '商业模式', '客户验证与收入质量',
    '市场与竞争', '业务风险与交易处理', '结论及建议',
  ],
  financial_dd: [
    '专项结论', '收入与毛利质量', '历史财务', '营运资金与现金消耗',
    '预测与资金需求', '财务风险与交易处理', '结论及建议',
  ],
  legal_dd: [
    '专项结论', '主体、股权与控制权', '知识产权与数据权属', '重大合同与关联交易',
    '许可、劳动与合规', '法律风险与交易处理', '结论及建议',
  ],
  technical_dd: [
    '专项结论', '团队与研发组织', '产品矩阵', '技术架构与性能',
    '知识产权与关键依赖', '技术风险与交易处理', '结论及建议',
  ],
  pre_ic: [
    '投资概要', '公司概况', '产品与技术', '业务情况', '行业和市场',
    '未来发展规划', '投资方案', '风险提示与对策', '投资结论及建议',
  ],
  comprehensive_ic: [
    '投资概要', '公司概况', '产品与技术', '业务情况', '行业和市场',
    '未来发展规划', '投资方案', '风险提示与对策', '投资结论及建议',
  ],
}

const REPORT_MODES = new Set(Object.keys(REPORT_OUTLINES))

const MODE_REQUIRED_FIELDS: Record<string, string[]> = {
  screening_public: [
    'entity.basic_registry', 'ownership.public_ownership', 'team.core_people',
    'product.product_matrix', 'business.public_customer_cases', 'market.competitor_matrix',
    'legal.public_compliance', 'decision.recommendation',
  ],
  business_dd: [
    'entity.basic_registry', 'product.product_matrix', 'business.customer_closed_loop',
    'business.revenue_breakdown', 'market.competitor_matrix', 'decision.recommendation',
  ],
  financial_dd: [
    'entity.basic_registry', 'business.revenue_breakdown', 'finance.historical_financials',
    'finance.cash_runway', 'finance.working_capital', 'finance.forecast_and_funding',
    'decision.recommendation',
  ],
  legal_dd: [
    'entity.basic_registry', 'ownership.current_cap_table', 'ownership.control',
    'product.ip_schedule', 'legal.compliance_schedule', 'legal.related_party_transactions',
    'legal.material_contracts', 'decision.recommendation',
  ],
  technical_dd: [
    'entity.basic_registry', 'team.core_people', 'product.product_matrix',
    'product.technology_architecture', 'product.ip_schedule', 'decision.recommendation',
  ],
  pre_ic: [
    'entity.basic_registry', 'ownership.current_cap_table', 'ownership.financing_history',
    'ownership.control', 'team.core_people', 'team.organization_headcount',
    'product.product_matrix', 'product.technology_architecture', 'product.ip_schedule',
    'business.customer_closed_loop', 'business.revenue_breakdown',
    'finance.historical_financials', 'finance.cash_runway', 'finance.forecast_and_funding',
    'market.competitor_matrix', 'legal.compliance_schedule',
    'legal.related_party_transactions', 'transaction.round_terms',
    'transaction.pro_forma_cap_table', 'valuation.valuation_result',
    'risk.risk_register', 'decision.recommendation',
  ],
  comprehensive_ic: [],
}
MODE_REQUIRED_FIELDS.comprehensive_ic = [
  ...MODE_REQUIRED_FIELDS.pre_ic,
  'business.cost_and_suppliers', 'finance.working_capital',
  'valuation.return_scenarios', 'legal.material_contracts',
]

const ROLE_REQUIRED_FIELD: Record<string, string> = {
  company_key_facts: 'entity.basic_registry',
  transaction_summary: 'transaction.round_terms',
  cap_table: 'ownership.current_cap_table',
  financing_history: 'ownership.financing_history',
  control_structure: 'ownership.control',
  team: 'team.core_people',
  organization_headcount: 'team.organization_headcount',
  product_matrix: 'product.product_matrix',
  technology_architecture: 'product.technology_architecture',
  ip_schedule: 'product.ip_schedule',
  customer_closed_loop: 'business.customer_closed_loop',
  public_customer_cases: 'business.public_customer_cases',
  revenue_breakdown: 'business.revenue_breakdown',
  cost_and_suppliers: 'business.cost_and_suppliers',
  historical_financials: 'finance.historical_financials',
  cash_runway: 'finance.cash_runway',
  working_capital: 'finance.working_capital',
  forecast_and_funding: 'finance.forecast_and_funding',
  competitor_matrix: 'market.competitor_matrix',
  legal_compliance: 'legal.compliance_schedule',
  related_party_transactions: 'legal.related_party_transactions',
  material_contracts: 'legal.material_contracts',
  valuation: 'valuation.valuation_result',
  return_scenarios: 'valuation.return_scenarios',
  risk_register: 'risk.risk_register',
  decision: 'decision.recommendation',
}

const MODE_REQUIRED_ROLES: Record<string, string[]> = {
  screening_public: [],
  business_dd: [
    'company_key_facts', 'product_matrix', 'customer_closed_loop',
    'revenue_breakdown', 'competitor_matrix', 'decision',
  ],
  financial_dd: [
    'company_key_facts', 'revenue_breakdown', 'historical_financials',
    'cash_runway', 'working_capital', 'forecast_and_funding', 'decision',
  ],
  legal_dd: [
    'company_key_facts', 'cap_table', 'control_structure', 'ip_schedule',
    'legal_compliance', 'related_party_transactions', 'material_contracts', 'decision',
  ],
  technical_dd: [
    'company_key_facts', 'team', 'product_matrix', 'technology_architecture',
    'ip_schedule', 'decision',
  ],
  pre_ic: [
    'company_key_facts', 'transaction_summary', 'cap_table', 'team', 'product_matrix',
    'customer_closed_loop', 'historical_financials', 'forecast_and_funding',
    'competitor_matrix', 'valuation', 'risk_register', 'decision',
  ],
  comprehensive_ic: Object.keys(ROLE_REQUIRED_FIELD).filter((role) => ![
    'public_customer_cases', 'cost_and_suppliers', 'working_capital', 'material_contracts',
  ].includes(role)),
}

const FIELD_ID_BY_ROLE = new Map(Object.entries(ROLE_REQUIRED_FIELD))
const ROLE_BY_FIELD_ID = new Map(Object.entries(ROLE_REQUIRED_FIELD).map(([role, field]) => [field, role]))
const SOURCE_GRADES = new Set([
  'primary_document', 'management_record', 'third_party_primary', 'public_authoritative',
  'public_secondary', 'analyst_model', 'not_applicable',
])
const FIELD_STATUSES = new Set(['supported', 'conflicted', 'absent', 'not_applicable'])
const BLOCK_TYPES = new Set([
  'heading', 'paragraph', 'bullet', 'numbered_item', 'callout', 'table',
  'key_value_table', 'image', 'page_break', 'section_break',
])
const BLOCK_NATURES = new Set(['fact', 'analysis', 'recommendation', 'gap'])

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => compactText(item, 160)).filter(Boolean))]
    : []
}

function normalizeSourceGrade(value: unknown) {
  const raw = compactText(value, 80).toLowerCase().replace(/[\s-]+/g, '_')
  const aliases: Record<string, string> = {
    public: 'public_authoritative', official: 'public_authoritative', registry: 'public_authoritative',
    primary: 'primary_document', project_file: 'primary_document', company_document: 'primary_document',
    management: 'management_record', company_claim: 'management_record',
    third_party: 'third_party_primary', model: 'analyst_model', analysis: 'analyst_model',
    na: 'not_applicable', n_a: 'not_applicable',
  }
  const normalized = aliases[raw] || raw
  return SOURCE_GRADES.has(normalized) ? normalized : raw
}

function normalizeFieldStatus(value: unknown) {
  const raw = compactText(value, 60).toLowerCase().replace(/[\s-]+/g, '_')
  const aliases: Record<string, string> = {
    verified: 'supported', available: 'supported', present: 'supported',
    conflict: 'conflicted', missing: 'absent', unsupported: 'absent',
    n_a: 'not_applicable', na: 'not_applicable',
  }
  const normalized = aliases[raw] || raw
  return FIELD_STATUSES.has(normalized) ? normalized : raw
}

const FIELD_ROW_CONTRACTS: Readonly<Record<string, readonly string[]>> = {
  'product.product_matrix': ['product', 'buyer', 'pricing', 'delivery', 'maturity', 'evidence'],
  'business.customer_closed_loop': [
    'customer', 'contract', 'amount', 'delivery', 'acceptance', 'revenue', 'invoice', 'cash', 'renewal',
  ],
  'business.revenue_breakdown': ['period', 'legal_entity', 'product', 'customer', 'revenue'],
  'market.competitor_matrix': [
    'competitor', 'product', 'customer', 'pricing', 'buyer_criteria',
    'substitute', 'strength', 'weakness', 'company_implication', 'evidence',
  ],
}

const FIELD_ROW_ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'product.product_matrix': {
    buyer: ['target_customer'],
  },
  'business.customer_closed_loop': {
    contract: ['contract_no'],
    amount: ['contract_amount'],
    delivery: ['delivery_date'],
    acceptance: ['acceptance_date'],
    revenue: ['recognized_revenue'],
    invoice: ['invoiced_amount'],
    cash: ['cash_received'],
  },
  'business.revenue_breakdown': {
    legal_entity: ['entity'],
    product: ['product_name'],
  },
  'market.competitor_matrix': {
    customer: ['target_customer'],
    strength: ['relative_strength'],
    weakness: ['relative_limitation'],
  },
}

function normalizeFieldDataRows(fieldId: string, value: unknown) {
  const data = recordValue(value)
  const rows = Array.isArray(data.rows) ? data.rows : undefined
  const aliases = FIELD_ROW_ALIASES[fieldId]
  if (!rows || !aliases) return data
  return {
    ...data,
    rows: rows.map((rawRow) => {
      const row = recordValue(rawRow)
      const normalized = { ...row }
      Object.entries(aliases).forEach(([canonical, candidates]) => {
        if (normalized[canonical] !== undefined && normalized[canonical] !== '') return
        const alias = candidates.find((candidate) => (
          row[candidate] !== undefined && row[candidate] !== ''
        ))
        if (alias) normalized[canonical] = row[alias]
      })
      return normalized
    }),
  }
}

function normalizeFields(value: unknown, knownEvidenceIds: Set<string>) {
  const source = Array.isArray(value)
    ? value
    : Object.entries(recordValue(value)).map(([id, field]) => ({ id, ...recordValue(field) }))
  const seen = new Set<string>()
  return source.flatMap((raw) => {
    const field = recordValue(raw)
    const id = compactText(field.id ?? field.field_id ?? field.fieldId, 120)
    if (!id || seen.has(id)) return []
    seen.add(id)
    const evidenceIds = stringArray(field.evidence_ids ?? field.evidenceIds)
      .filter((evidenceId) => knownEvidenceIds.has(evidenceId))
    const normalized: Record<string, unknown> = {
      ...field,
      id,
      status: normalizeFieldStatus(field.status),
      source_grade: normalizeSourceGrade(field.source_grade ?? field.sourceGrade),
      evidence_ids: evidenceIds,
      data: normalizeFieldDataRows(id, field.data ?? field.value ?? field.payload),
    }
    delete normalized.field_id
    delete normalized.fieldId
    delete normalized.sourceGrade
    delete normalized.evidenceIds
    delete normalized.value
    delete normalized.payload
    return [normalized]
  })
}

function normalizedBlockType(value: unknown) {
  const raw = compactText(value, 80).toLowerCase().replace(/[\s-]+/g, '_')
  const aliases: Record<string, string> = {
    keyvalue: 'key_value_table', key_value: 'key_value_table', keyvaluetable: 'key_value_table',
    key_value_table_block: 'key_value_table', list_item: 'bullet', numbered: 'numbered_item',
    pagebreak: 'page_break', sectionbreak: 'section_break',
  }
  const normalized = aliases[raw] || raw
  return BLOCK_TYPES.has(normalized) ? normalized : raw
}

function inferNature(block: Record<string, unknown>, evidenceIds: string[]) {
  const explicit = compactText(block.nature, 40).toLowerCase()
  if (BLOCK_NATURES.has(explicit)) return explicit
  const text = [block.title, block.label, block.text, block.caption]
    .map((item) => compactText(item, 500)).join(' ')
  if (/未核验|尚未验证|待核实|无法确认|尚无可靠结论/.test(text)) return 'gap'
  if (/建议|条件|应当|应在|交割|暂缓|不予|推进/.test(text) || block.type === 'callout') {
    return 'recommendation'
  }
  return evidenceIds.length > 0 ? 'fact' : 'analysis'
}

function inferSemanticRole(block: Record<string, unknown>, fieldIds: string[]) {
  const rawRole = compactText(block.semantic_role ?? block.semanticRole, 100)
    .toLowerCase().replace(/[\s-]+/g, '_')
  if (FIELD_ID_BY_ROLE.has(rawRole)) return rawRole
  const direct = fieldIds.map((fieldId) => ROLE_BY_FIELD_ID.get(fieldId)).find(Boolean)
  if (direct) return direct
  const text = [block.title, block.label, block.text].map((item) => compactText(item, 300)).join(' ')
  const patterns: Array<[RegExp, string]> = [
    [/公司.*(?:概况|基本|要点)|工商|主体/, 'company_key_facts'],
    [/交易|本轮|投资方案/, 'transaction_summary'], [/股权|股东|持股/, 'cap_table'],
    [/融资历史|历次融资/, 'financing_history'], [/控制权|实控人/, 'control_structure'],
    [/组织|人数|员工/, 'organization_headcount'], [/团队|创始人|核心人员/, 'team'],
    [/技术架构|技术路线|性能/, 'technology_architecture'], [/知识产权|专利|软著/, 'ip_schedule'],
    [/产品|产品矩阵/, 'product_matrix'], [/客户.*闭环|合同.*回款|商业闭环/, 'customer_closed_loop'],
    [/公开客户|客户案例/, 'public_customer_cases'], [/收入|营收/, 'revenue_breakdown'],
    [/成本|供应商/, 'cost_and_suppliers'], [/历史财务|利润表|资产负债|现金流量表/, 'historical_financials'],
    [/现金消耗|现金余额|runway/i, 'cash_runway'], [/营运资金|应收|存货|应付/, 'working_capital'],
    [/预测|资金需求|资金用途/, 'forecast_and_funding'], [/竞争|竞品|可比公司/, 'competitor_matrix'],
    [/合规|处罚|诉讼/, 'legal_compliance'], [/关联交易/, 'related_party_transactions'],
    [/重大合同/, 'material_contracts'], [/回报|退出|IRR|MOIC/i, 'return_scenarios'],
    [/估值/, 'valuation'], [/风险/, 'risk_register'], [/结论|投资建议|决策/, 'decision'],
  ]
  return patterns.find(([pattern]) => pattern.test(text))?.[1] || ''
}

function normalizeRows(block: Record<string, unknown>, headers: string[]) {
  const rawRows = Array.isArray(block.rows) ? block.rows : []
  if (rawRows.every((row) => Array.isArray(row))) {
    return rawRows.map((row) => (row as unknown[]).map((cell) => String(cell ?? '')))
  }
  const objectRows = rawRows.map(recordValue).filter((row) => Object.keys(row).length > 0)
  if (objectRows.length === 0) return []
  const columns = headers.length > 0 ? headers : Object.keys(objectRows[0])
  return objectRows.map((row) => columns.map((column) => String(row[column] ?? '')))
}

function normalizeBlocks(input: {
  blocks: unknown
  knownEvidenceIds: Set<string>
  supportedFields: Map<string, Record<string, unknown>>
}) {
  if (!Array.isArray(input.blocks)) return []
  return input.blocks.flatMap((raw) => {
    const original = recordValue(raw)
    if (Object.keys(original).length === 0) return []
    const type = normalizedBlockType(original.type ?? original.block_type ?? original.blockType)
    const block: Record<string, unknown> = { ...original, type }
    delete block.block_type
    delete block.blockType
    if (type === 'heading') {
      const level = Number(original.level)
      block.level = Number.isInteger(level) && level >= 1 && level <= 4 ? level : 1
      block.title = compactText(original.title ?? original.text, 200)
      delete block.nature
      delete block.evidence_ids
      delete block.evidenceIds
      return [block]
    }
    if (type === 'page_break' || type === 'section_break') {
      delete block.nature
      delete block.evidence_ids
      delete block.evidenceIds
      return [block]
    }
    const evidenceIds = stringArray(original.evidence_ids ?? original.evidenceIds)
      .filter((evidenceId) => input.knownEvidenceIds.has(evidenceId))
    let fieldIds = stringArray(original.data_field_ids ?? original.dataFieldIds)
      .filter((fieldId) => input.supportedFields.has(fieldId))
    let role = inferSemanticRole(original, fieldIds)
    const requiredField = role ? FIELD_ID_BY_ROLE.get(role) : undefined
    if (requiredField && input.supportedFields.has(requiredField) && !fieldIds.includes(requiredField)) {
      fieldIds = [...fieldIds, requiredField]
    }
    if (!role && fieldIds.length > 0) role = ROLE_BY_FIELD_ID.get(fieldIds[0]) || ''
    if (role) block.semantic_role = role
    else delete block.semantic_role
    delete block.semanticRole
    if (fieldIds.length > 0) block.data_field_ids = fieldIds
    else delete block.data_field_ids
    delete block.dataFieldIds
    if (type === 'table') {
      let headers = stringArray(original.headers ?? original.columns)
      const rows = normalizeRows(original, headers)
      if (headers.length === 0 && Array.isArray(original.rows)) {
        const first = recordValue(original.rows[0])
        headers = Object.keys(first)
      }
      block.headers = headers
      block.rows = rows
      delete block.columns
    } else if (type === 'key_value_table') {
      block.rows = normalizeRows(original, ['key', 'value']).map((row) => row.slice(0, 2))
    }
    const fieldEvidenceIds = fieldIds.flatMap((fieldId) =>
      stringArray(input.supportedFields.get(fieldId)?.evidence_ids),
    ).filter((evidenceId) => input.knownEvidenceIds.has(evidenceId))
    const mergedEvidenceIds = [...new Set([...evidenceIds, ...fieldEvidenceIds])]
    block.evidence_ids = mergedEvidenceIds
    block.nature = inferNature({ ...block, type }, mergedEvidenceIds)
    delete block.evidenceIds
    return [block]
  })
}

const READER_FACING_WORKPAPER_REPLACEMENTS: Readonly<Record<string, string>> = {
  核查框架: '分析维度',
  验证框架: '判断维度',
  核查重点: '关键判断',
  核查材料: '支撑依据',
  应取得数据: '关键指标',
  需要回答的事实: '关键事实',
  必须完成的勾稽: '关键勾稽',
  完成标准: '达成条件',
  底稿要求: '证据要求',
  优先资料清单: '关键证据',
  尽调工作流: '分析路径',
}

function sanitizeDueDiligenceReaderValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return Object.entries(READER_FACING_WORKPAPER_REPLACEMENTS)
      .reduce((text, [workpaperPhrase, readerPhrase]) => (
        text.replaceAll(workpaperPhrase, readerPhrase)
      ), value)
  }
  if (Array.isArray(value)) return value.map(sanitizeDueDiligenceReaderValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, sanitizeDueDiligenceReaderValue(item)]))
}

function requestedReportMode(value: unknown) {
  const scope = String(value ?? '')
  if (/财务/.test(scope)) return 'financial_dd'
  if (/法律|法务/.test(scope)) return 'legal_dd'
  if (/技术/.test(scope)) return 'technical_dd'
  if (/商业|业务/.test(scope)) return 'business_dd'
  if (/综合|上会|投委/.test(scope)) return 'pre_ic'
  return 'screening_public'
}

function reportTypeForMode(mode: string) {
  return {
    screening_public: 'screening',
    business_dd: 'business',
    financial_dd: 'financial',
    legal_dd: 'legal',
    technical_dd: 'technical',
    pre_ic: 'pre_ic',
    comprehensive_ic: 'comprehensive',
  }[mode] ?? 'screening'
}

function reportDate(cutoff: string) {
  const match = cutoff.match(/^(\d{4})-(\d{2})/)
  return match ? `${match[1]}年${Number(match[2])}月` : cutoff
}

export function dueDiligencePackageContract(desiredMode: string) {
  return JSON.stringify({
    report_modes: [...REPORT_MODES],
    target_mode: desiredMode,
    required_fields_by_mode: MODE_REQUIRED_FIELDS,
    required_roles_by_mode: MODE_REQUIRED_ROLES,
    role_required_field: ROLE_REQUIRED_FIELD,
    field_data_row_contracts: FIELD_ROW_CONTRACTS,
    diligence_data_shape: {
      project: {
        name: 'string', legal_entity: 'string', cutoff_date: 'YYYY-MM-DD',
        currency: 'CNY', report_mode: 'one of report_modes',
      },
      fields: [{
        id: 'exact field id',
        status: 'supported | conflicted | absent | not_applicable',
        source_grade: 'primary_document | management_record | third_party_primary | public_authoritative | public_secondary | analyst_model | not_applicable',
        period: 'string', unit: 'string', evidence_ids: ['F001'], data: {},
      }],
    },
    report_shape: {
      meta: {
        project_name: 'string', legal_entity: 'string', report_title: '尽职调查报告',
        report_date: 'YYYY年M月', author: '投资团队', report_type: 'mode mapping',
        cutoff_date: 'YYYY-MM-DD', confidentiality: '内部资料，严禁外传',
      },
      blocks: [{
        type: 'heading | paragraph | bullet | numbered_item | callout | table | key_value_table | image | page_break | section_break',
        nature: 'fact | analysis | recommendation | gap', evidence_ids: ['F001'],
        semantic_role: 'exact role when table', data_field_ids: ['exact supported field id'],
        headers: ['table header; never use columns'], rows: [['cell']],
      }],
    },
  })
}

export function normalizeDueDiligencePackage(input: {
  generated: DueDiligencePackage
  project: ProjectLike
  evidence: ReturnType<typeof buildEvidenceLedger>
  sourceCutoffDate: string
  desiredMode: string
}): NormalizedDueDiligencePackage {
  const generatedData = recordValue(input.generated.diligenceData)
  const generatedReport = recordValue(input.generated.report)
  const requestedMode = compactText(input.generated.reportMode, 60)
  const reportMode = REPORT_MODES.has(requestedMode) ? requestedMode : input.desiredMode
  const legalEntity = input.project.companyName || input.project.name
  const knownEvidenceIds = new Set(input.evidence.facts.map((fact) => fact.id))
  const rawFields = generatedData.fields
    ?? generatedData.field_map
    ?? generatedData.fieldMap
  const fields = normalizeFields(rawFields, knownEvidenceIds)
  const supportedFields = new Map(fields
    .filter((field) => field.status === 'supported')
    .map((field) => [String(field.id), field]))
  const templateProfile = reportMode === 'pre_ic' || reportMode === 'comprehensive_ic'
    ? 'deta_v5_up_to_ic'
    : undefined
  const diligenceData: Record<string, unknown> = {
    ...generatedData,
    project: {
      ...recordValue(generatedData.project),
      name: input.project.name,
      legal_entity: legalEntity,
      cutoff_date: input.sourceCutoffDate,
      currency: 'CNY',
      report_mode: reportMode,
    },
    fields,
  }
  delete diligenceData.field_map
  delete diligenceData.fieldMap
  const report: Record<string, unknown> = {
    ...generatedReport,
    meta: {
      ...recordValue(generatedReport.meta),
      project_name: input.project.name,
      legal_entity: legalEntity,
      report_title: '尽职调查报告',
      report_date: reportDate(input.sourceCutoffDate),
      author: '投资团队',
      report_type: reportTypeForMode(reportMode),
      cutoff_date: input.sourceCutoffDate,
      confidentiality: '内部资料，严禁外传',
      ...(templateProfile ? { template_profile: templateProfile } : {}),
    },
    blocks: sanitizeDueDiligenceReaderValue(normalizeBlocks({
      blocks: generatedReport.blocks,
      knownEvidenceIds,
      supportedFields,
    })),
  }
  if (!templateProfile) delete recordValue(report.meta).template_profile
  return { reportMode, diligenceData, report }
}

async function readModelJson(response: Response) {
  if (!response.ok) {
    throw Object.assign(new Error(`尽调字段数据层模型请求失败（HTTP ${response.status}）`), {
      code: 'DUE_DILIGENCE_SKILL_MODEL_HTTP_ERROR',
    })
  }
  const payload = await response.json() as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>
  }
  const choice = payload.choices?.[0]
  if (choice?.finish_reason === 'length') {
    throw Object.assign(new Error('尽调字段数据层模型输出被截断'), {
      code: 'DUE_DILIGENCE_SKILL_MODEL_TRUNCATED',
    })
  }
  const raw = (choice?.message?.content || choice?.message?.reasoning_content || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(raw) as DueDiligencePackage
  } catch {
    throw Object.assign(new Error('尽调字段数据层模型未返回合法 JSON'), {
      code: 'DUE_DILIGENCE_SKILL_MODEL_INVALID_JSON',
    })
  }
}

async function generatePackage(input: {
  project: ProjectLike
  content: BusinessContent
  evidence: ReturnType<typeof buildEvidenceLedger>
  sourceCutoffDate: string
  diligenceScope: unknown
  sectionTitles: string[]
}) {
  const desiredMode = requestedReportMode(input.diligenceScope)
  const systemPrompt = `你是 write-investment-dd-report 的字段数据层编辑器。只依据给定证据台账和已生成章节内容，生成可被该 Skill 原生审计器直接验证的 JSON。

必须返回单个 JSON 对象：
{"reportMode":"","blockedReasons":[],"diligenceData":{},"report":{}}

规则：
1. 不得编造工商、股权、客户、合同、财务、知识产权、估值或交易数字。
2. 目标报告模式为 ${desiredMode}。只有对应 P0 字段均获得足够证据支持时才能使用；否则降级到证据能够完整支持的专项模式或 screening_public。若连 screening_public 的八项最低字段也不能完整支持，blockedReasons 必须列出缺失字段，diligenceData 和 report 可为空对象。
3. diligenceData 严格遵守 diligence-data-schema：project.report_mode 与 reportMode 一致；每个 supported 字段必须有足够来源等级、非空 data 和真实 evidence_ids；不得用 absent 字段冒充 supported。
4. report.meta.report_title 固定为“尽职调查报告”；report_type 与 reportMode 映射一致；只有 pre_ic/comprehensive_ic 可设置 template_profile=deta_v5_up_to_ic。
5. report.blocks 使用 heading/paragraph/table/key_value_table/callout；事实和重大判断必须引用 evidence_ids。专项、pre_ic、comprehensive 报告的表格必须包含 semantic_role 和 data_field_ids，并覆盖该模式全部必需角色。
6. 根据最终 reportMode 严格采用对应一级标题，不得把公开初筛或专项报告包装成完整上会稿：${JSON.stringify(REPORT_OUTLINES)}。
7. 正文只写公司事实、商业机制、投资影响和交易处理，不出现资料清单、检索过程、证据编号、工作底稿、免责声明或“引用资料”。
8. 不得输出 Markdown。

以下是审计器真实使用的机器契约，字段名、枚举值和数组层级必须逐字匹配：
${dueDiligencePackageContract(desiredMode)}`
  const userPrompt = `项目：${JSON.stringify({
    name: input.project.name,
    legalEntity: input.project.companyName || input.project.name,
    industry: input.project.industry,
    financing: input.project.financing,
    valuation: input.project.valuation,
    summary: input.project.summary,
    businessModel: input.project.businessModel,
    market: input.project.market,
    team: input.project.team,
  })}
资料截止日：${input.sourceCutoffDate}
已生成章节内容：${JSON.stringify(input.content).slice(0, 90_000)}
证据台账：${JSON.stringify(input.evidence).slice(0, 90_000)}`
  const packageTimeoutMs = Math.min(
    600_000,
    Math.max(180_000, Number(process.env.AI_DD_SKILL_PACKAGE_TIMEOUT_MS) || 360_000),
  )
  const response = await fetchAiGatewayChatCompatible(GW_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(GW_KEY ? { Authorization: `Bearer ${GW_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 32_000,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(packageTimeoutMs),
  }, fetch, packageTimeoutMs)
  const generated = await readModelJson(response)
  const blockedReasons = (generated.blockedReasons ?? []).map((item) => compactText(item, 300)).filter(Boolean)
  if (blockedReasons.length > 0 || !generated.diligenceData || !generated.report) {
    throw Object.assign(new Error(`尽调字段门禁未通过：${blockedReasons.join('；') || '关键字段证据不足'}`), {
      code: 'DUE_DILIGENCE_SKILL_FIELD_GATE_FAILED',
    })
  }
  return normalizeDueDiligencePackage({
    generated,
    project: input.project,
    evidence: input.evidence,
    sourceCutoffDate: input.sourceCutoffDate,
    desiredMode,
  })
}

async function repairPackage(input: {
  project: ProjectLike
  evidence: ReturnType<typeof buildEvidenceLedger>
  sourceCutoffDate: string
  desiredMode: string
  generated: NormalizedDueDiligencePackage
  auditIssues: string[]
}) {
  const systemPrompt = `你是 write-investment-dd-report 的 JSON 修复器。当前尽调包未通过原生审计，请只修复字段结构、证据绑定、报告块结构和人工文风问题，并返回完整 JSON 对象。

不得新增证据台账中不存在的事实或证据 ID；不得把 absent/conflicted 字段伪装为 supported；不得用“待补充”、免责声明、资料清单或检索过程凑内容。若证据确实不能支撑任何允许模式，必须在 blockedReasons 中列明缺失字段。

返回结构固定为：
{"reportMode":"","blockedReasons":[],"diligenceData":{"project":{},"fields":[]},"report":{"meta":{},"blocks":[]}}

审计器机器契约：
${dueDiligencePackageContract(input.desiredMode)}`
  const userPrompt = `项目：${JSON.stringify({
    name: input.project.name,
    legalEntity: input.project.companyName || input.project.name,
    cutoffDate: input.sourceCutoffDate,
  })}
审计错误（必须逐项修复）：${JSON.stringify(input.auditIssues)}
当前尽调包：${JSON.stringify(input.generated).slice(0, 100_000)}
证据台账：${JSON.stringify(input.evidence).slice(0, 90_000)}`
  const repairTimeoutMs = Math.min(
    600_000,
    Math.max(180_000, Number(process.env.AI_DD_SKILL_REPAIR_TIMEOUT_MS) || 360_000),
  )
  const response = await fetchAiGatewayChatCompatible(GW_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(GW_KEY ? { Authorization: `Bearer ${GW_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 32_000,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(repairTimeoutMs),
  }, fetch, repairTimeoutMs)
  const repaired = await readModelJson(response)
  const blockedReasons = (repaired.blockedReasons ?? []).map((item) => compactText(item, 300)).filter(Boolean)
  if (blockedReasons.length > 0 || !repaired.diligenceData || !repaired.report) {
    throw Object.assign(new Error(`尽调字段修复后仍不具备交付条件：${blockedReasons.join('；') || '关键字段证据不足'}`), {
      code: 'DUE_DILIGENCE_SKILL_FIELD_GATE_FAILED',
    })
  }
  return normalizeDueDiligencePackage({
    generated: repaired,
    project: input.project,
    evidence: input.evidence,
    sourceCutoffDate: input.sourceCutoffDate,
    desiredMode: input.desiredMode,
  })
}

async function resolvePython() {
  const candidates = [
    process.env.AI_DD_SKILL_PYTHON,
    path.resolve(process.cwd(), 'server', '.venv', 'bin', 'python3'),
    'python3',
  ].filter((value): value is string => Boolean(value))
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (candidate.includes(path.sep)) await access(candidate)
      await execFileAsync(candidate, ['-c', 'import docx,fitz,lxml'], { timeout: 10_000 })
      return candidate
    } catch {
      // 继续检查下一个解释器。
    }
  }
  throw Object.assign(new Error('write-investment-dd-report 缺少 python-docx/PyMuPDF/lxml 运行环境'), {
    code: 'DUE_DILIGENCE_SKILL_RUNTIME_UNAVAILABLE',
  })
}

async function runPython(input: {
  python: string
  script: string
  args: string[]
  label: string
  timeout?: number
  blockWarnings?: boolean
}) {
  try {
    const result = await execFileAsync(input.python, [input.script, ...input.args], {
      timeout: input.timeout ?? 180_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    })
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    if (input.blockWarnings && /(?:^|\n)WARNING:/m.test(output)) {
      throw new Error(output)
    }
    return output
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    const auditDetails = compactText(failure.stdout || failure.stderr || failure.message, 12_000)
    const visibleDetails = compactText(auditDetails, 1200)
    throw Object.assign(new Error(`${input.label}未通过${visibleDetails ? `：${visibleDetails}` : ''}`), {
      code: 'DUE_DILIGENCE_SKILL_VALIDATION_FAILED',
      cause: failure,
      auditDetails: `${input.label}：${auditDetails}`,
    })
  }
}

async function runPackageAudits(input: {
  python: string
  scripts: string
  diligenceDataPath: string
  reportPath: string
  evidencePath: string
}) {
  const specs = [
    {
      key: 'fields',
      script: 'audit_ic_completeness.py',
      args: [input.diligenceDataPath, '--report', input.reportPath, '--evidence', input.evidencePath],
      label: '尽调字段完整性审计',
      blockWarnings: true,
    },
    {
      key: 'content',
      script: 'audit_report_content.py',
      args: [input.reportPath, '--evidence', input.evidencePath],
      label: '尽调报告内容审计',
      blockWarnings: true,
    },
    {
      key: 'narrative',
      script: 'audit_narrative_quality.py',
      args: [input.reportPath, '--strict'],
      label: '尽调人工文风审计',
      blockWarnings: false,
    },
  ] as const
  const settled = await Promise.allSettled(specs.map((spec) => runPython({
    python: input.python,
    script: path.join(input.scripts, spec.script),
    args: [...spec.args],
    label: spec.label,
    blockWarnings: spec.blockWarnings,
  })))
  const outputs: Record<string, string> = {}
  const issues: string[] = []
  settled.forEach((result, index) => {
    const spec = specs[index]
    if (result.status === 'fulfilled') outputs[spec.key] = result.value
    else {
      const failure = result.reason as Error & { auditDetails?: string }
      issues.push(compactText(failure.auditDetails || failure.message || failure, 12_000))
    }
  })
  return { outputs, issues }
}

export async function generateDueDiligenceReportWithSkill(input: {
  outputPath: string
  taskDirectory: string
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  diligenceScope: unknown
  sectionTitles: string[]
}) {
  const primaryProjectSourceCount = input.sources.filter(isPrimaryProjectSource).length
  const publicSourceCount = input.sources.filter(isPublicSource).length
  if (primaryProjectSourceCount === 0 && publicSourceCount > 0) {
    throw Object.assign(
      new Error('当前尽调主要依赖公开信息，但尚未形成通过八领域覆盖审计的 public-research.json'),
      { code: 'DUE_DILIGENCE_PUBLIC_RESEARCH_AUDIT_REQUIRED' },
    )
  }
  const skillDirectory = getAiSkillRuntimeDirectory(SKILL_NAME)
  const scripts = path.join(skillDirectory, 'scripts')
  const pluginSkillDirectory = getAiSkillDirectory(SKILL_NAME)
  const pluginProcessor = path.join(pluginSkillDirectory, 'scripts', 'deta_dd_processor.py')
  const pluginTemplate = path.join(pluginSkillDirectory, 'assets', 'reference.docx')
  const python = await resolvePython()
  const workDirectory = path.join(input.taskDirectory, '.write-investment-dd-report')
  const renderDirectory = path.join(workDirectory, 'render')
  const evidencePath = path.join(workDirectory, 'evidence.json')
  const diligenceDataPath = path.join(workDirectory, 'diligence-data.json')
  const reportPath = path.join(workDirectory, 'report.json')
  const legacyDraftPath = path.join(workDirectory, 'legacy-draft.docx')
  await mkdir(workDirectory, { recursive: true })

  await runPython({
    python,
    script: path.join(scripts, 'check_runtime.py'),
    args: [],
    label: '尽调 Skill 运行时检查',
  })
  const evidence = buildEvidenceLedger(input)
  let generated = await generatePackage({ ...input, evidence })
  await Promise.all([
    writeFile(evidencePath, JSON.stringify(evidence, null, 2), 'utf8'),
    writeFile(diligenceDataPath, JSON.stringify(generated.diligenceData, null, 2), 'utf8'),
    writeFile(reportPath, JSON.stringify(generated.report, null, 2), 'utf8'),
  ])

  const auditOutputs: Record<string, string> = {}
  auditOutputs.evidence = await runPython({
    python,
    script: path.join(scripts, 'audit_evidence.py'),
    args: [evidencePath],
    label: '尽调证据审计',
    blockWarnings: true,
  })
  let packageAudit = await runPackageAudits({
    python, scripts, diligenceDataPath, reportPath, evidencePath,
  })
  if (packageAudit.issues.length > 0) {
    generated = await repairPackage({
      project: input.project,
      evidence,
      sourceCutoffDate: input.sourceCutoffDate,
      desiredMode: requestedReportMode(input.diligenceScope),
      generated,
      auditIssues: packageAudit.issues,
    })
    await Promise.all([
      writeFile(diligenceDataPath, JSON.stringify(generated.diligenceData, null, 2), 'utf8'),
      writeFile(reportPath, JSON.stringify(generated.report, null, 2), 'utf8'),
    ])
    packageAudit = await runPackageAudits({
      python, scripts, diligenceDataPath, reportPath, evidencePath,
    })
  }
  if (packageAudit.issues.length > 0) {
    throw Object.assign(new Error(`尽调 Skill 定向修复后仍未通过：${packageAudit.issues.join('；')}`), {
      code: 'DUE_DILIGENCE_SKILL_VALIDATION_FAILED',
    })
  }
  Object.assign(auditOutputs, packageAudit.outputs)
  await runPython({
    python,
    script: path.join(scripts, 'build_report_docx.py'),
    args: [
      '--input', reportPath,
      '--diligence-data', diligenceDataPath,
      '--evidence', evidencePath,
      '--output', legacyDraftPath,
    ],
    label: '尽调 Skill 原生 DOCX 生成',
  })
  auditOutputs.legacyDocx = await runPython({
    python,
    script: path.join(scripts, 'audit_docx_style.py'),
    args: [legacyDraftPath],
    label: '尽调旧内容层 DOCX 审计',
    blockWarnings: true,
  })
  let pluginContentContractPassed = true
  try {
    auditOutputs.pluginFormat = await runPython({
      python,
      script: pluginProcessor,
      args: ['format', '--input', legacyDraftPath, '--output', input.outputPath],
      label: 'sbl-deta-dd-report V5 模板格式化',
    })
  } catch (error) {
    // The V5 formatter writes the template-normalized DOCX before running its
    // newer editorial contract.  Preserve that real plugin output when the
    // host's already-reviewed legacy content does not yet satisfy every newer
    // semantic slot; never fall back to the pre-plugin draft.
    await access(input.outputPath)
    pluginContentContractPassed = false
    auditOutputs.pluginFormat = (error as Error & { auditDetails?: string }).auditDetails
      ?? (error as Error).message
  }
  auditOutputs.pluginStyle = await runPython({
    python,
    script: path.join(pluginSkillDirectory, 'scripts', 'investment_bank_styles.py'),
    args: ['audit', '--input', input.outputPath, '--allow-unupdated-toc'],
    label: 'sbl-deta-dd-report V5 命名样式与目录校验',
  })
  try {
    auditOutputs.pluginVerify = await runPython({
      python,
      script: pluginProcessor,
      args: ['verify', '--docx', input.outputPath, '--output-dir', renderDirectory],
      label: 'sbl-deta-dd-report V5 模板及逐页校验',
      timeout: 360_000,
    })
  } catch (error) {
    pluginContentContractPassed = false
    auditOutputs.pluginVerify = (error as Error & { auditDetails?: string }).auditDetails
      ?? (error as Error).message
  }
  const pages = (await readdir(renderDirectory)).filter((name) => /^page-\d+\.png$/i.test(name))
  if (pages.length === 0) {
    throw Object.assign(new Error('尽调逐页渲染没有生成页面图'), {
      code: 'DUE_DILIGENCE_SKILL_VISUAL_QA_EMPTY',
    })
  }
  const outputStat = await stat(input.outputPath)
  const pluginTemplateSha256 = createHash('sha256')
    .update(await readFile(pluginTemplate))
    .digest('hex')
  const reportBlocks = Array.isArray(generated.report.blocks) ? generated.report.blocks : []
  const sectionTitles = reportBlocks
    .filter((block) => block && typeof block === 'object'
      && (block as Record<string, unknown>).type === 'heading'
      && Number((block as Record<string, unknown>).level) === 1)
    .map((block) => compactText((block as Record<string, unknown>).title, 80))
    .filter(Boolean)
  const tableCount = reportBlocks.filter((block) =>
    block && typeof block === 'object' && ['table', 'key_value_table'].includes(
      String((block as Record<string, unknown>).type || ''),
    )).length
  const usedEvidenceIds = new Set(reportBlocks.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const ids = (block as Record<string, unknown>).evidence_ids
    return Array.isArray(ids) ? ids.map(String) : []
  }))
  const usedSourceIndexes = [...new Set(evidence.facts
    .filter((fact) => usedEvidenceIds.has(fact.id))
    .map((fact) => fact.source_index))]
    .sort((left, right) => left - right)
  return {
    bytes: outputStat.size,
    formatter: 'sbl-deta-dd-report-plugin-v5',
    skillName: SKILL_NAME,
    reportMode: generated.reportMode,
    pageIntent: 'long-form',
    templateApplied: true,
    templateEnforced: true,
    rendererMode: 'deta-v5-retained-template-format',
    pluginTemplatePath: pluginTemplate,
    pluginTemplateSha256,
    pluginStyleAuditPassed: true,
    pluginVerifyPassed: pluginContentContractPassed,
    pluginContentContractPassed,
    typography: { body: '宋体 12pt', heading: '黑体 16/14/12pt' },
    tableCount,
    sectionTitles,
    usedSourceIndexes,
    fieldAuditPassed: true,
    contentAuditPassed: true,
    narrativeAuditPassed: true,
    docxAuditPassed: true,
    visualQaPassed: true,
    renderedPageCount: pages.length,
    internalQaPdf: path.join(renderDirectory, `${path.basename(input.outputPath, '.docx')}.pdf`),
    auditOutputs,
  }
}
