import { createHash } from 'node:crypto'
import {
  LEAD_CUSTOMER_STAGES,
  LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION,
  LEAD_INVESTMENT_PROFILE_PROJECTION_VERSION,
  LEAD_MIN_VERIFIED_CUSTOMER_STAGE,
  leadCustomerStageRank,
  maxLeadCustomerStage,
  type LeadCustomerStage,
  type LeadCustomerTier,
  type LeadInstitutionRole,
  type LeadInvestmentProfileAcademicLink,
  type LeadInvestmentProfileCustomer,
  type LeadInvestmentProfileInstitution,
  type LeadInvestmentProfileProduct,
  type LeadInvestmentProfileMoneySummary,
  type LeadInvestmentProfileSummary,
  type LeadValuationType,
} from '../contracts/leadInvestmentProfileContract.js'

export type LeadInvestmentProfileFact = {
  id: string
  factKey: string
  instanceKey?: string | null
  value: unknown
  unit?: string | null
  currency?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  scope?: string | null
  evidenceLevel?: string | null
  verificationStatus: string
  createdAt?: string | Date | null
}

type NamedTier = { canonicalName?: string; tier?: string; type?: string; major?: boolean }

export type LeadInvestmentProfileDictionaries = {
  institutions?: Record<string, NamedTier>
  customers?: Record<string, {
    canonicalName?: string; tier?: LeadCustomerTier; confidentiality?: 'public' | 'confidential' | 'restricted';
  }>
  industries?: Record<string, {
    canonicalName?: string; level1: string; level2?: string; segment?: string; chainPosition?: string;
  }>
  academicInstitutions?: Record<string, { canonicalName: string; type?: string }>
  binding?: {
    industryHash?: string; institutionHash?: string; customerHash?: string; academicHash?: string;
  }
}

type FactGroup = Map<string, LeadInvestmentProfileFact[]>
type CustomerCandidate = LeadInvestmentProfileCustomer & { identityKey: string }

const EMPTY_TEXT = new Set(['', '-', '—', '待核验', '待核实', '未披露', '暂未披露', '无', '不适用', 'null', 'n/a'])
const CONFIDENTIAL_CUSTOMER = '某保密客户'

export function isLeadInvestmentProfileFactKey(value: unknown): boolean {
  const key = text(value)
  return /^(?:industry\.(?:level1|level2|segment|chain_position)|profile\.industry)$/.test(key)
    || /^(?:product\.(?:name|route|stage)|profile\.product|technology\.route|production\.stage)$/.test(key)
    || /^financing\.(?:status|round|date|amount|currency|investors|lead_investor|investor_role)$/.test(key)
    || /^transaction\.(?:valuation|pre_money|post_money|round|currency|date)$/.test(key)
    || /^team\.(?:institution|institution_relation|department_lab|institution_period|member|founder|cofounder)$/.test(key)
    || key === 'technology.transfer_status'
    || /^customer\.(?:name|anonymized_label|confidentiality|intent|engagement|formal|framework_agreement|pilot|trial|repurchase)$/.test(key)
    || /^(?:contract\.|order\.|delivery\.|cash_collection\.)/.test(key)
}

function text(value: unknown): string {
  const result = typeof value === 'string' || typeof value === 'number'
    ? String(value).normalize('NFKC').trim()
    : ''
  return EMPTY_TEXT.has(result.toLowerCase()) ? '' : result
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(text).filter(Boolean))]
}

function valueStrings(value: unknown): string[] {
  if (Array.isArray(value)) return unique(value.flatMap(valueStrings))
  if (value && typeof value === 'object') {
    const item = record(value)
    const preferred = ['name', 'institution', 'investor', 'customer', 'value']
      .flatMap((key) => valueStrings(item[key]))
    return preferred.length ? unique(preferred) : []
  }
  const raw = text(value)
  return raw ? unique(raw.split(/[、,，;；]/u)) : []
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
}

function stablePublicId(kind: string, value: string): string {
  return `${kind}_${createHash('sha256').update(normalizedName(value)).digest('hex').slice(0, 20)}`
}

function safeCustomerAnonymizedLabel(label: string, identities: string[]): string {
  const normalizedLabel = normalizedName(label)
  if (!normalizedLabel) return ''
  const exposesIdentity = identities.map(normalizedName).filter(Boolean).some((identity) => (
    normalizedLabel.includes(identity) || identity.includes(normalizedLabel)
  ))
  return exposesIdentity ? '' : label
}

function instanceKey(fact: LeadInvestmentProfileFact): string {
  return text(fact.instanceKey) || 'singleton'
}

function groupFacts(facts: LeadInvestmentProfileFact[]): FactGroup {
  const grouped: FactGroup = new Map()
  for (const fact of facts) {
    const key = instanceKey(fact)
    grouped.set(key, [...(grouped.get(key) ?? []), fact])
  }
  return grouped
}

function firstFact(facts: LeadInvestmentProfileFact[], ...keys: string[]) {
  for (const key of keys) {
    const fact = facts.find((candidate) => candidate.factKey === key && valueStrings(candidate.value).length)
    if (fact) return fact
  }
  return undefined
}

function firstValue(facts: LeadInvestmentProfileFact[], ...keys: string[]): string {
  const fact = firstFact(facts, ...keys)
  return fact ? valueStrings(fact.value)[0] ?? '' : ''
}

function normalizedDate(value: unknown): string {
  const raw = text(value)
  const match = raw.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:[T\s].*)?$/)
  if (!match) return ''
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return ''
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function factDate(facts: LeadInvestmentProfileFact[]): string {
  const direct = firstValue(facts, 'financing.date', 'transaction.date')
  if (direct) return normalizedDate(direct)
  for (const fact of facts) {
    const candidate = normalizedDate(fact.periodEnd || fact.periodStart)
    if (candidate) return candidate
  }
  return ''
}

function normalizedCurrency(value: unknown): string {
  const raw = text(value).toUpperCase()
  if (/美元|USD|US\$/.test(raw)) return 'USD'
  if (/港元|港币|HKD/.test(raw)) return 'HKD'
  if (/欧元|EUR/.test(raw)) return 'EUR'
  if (/人民币|CNY|RMB|万元|亿元|元/.test(raw)) return 'CNY'
  return ''
}

function currencyOf(fact: LeadInvestmentProfileFact | undefined): string {
  return normalizedCurrency(fact?.currency) || normalizedCurrency(fact?.value)
}

function numericMoney(value: unknown, declaredUnit?: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const unit = text(declaredUnit)
    return value * (/亿/.test(unit) ? 100_000_000 : /万/.test(unit) ? 10_000 : 1)
  }
  const raw = text(value).replace(/[,，\s]/g, '')
  if (/-\d/.test(raw)) return undefined
  if (/约|大约|近\d|不超过|不高于|不低于|不少于|至少|至多|以上|以下|左右|以内|起|[~～≈<>+]|about|approx(?:imately)?|morethan|lessthan|atleast|upto/i.test(raw)) return undefined
  const numericTokens = raw.match(/\d+(?:\.\d+)?/g) ?? []
  if (numericTokens.length !== 1) return undefined
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(万|亿)?/)
  if (!match) return undefined
  const base = Number(match[1])
  if (!Number.isFinite(base)) return undefined
  const unit = match[2] || text(declaredUnit)
  return base * (/亿/.test(unit) ? 100_000_000 : /万/.test(unit) ? 10_000 : 1)
}

function decimalMoneyValue(value: unknown, declaredUnit?: unknown): string | undefined {
  const raw = typeof value === 'number' ? String(value) : text(value).replace(/[,，\s]/g, '')
  if (!raw || /e[+-]?\d+/i.test(raw)) return undefined
  if (/约|大约|不超过|不低于|至少|以上|以下|左右|[~～≈<>+]|about|approx/i.test(raw)) return undefined
  const tokens = raw.match(/\d+(?:\.\d+)?/g) ?? []
  if (tokens.length !== 1) return undefined
  const unit = raw.match(/(?:万|亿)/)?.[0] || text(declaredUnit)
  const [integer, fraction = ''] = tokens[0].split('.')
  const shift = /亿/.test(unit) ? 8 : /万/.test(unit) ? 4 : 0
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, '') || '0'
  const scale = Math.max(0, fraction.length - shift)
  const shifted = shift >= fraction.length ? `${digits}${'0'.repeat(shift - fraction.length)}` : digits
  if (!scale) return shifted
  const padded = shifted.padStart(scale + 1, '0')
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

function addDecimalStrings(values: string[]): string | undefined {
  if (!values.length) return undefined
  const scale = Math.max(...values.map((value) => value.split('.')[1]?.length ?? 0))
  const total = values.reduce((sum, value) => {
    const [integer, fraction = ''] = value.split('.')
    return sum + BigInt(`${integer}${fraction.padEnd(scale, '0')}`)
  }, 0n)
  if (!scale) return total.toString()
  const padded = total.toString().padStart(scale + 1, '0')
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

function moneySummary(fact: LeadInvestmentProfileFact | undefined, fallbackCurrency = ''): LeadInvestmentProfileMoneySummary | undefined {
  if (!fact) return undefined
  const raw = text(fact.value)
  const undisclosed = !raw || /未披露|保密|undisclosed|confidential/i.test(raw)
  const unitText = text(fact.unit) || raw.match(/(?:万|亿)元/)?.[0] || ''
  const unit = /亿/.test(unitText) ? 'yi_yuan' : /万/.test(unitText) ? 'wan_yuan' : /元/.test(unitText) ? 'yuan' : 'base'
  return {
    raw: raw || undefined,
    value: undisclosed ? undefined : decimalMoneyValue(fact.value, fact.unit),
    unit,
    currency: currencyOf(fact) || fallbackCurrency || undefined,
    undisclosed,
  }
}

function moneyDisplay(fact: LeadInvestmentProfileFact | undefined): string {
  if (!fact) return ''
  const raw = text(fact.value)
  const unit = text(fact.unit)
  return raw && unit && !raw.includes(unit) ? `${raw}${unit}` : raw
}

function aggregateMoneyDisplay(value: number, currency: string): string {
  const concise = (amount: number) => String(Number(amount.toFixed(4)))
  if (currency === 'CNY') {
    if (value >= 100_000_000) return `${concise(value / 100_000_000)}亿元`
    if (value >= 10_000) return `${concise(value / 10_000)}万元`
    return `${concise(value)}元`
  }
  return `${currency} ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value)}`
}

function institutionRole(value: unknown): LeadInstitutionRole {
  const raw = text(value).toLowerCase()
  if (/领投|lead/.test(raw) && !/非领投|未领投|不是领投|not\s+(?:a\s+)?lead/.test(raw)) return 'lead'
  if (/跟投|follow/.test(raw)) return 'follow'
  if (/战略|strategic/.test(raw)) return 'strategic'
  return 'undisclosed'
}

function relationCommercialization(value: unknown): boolean {
  const raw = text(value)
  if (/尚未|未完成|未实现|无成果转化|无技术转让|计划|拟|失败|终止|not yet|not completed|no technology transfer|failed|terminated/i.test(raw)) return false
  return /成果转化|技术转让|专利许可|孵化|校办企业|commerciali[sz]ation|technology transfer/i.test(raw)
}

function productionStageStatus(value: string): LeadInvestmentProfileProduct['productionStageStatus'] {
  if (!value) return undefined
  if (/规划|计划|拟|目标|尚未|未实现|未发布|未上线|未量产|未完成|planned|planning|roadmap|not yet|not released|not launched|not in production/i.test(value)) return 'planned'
  if (/研发|实验室|验证|样机|测试|试点|PoC|中试|试生产|小批量|量产|发布|上线|停售|development|laboratory|prototype|testing|pilot|trial|production|released|launched|discontinued/i.test(value)) return 'realized'
  return 'undisclosed'
}

function customerStageForFact(fact: LeadInvestmentProfileFact): LeadCustomerStage | undefined {
  const key = fact.factKey
  const meaning = `${valueStrings(fact.value).join(' ')} ${text(fact.scope)}`.trim()
  if (key === 'customer.name' || key === 'customer.anonymized_label') return meaning ? 'L0' : undefined
  if (/^customer\.(?:intent|engagement)$/.test(key)) return /意向|接洽|交流|合作|研究|engag|intent|interested/i.test(meaning) ? 'L1' : undefined
  if (/未披露|待核验|待确认|尚未|未签|未下单|未交付|未验收|未回款|未复购|无合同|无订单|无交付|无回款|无复购|计划|拟|意向|洽谈|取消|终止|失败|不适用|not signed|not ordered|not delivered|not paid|no contract|no order|no payment|cancelled|terminated|failed/i.test(meaning)) return undefined
  if (key === 'customer.repurchase') return /复购|续购|再次采购|repeat/i.test(meaning) ? 'L5' : undefined
  if (key === 'cash_collection.status') return /已回款|到账|收款|结清|完成|paid|received|collected|settled/i.test(meaning) ? 'L5' : undefined
  if (key === 'cash_collection.amount') return (numericMoney(fact.value, fact.unit) ?? 0) > 0 ? 'L5' : undefined
  if (key === 'cash_collection.date') return normalizedDate(fact.value) ? 'L5' : undefined
  if (key === 'delivery.status') return /已交付|已验收|验收通过|交付中|完成|delivered|accepted|completed/i.test(meaning) ? 'L4' : undefined
  if (key === 'order.status') return /已下单|已确认|生效|执行中|已完成|ordered|confirmed|active|completed/i.test(meaning) ? 'L4' : undefined
  if (/^order\.(?:value|period)$/.test(key)) return /已下单|订单号|已确认|执行中|已完成|ordered|confirmed|active|completed/i.test(meaning) ? 'L4' : undefined
  if (key === 'contract.status') return /已签|签署|生效|执行中|履约|完成|有效|signed|effective|active|execut|completed/i.test(meaning) ? 'L3' : undefined
  if (/^contract\.(?:type|value|period)$/.test(key)) return /已签|签署|生效|执行中|履约|合同编号|signed|effective|active|execut/i.test(meaning) ? 'L3' : undefined
  if (key === 'customer.formal') {
    return /正式客户|已转正|签约客户|已确认|采购|合同|订单|已交付|回款|(?:^|\s)(?:true|yes|1)(?:\s|$)|formal\s+customer|converted|purchase|contract|order|delivered|paid/i.test(meaning)
      ? 'L3'
      : undefined
  }
  if (key === 'customer.framework_agreement') return /已签|签署|生效|执行中|signed|effective|active|execut/i.test(meaning) ? 'L3' : undefined
  if (/^customer\.(?:trial|pilot)$/.test(key)) return /已|启动|开展|进行|完成|试点|试用|pilot|trial/i.test(meaning) ? 'L2' : undefined
  return undefined
}

function completedFinancingEvent(status: string, round: string) {
  const combined = `${status} ${round}`
  if (/未融资|无融资|不适用|计划|拟|寻求|募资|正在|融资中|在融|进行中|交割中|尚在|尚未|未完成|待交割|待完成|意向|传闻|洽谈|预计|目标|planned|seeking|open round|ongoing|in progress|not funded|not completed|pending|rumou?r/i.test(combined)) return false
  return Boolean(round || /已完成|已融资|完成融资|交割完成|closed|completed/i.test(status))
}

function valuationType(key: string, value: unknown): LeadValuationType {
  const raw = text(value)
  if (/计划|拟|目标|预计|意向|planned|target|indicative/i.test(raw)) return 'planned'
  if (/估算|推测|推算|预测|媒体|第三方|传闻|参考|estimated|third[- ]party|reported|rumou?r/i.test(raw)) return 'estimated'
  if (key === 'transaction.pre_money') return 'pre_money'
  if (key === 'transaction.post_money') return 'post_money'
  return 'undisclosed'
}

function uniqueLatestByDate<T extends { date?: string }>(values: T[]): { value?: T; ambiguous: boolean } {
  const dates = values.map((item) => item.date).filter((date): date is string => Boolean(date))
  const latestDate = dates.sort((left, right) => right.localeCompare(left))[0]
  if (!latestDate) return { ambiguous: false }
  const candidates = values.filter((item) => item.date === latestDate)
  return candidates.length === 1 ? { value: candidates[0], ambiguous: false } : { ambiguous: true }
}

export function buildLeadInvestmentProfile(input: {
  leadId: string
  snapshotId?: string
  snapshotHash?: string
  entityType?: string
  enrichmentSchemaVersion?: string
  subject?: { name?: string; legalEntityName?: string; region?: string; profileReviewStatus?: 'clear' | 'review' }
  frozenAt?: string | Date | null
  projectedAt?: string | Date | null
  facts: LeadInvestmentProfileFact[]
  conflictCount?: number
  dictionaries?: LeadInvestmentProfileDictionaries
}): LeadInvestmentProfileSummary {
  const facts = input.facts.filter((fact) => (
    fact.verificationStatus === 'verified' && isLeadInvestmentProfileFactKey(fact.factKey)
  ))
  const sourceFactIds = unique(facts.map((fact) => fact.id))
  const byKey = new Map<string, LeadInvestmentProfileFact[]>()
  for (const fact of facts) byKey.set(fact.factKey, [...(byKey.get(fact.factKey) ?? []), fact])
  const value = (...keys: string[]) => firstValue(keys.flatMap((key) => byKey.get(key) ?? []), ...keys)

  const sourceIndustry = {
    level1: value('industry.level1') || undefined,
    level2: value('industry.level2') || undefined,
    segment: value('industry.segment', 'profile.industry') || undefined,
    chainPosition: value('industry.chain_position') || undefined,
  }
  const normalizedIndustry = [sourceIndustry.segment, sourceIndustry.level2, sourceIndustry.level1]
    .flatMap((candidate) => candidate ? [input.dictionaries?.industries?.[normalizedName(candidate)]] : [])
    .find(Boolean)
  const industry = normalizedIndustry ? {
    level1: normalizedIndustry.level1,
    level2: normalizedIndustry.level2,
    segment: normalizedIndustry.segment,
    chainPosition: normalizedIndustry.chainPosition,
  } : sourceIndustry

  const products: LeadInvestmentProfileProduct[] = [...groupFacts(facts.filter((fact) => (
    /^product\./.test(fact.factKey) || /^technology\.route$/.test(fact.factKey) || /^production\.stage$/.test(fact.factKey)
  ))).entries()].map(([productInstanceKey, group]) => {
    const productionStage = firstValue(group, 'product.stage', 'production.stage') || undefined
    return {
      instanceKey: productInstanceKey,
      name: firstValue(group, 'product.name', 'profile.product') || '未命名产品',
      productRoute: firstValue(group, 'product.route') || undefined,
      technologyRoute: firstValue(group, 'technology.route') || undefined,
      productionStage,
      productionStageStatus: productionStage ? productionStageStatus(productionStage) : undefined,
    }
  }).filter((product) => product.name !== '未命名产品' || product.productRoute || product.technologyRoute || product.productionStage)
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

  const financingGroups = groupFacts(facts.filter((fact) => /^financing\./.test(fact.factKey)))
  const financingEvents = [...financingGroups.entries()].map(([key, group]) => {
    const status = firstValue(group, 'financing.status')
    const round = firstValue(group, 'financing.round')
    const amountFact = firstFact(group, 'financing.amount')
    return {
      key,
      group,
      status,
      round,
      date: factDate(group),
      amount: moneyDisplay(amountFact),
      amountValue: numericMoney(amountFact?.value, amountFact?.unit),
      amountDecimal: decimalMoneyValue(amountFact?.value, amountFact?.unit),
      amountCurrency: currencyOf(amountFact) || normalizedCurrency(firstValue(group, 'financing.currency')),
      amountSummary: moneySummary(amountFact, normalizedCurrency(firstValue(group, 'financing.currency'))),
      completed: completedFinancingEvent(status, round),
    }
  })
  const completedEvents = financingEvents.filter((event) => event.completed)
  const latestFinancingResult = uniqueLatestByDate(completedEvents.filter((event) => event.date))
  const latestFinancing = latestFinancingResult.value
  const declaredFinancingStatus = value('financing.status')

  const institutions: LeadInvestmentProfileInstitution[] = []
  const institutionSeen = new Set<string>()
  for (const event of completedEvents) {
    const leadNames = event.group.filter((fact) => fact.factKey === 'financing.lead_investor').flatMap((fact) => valueStrings(fact.value))
    const investors = event.group.filter((fact) => fact.factKey === 'financing.investors').flatMap((fact) => valueStrings(fact.value))
    const roleFacts = event.group.filter((fact) => fact.factKey === 'financing.investor_role')
    for (const name of unique([...leadNames, ...investors])) {
      const normalized = normalizedName(name)
      if (!normalized || institutionSeen.has(`${event.key}:${normalized}`)) continue
      institutionSeen.add(`${event.key}:${normalized}`)
      const dictionary = input.dictionaries?.institutions?.[normalized]
      const explicitRole = roleFacts.find((fact) => {
        const item = record(fact.value)
        const declaredName = text(item.investor || item.name || item.institution)
        return normalizedName(declaredName || text(fact.scope)) === normalized
      })
      const explicitRoleValue = explicitRole ? text(record(explicitRole.value).role || explicitRole.value) : ''
      institutions.push({
        institutionId: stablePublicId('institution', dictionary?.canonicalName || name),
        name: dictionary?.canonicalName || name,
        round: event.round || undefined,
        role: leadNames.some((item) => normalizedName(item) === normalized) ? 'lead' : institutionRole(explicitRoleValue),
        type: dictionary?.type,
        tier: dictionary?.tier,
        major: Boolean(dictionary?.major),
      })
    }
  }

  const academicLinks: LeadInvestmentProfileAcademicLink[] = [...groupFacts(facts.filter((fact) => (
    /^team\.(?:institution|institution_relation|department_lab|institution_period|member|founder|cofounder)$/.test(fact.factKey)
    || fact.factKey === 'technology.transfer_status'
  ))).entries()].flatMap(([academicInstanceKey, group]) => {
    const institution = firstValue(group, 'team.institution')
    if (!institution) return []
    const normalizedInstitution = input.dictionaries?.academicInstitutions?.[normalizedName(institution)]
    const relationType = firstValue(group, 'team.institution_relation') || '来源确认关系'
    return [{
      instanceKey: academicInstanceKey,
      institution: normalizedInstitution?.canonicalName || institution,
      relationType,
      person: firstValue(group, 'team.member', 'team.founder', 'team.cofounder') || undefined,
      departmentLab: firstValue(group, 'team.department_lab') || undefined,
      validFrom: firstFact(group, 'team.institution_period')?.periodStart || undefined,
      validTo: firstFact(group, 'team.institution_period')?.periodEnd || undefined,
      current: /至今|当前|现任|present|current/i.test(firstValue(group, 'team.institution_period')) || undefined,
      commercialization: relationCommercialization(`${relationType} ${firstValue(group, 'technology.transfer_status')}`),
    }]
  })

  const valuationGroups = groupFacts(facts.filter((fact) => (
    /^transaction\.(?:valuation|pre_money|post_money|round|currency|date)$/.test(fact.factKey)
    || /^financing\.(?:round|date)$/.test(fact.factKey)
  )))
  const valuationEvents = [...valuationGroups.values()].flatMap((group) => {
    const valuationCandidate = ['transaction.post_money', 'transaction.pre_money', 'transaction.valuation']
      .flatMap((key) => group.filter((fact) => fact.factKey === key && valueStrings(fact.value).length))
      .map((fact) => ({ fact, type: valuationType(fact.factKey, fact.value) }))
      .find((candidate) => candidate.type !== 'planned' && candidate.type !== 'estimated')
    if (!valuationCandidate) return []
    const { fact: valuationFact, type } = valuationCandidate
    const date = factDate(group) || undefined
    const round = firstValue(group, 'transaction.round', 'financing.round') || undefined
    const completedEvent = completedEvents.find((event) => event.key === instanceKey(valuationFact))
    if (!date || !completedEvent) return []
    return [{
      value: moneyDisplay(valuationFact),
      numericValue: numericMoney(valuationFact.value, valuationFact.unit),
      amount: moneySummary(valuationFact),
      type,
      currency: currencyOf(valuationFact) || normalizedCurrency(firstValue(group, 'transaction.currency')) || undefined,
      date,
      round,
    }]
  })
  const latestValuation = uniqueLatestByDate(valuationEvents).value

  const customers: CustomerCandidate[] = [...groupFacts(facts.filter((fact) => (
    /^(?:customer\.|contract\.|order\.|delivery\.|cash_collection\.)/.test(fact.factKey)
  ))).entries()].flatMap(([groupKey, group]) => {
    let stage: LeadCustomerStage | undefined
    for (const fact of group) stage = maxLeadCustomerStage(stage, customerStageForFact(fact))
    if (!stage) return []
    const anonymizedLabel = firstValue(group, 'customer.anonymized_label')
    const explicitName = firstValue(group, 'customer.name')
      || firstValue(group, 'customer.formal', 'customer.framework_agreement', 'customer.pilot', 'customer.trial', 'customer.intent')
    const dictionary = input.dictionaries?.customers?.[normalizedName(explicitName)]
    const confidential = /保密|受限|confidential|restricted/i.test(firstValue(group, 'customer.confidentiality'))
      || Boolean(dictionary?.confidentiality && dictionary.confidentiality !== 'public')
    const canonicalName = dictionary?.canonicalName || explicitName
    const publicLabel = safeCustomerAnonymizedLabel(anonymizedLabel, [explicitName, canonicalName])
    const name = confidential ? publicLabel || CONFIDENTIAL_CUSTOMER : explicitName
    if (!name) return []
    return [{
      customerId: stablePublicId('customer', canonicalName || groupKey),
      name: confidential ? name : canonicalName,
      displayName: confidential ? name : canonicalName,
      stage,
      tier: dictionary?.tier,
      anonymized: confidential,
      identityKey: normalizedName(canonicalName) || `instance:${groupKey}`,
    }]
  }).sort((left, right) => (
    LEAD_CUSTOMER_STAGES.indexOf(right.stage) - LEAD_CUSTOMER_STAGES.indexOf(left.stage)
      || left.name.localeCompare(right.name, 'zh-CN')
  ))
  const customerKeys = new Set(customers.map((customer) => customer.identityKey))
  const dedupedCustomers = customers.filter((customer) => {
    const key = customer.identityKey
    if (!customerKeys.has(key)) return false
    customerKeys.delete(key)
    return true
  })
  const representativeNames = new Set<string>()
  const representatives = dedupedCustomers.flatMap(({ identityKey: _identityKey, ...customer }) => {
    const nameKey = normalizedName(customer.name)
    if (representativeNames.has(nameKey)) return []
    representativeNames.add(nameKey)
    return [customer]
  }).slice(0, 2)
  const highestCustomerStage = dedupedCustomers.reduce<LeadCustomerStage | undefined>(
    (highest, customer) => maxLeadCustomerStage(highest, customer.stage), undefined,
  )
  const customersAtLeast = (minimum: LeadCustomerStage) => dedupedCustomers.filter((customer) => (
    leadCustomerStageRank(customer.stage) >= leadCustomerStageRank(minimum)
  ))
  const verifiedCustomers = customersAtLeast(LEAD_MIN_VERIFIED_CUSTOMER_STAGE)

  const amountEvents = completedEvents.filter((event) => event.amountDecimal !== undefined && event.amountCurrency)
  const currencies = unique(completedEvents.map((event) => event.amountCurrency))
  const cumulativeAmountByCurrency = currencies.flatMap((currency) => {
    const currencyEvents = completedEvents.filter((event) => event.amountCurrency === currency)
    const value = addDecimalStrings(currencyEvents.flatMap((event) => event.amountDecimal ? [event.amountDecimal] : []))
    return value ? [{ currency, value, completedRoundCount: currencyEvents.length }] : []
  })
  const cumulativeValue = amountEvents.length > 0 && currencies.length === 1
    ? amountEvents.reduce((total, event) => total + (event.amountValue ?? 0), 0)
    : undefined
  const cumulativeAmount = cumulativeValue === undefined || !currencies[0]
    ? ''
    : aggregateMoneyDisplay(cumulativeValue, currencies[0])

  const dimensions = [
    Boolean(industry.level1 || industry.level2 || industry.segment || products.length),
    institutions.length > 0,
    academicLinks.length > 0,
    Boolean(completedEvents.length || declaredFinancingStatus),
    Boolean(latestValuation?.value),
    verifiedCustomers.length > 0,
  ]
  const applicableDimensions = input.entityType === 'research' ? 2 : dimensions.length
  const verifiedDimensions = input.entityType === 'research'
    ? [dimensions[0], dimensions[2]].filter(Boolean).length
    : dimensions.filter(Boolean).length
  const conflictCount = Math.max(0, input.conflictCount ?? 0)
  const status = conflictCount > 0 ? 'conflicted'
    : verifiedDimensions === 0 ? (input.entityType === 'research' ? 'missing' : 'missing')
      : verifiedDimensions >= applicableDimensions ? 'verified' : 'partial'
  const updatedAt = input.frozenAt instanceof Date ? input.frozenAt.toISOString() : text(input.frozenAt) || undefined
  const projectedAt = input.projectedAt instanceof Date ? input.projectedAt.toISOString()
    : text(input.projectedAt) || updatedAt || new Date(0).toISOString()
  const factUpdatedAt = facts.map((fact) => fact.createdAt instanceof Date ? fact.createdAt.toISOString() : text(fact.createdAt))
    .filter(Boolean).sort((left, right) => right.localeCompare(left))[0]
  const dimensionNames = ['industryProducts', 'institutions', 'academicLinks', 'financing', 'valuation', 'customers'] as const
  const dimensionStates = Object.fromEntries(dimensionNames.map((name, index) => [name,
    input.entityType === 'research' && ![0, 2].includes(index) ? 'not_applicable'
      : conflictCount > 0 ? 'conflicted' : dimensions[index] ? 'verified' : 'missing',
  ])) as LeadInvestmentProfileSummary['dataStatus']['dimensionStates']
  const orderedInstitutions = institutions.sort((left, right) => Number(right.major) - Number(left.major)
    || left.institutionId.localeCompare(right.institutionId))
  const orderedAcademicLinks = academicLinks.sort((left, right) => left.instanceKey.localeCompare(right.instanceKey))

  return {
    profileSchemaVersion: LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION,
    enrichmentSchemaVersion: input.enrichmentSchemaVersion || 'lead-enrichment-v4-investment-profile',
    projectionVersion: LEAD_INVESTMENT_PROFILE_PROJECTION_VERSION,
    dictionaryBinding: input.dictionaries?.binding ?? {},
    subject: {
      leadId: input.leadId,
      name: text(input.subject?.name),
      legalEntityName: text(input.subject?.legalEntityName) || undefined,
      subjectType: input.entityType || 'unknown',
      region: text(input.subject?.region) || undefined,
      profileReviewStatus: input.subject?.profileReviewStatus || 'clear',
    },
    schemaVersion: LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION,
    snapshotId: text(input.snapshotId) || undefined,
    snapshotHash: text(input.snapshotHash) || undefined,
    industry,
    products,
    productTotalCount: products.length,
    institutions: orderedInstitutions,
    institutionTotalCount: orderedInstitutions.length,
    academicLinks: orderedAcademicLinks,
    academicLinkTotalCount: orderedAcademicLinks.length,
    financing: {
      status: latestFinancing ? latestFinancing.status || '已完成融资'
        : latestFinancingResult.ambiguous ? '已完成融资（同日多事件待核验）'
        : completedEvents.length ? '已完成融资（日期待核验）'
          : declaredFinancingStatus || (input.entityType === 'research' ? '不适用' : ''),
      latestRound: latestFinancing?.round || undefined,
      latestRoundDate: latestFinancing?.date || undefined,
      latestAmount: latestFinancing?.amount || undefined,
      latestAmountValue: latestFinancing?.amountValue,
      latestAmountCurrency: latestFinancing?.amountCurrency || undefined,
      latestCompletedRound: latestFinancing?.round || undefined,
      latestCompletedAt: latestFinancing?.date || undefined,
      latestAmountSummary: latestFinancing?.amountSummary,
      cumulativeAmountByCurrency,
      cumulativeAmount: cumulativeAmount || undefined,
      cumulativeAmountValue: cumulativeValue,
      completedRoundCount: completedEvents.length,
    },
    valuation: latestValuation ? { ...latestValuation, asOfDate: latestValuation.date } : {},
    customers: {
      highestStage: highestCustomerStage,
      mentionedCount: customersAtLeast('L0').length,
      engagedCount: customersAtLeast('L1').length,
      trialCount: customersAtLeast('L2').length,
      contractedCount: customersAtLeast('L3').length,
      deliveredCount: customersAtLeast('L4').length,
      payingCount: customersAtLeast('L5').length,
      verifiedCustomerCount: verifiedCustomers.length,
      customerTotalCount: dedupedCustomers.length,
      verifiedCount: verifiedCustomers.length,
      tierACount: verifiedCustomers.filter((customer) => customer.tier === 'A').length,
      tierBCount: verifiedCustomers.filter((customer) => customer.tier === 'B').length,
      tierCCount: verifiedCustomers.filter((customer) => customer.tier === 'C').length,
      representatives,
    },
    dataStatus: {
      verifiedDimensions, applicableDimensions, dimensionStates, conflictCount, status,
      stale: false, factUpdatedAt, sourceFreshnessAt: factUpdatedAt,
      snapshotCreatedAt: updatedAt, projectedAt, updatedAt,
    },
    sourceFactIds,
  }
}
