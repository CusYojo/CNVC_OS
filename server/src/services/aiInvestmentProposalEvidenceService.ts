import type { EvidenceSource } from './aiBusinessContentService.js'
import {
  proposalLeafSections,
  type InvestmentProposalDocumentBlueprint,
  type InvestmentProposalBlueprintSection,
} from './aiInvestmentProposalBlueprintService.js'
import { comparisonKey } from './aiEvidenceQualityService.js'
import { sanitizeInvestmentProposalEvidenceContent } from './aiInvestmentProposalTextService.js'

export type InvestmentProposalEvidenceItem = {
  sourceIndex: number
  sourceName: string
  sourceType: string
  chunkIndex?: number
  versionOrDate?: string
  score: number
  content: string
}

export type InvestmentProposalSectionEvidence = {
  sectionId: string
  sectionTitle: string
  evidence: InvestmentProposalEvidenceItem[]
  sourceIndexes: number[]
  coverage: 'available' | 'missing'
}

export type InvestmentProposalEvidencePlan = {
  evidenceScope: 'project_knowledge_primary'
  sections: InvestmentProposalSectionEvidence[]
  usedSourceIndexes: number[]
  coverage: {
    totalLeafSections: number
    coveredLeafSections: number
    missingLeafSections: number
  }
}

const TEMPLATE_SOURCE_NAME = /(?:投资提案|docs[\\/].*投资提案)/i
const BROAD_ANALYSIS_KINDS = new Set([
  'investment_highlights',
  'risk_summary',
  'conclusion',
])

function sourcePriority(source: EvidenceSource) {
  if (source.sourceType !== 'project_record'
    && source.sourceType !== 'user_input'
    && !source.sourceType.startsWith('public_web')) return 0
  if (source.sourceType === 'project_record') return 1
  if (source.sourceType === 'user_input') return 2
  if (source.sourceType === 'public_web') return 3
  return 4
}

function occurrences(haystack: string, needle: string) {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset)
    if (index < 0) break
    count += 1
    offset = index + needle.length
  }
  return count
}

function evidenceScore(
  source: EvidenceSource,
  section: InvestmentProposalBlueprintSection,
) {
  const sanitizedContent = sanitizeInvestmentProposalEvidenceContent(source.content, 8000)
  const evidenceText = `${source.sourceName}\n${sanitizedContent}`
  const markerHits = (patterns: RegExp[]) =>
    patterns.reduce((count, pattern) => count + (pattern.test(evidenceText) ? 1 : 0), 0)
  const hasNumber = /\d/.test(evidenceText)
  const tableEvidenceAllowed = (() => {
    if (section.tableKind === 'equity_structure') {
      return /股东|股东名册/.test(evidenceText)
        && (
          /持股|出资|股份|股权结构|实控人|治理架构/.test(evidenceText)
          || /第[一二三四五六七八九十\d]+大股东/.test(evidenceText)
        )
    }
    if (section.tableKind === 'financial_summary') {
      return hasNumber && markerHits([
        /财务|审计|报表/,
        /收入|营收/,
        /成本|毛利/,
        /净利润|利润/,
        /现金流/,
        /资产|负债/,
      ]) >= 2
    }
    if (section.tableKind === 'financing_history') {
      return hasNumber
        && /融资|天使轮|种子轮|A轮|B轮|C轮/.test(evidenceText)
        && markerHits([
          /投资方|投资机构/,
          /融资金额|金额/,
          /投后估值|估值/,
          /交割|融资时间|融资日期/,
        ]) >= 1
    }
    if (section.tableKind === 'transaction_plan') {
      return hasNumber
        && /本轮|下一轮|融资计划|投资方案|融资规模/.test(evidenceText)
        && markerHits([
          /投资金额|融资金额|增资|老股|融资规模/,
          /投前估值|投后估值|估值/,
          /股比|持股比例/,
          /资金用途|交割条件/,
        ]) >= 1
    }
    if (section.tableKind === 'forecast_return') {
      return hasNumber
        && /预测|预算|目标|计划/.test(evidenceText)
        && markerHits([
          /收入|营收|利润/,
          /退出|回报|IRR|MOIC/,
          /估值|倍数/,
        ]) >= 2
    }
    if (section.tableKind === 'comparable_valuation') {
      return hasNumber
        && /可比|对标|同行|竞品/.test(evidenceText)
        && /估值|市值|PE|PS|EV|倍数/i.test(evidenceText)
    }
    return true
  })()
  if (!tableEvidenceAllowed) return 0
  const normalizedName = comparisonKey(source.sourceName)
  const normalizedContent = comparisonKey(sanitizedContent)
  let score = 0
  let keywordHits = 0
  section.evidenceKeywords.forEach((keyword) => {
    const normalizedKeyword = comparisonKey(keyword)
    const contentHits = occurrences(normalizedContent, normalizedKeyword)
    const nameHits = occurrences(normalizedName, normalizedKeyword)
    keywordHits += contentHits + nameHits
    score += contentHits * 4
    score += nameHits * 7
  })
  if (sourcePriority(source) === 0 && keywordHits > 0) score += 8
  if (source.sourceType === 'project_record' && keywordHits > 0) score += 3
  if (source.sourceType === 'user_input' && keywordHits > 0) score += 1
  if (section.tableKind && /表|财务|融资|估值|股权|预测|年度|金额|比例/.test(sanitizedContent)) {
    score += 3
  }
  if (section.analysisKind && BROAD_ANALYSIS_KINDS.has(section.analysisKind)) {
    score += Math.min(5, (sanitizedContent.match(/[。；\n]/g) || []).length)
  }
  if (/\d/.test(sanitizedContent) && /财务|融资|估值|股权|市场|回报/.test(section.evidenceKeywords.join(''))) {
    score += 2
  }
  return score
}

function evidenceGroupKey(source: EvidenceSource) {
  return `${source.sourceType}:${source.sourceId || source.sourceName}`
}

function selectSectionEvidence(
  sources: EvidenceSource[],
  section: InvestmentProposalBlueprintSection,
  maxItems: number,
) {
  const perDocument = new Map<string, number>()
  return sources
    .map((source, sourceIndex) => ({
      source,
      sourceIndex,
      score: evidenceScore(source, section),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) =>
      sourcePriority(left.source) - sourcePriority(right.source)
      || right.score - left.score
      || left.sourceIndex - right.sourceIndex)
    .filter(({ source }) => {
      const key = evidenceGroupKey(source)
      const selected = perDocument.get(key) ?? 0
      if (selected >= 3) return false
      perDocument.set(key, selected + 1)
      return true
    })
    .slice(0, maxItems)
    .map(({ source, sourceIndex, score }): InvestmentProposalEvidenceItem => ({
      sourceIndex,
      sourceName: source.sourceName,
      sourceType: source.sourceType,
      chunkIndex: source.chunkIndex,
      versionOrDate: source.versionOrDate,
      score,
      // 删除网页折叠态、来源元数据和转载页脚，并只在完整语义边界减载。
      // 完整原文仍保留在 sources 中，Reviewer 继续据此核验数字与引用。
      content: sanitizeInvestmentProposalEvidenceContent(source.content),
    }))
    .filter((item) => item.content)
}

export function buildInvestmentProposalEvidencePlan(
  sources: EvidenceSource[],
  blueprint: InvestmentProposalDocumentBlueprint,
  options: { maxItemsPerSection?: number } = {},
): InvestmentProposalEvidencePlan {
  const admissibleSources = sources.filter((source) =>
    source.sourceType === 'project_record'
    || !TEMPLATE_SOURCE_NAME.test(source.sourceName))
  if (admissibleSources.length !== sources.length) {
    throw Object.assign(new Error('投资提案模板文件不得进入当前项目证据集合'), {
      code: 'INVESTMENT_PROPOSAL_TEMPLATE_EVIDENCE_LEAK',
    })
  }
  const maxItems = Math.max(1, Math.min(options.maxItemsPerSection ?? 6, 10))
  const sections = proposalLeafSections(blueprint).map((section): InvestmentProposalSectionEvidence => {
    const evidence = selectSectionEvidence(admissibleSources, section, maxItems)
    return {
      sectionId: section.id,
      sectionTitle: section.title,
      evidence,
      sourceIndexes: [...new Set(evidence.map((item) => item.sourceIndex))],
      coverage: evidence.length ? 'available' : 'missing',
    }
  })
  const usedSourceIndexes = [...new Set(sections.flatMap((section) => section.sourceIndexes))]
    .sort((left, right) => left - right)
  const coveredLeafSections = sections.filter((section) => section.coverage === 'available').length
  return {
    evidenceScope: 'project_knowledge_primary',
    sections,
    usedSourceIndexes,
    coverage: {
      totalLeafSections: sections.length,
      coveredLeafSections,
      missingLeafSections: sections.length - coveredLeafSections,
    },
  }
}

export function investmentProposalEvidenceForSections(
  plan: InvestmentProposalEvidencePlan,
  sectionIds: ReadonlySet<string>,
  options: { maxItems?: number } = {},
) {
  const maxItems = Math.max(1, Math.min(options.maxItems ?? 10, 12))
  const selectedSections = plan.sections
    .filter((section) => sectionIds.has(section.sectionId))
  const bySource = new Map<number, InvestmentProposalEvidenceItem>()
  const requiredSourceIndexes = new Set<number>()

  // 每个叶子章节至少保留一条最高分证据，避免全局排序把低频章节挤出提示词。
  selectedSections.forEach((section) => {
    const first = section.evidence[0]
    if (!first) return
    requiredSourceIndexes.add(first.sourceIndex)
    const existing = bySource.get(first.sourceIndex)
    if (!existing || first.score > existing.score) bySource.set(first.sourceIndex, first)
  })
  selectedSections
    .flatMap((section) => section.evidence)
    .forEach((item) => {
      const existing = bySource.get(item.sourceIndex)
      if (!existing || item.score > existing.score) bySource.set(item.sourceIndex, item)
    })

  const ranked = [...bySource.values()]
    .sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex)
  const required = ranked.filter((item) => requiredSourceIndexes.has(item.sourceIndex))
  const supplemental = ranked.filter((item) => !requiredSourceIndexes.has(item.sourceIndex))
  return [...required, ...supplemental]
    .slice(0, Math.max(maxItems, required.length))
}

export function investmentProposalEvidencePrompt(
  evidence: InvestmentProposalEvidenceItem[],
) {
  if (!evidence.length) return '本章没有可用的当前项目证据。'
  return evidence.map((item) => [
    `[S${item.sourceIndex}] ${item.sourceName} / 来源类型：${item.sourceType} / 片段${item.chunkIndex ?? item.sourceIndex}`,
    item.versionOrDate ? `版本/日期：${item.versionOrDate}` : '',
    item.content,
  ].filter(Boolean).join('\n')).join('\n\n')
}
