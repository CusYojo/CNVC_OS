import type { EvidenceSource } from './aiBusinessContentService.js'
import {
  proposalLeafSections,
  type InvestmentProposalDocumentBlueprint,
  type InvestmentProposalBlueprintSection,
} from './aiInvestmentProposalBlueprintService.js'
import { comparisonKey } from './aiEvidenceQualityService.js'

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
  evidenceScope: 'project_and_public_web'
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
  if (source.sourceType === 'user_input') return 0
  if (source.sourceType === 'project_record') return 1
  if (source.sourceType === 'public_web') return 3
  return 2
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
  const normalizedName = comparisonKey(source.sourceName)
  const normalizedContent = comparisonKey(source.content)
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
  if (source.sourceType === 'user_input' && keywordHits > 0) score += 8
  if (source.sourceType === 'project_record' && keywordHits > 0) score += 3
  if (section.tableKind && /表|财务|融资|估值|股权|预测|年度|金额|比例/.test(source.content)) {
    score += 3
  }
  if (section.analysisKind && BROAD_ANALYSIS_KINDS.has(section.analysisKind)) {
    score += Math.min(5, (source.content.match(/[。；\n]/g) || []).length)
  }
  if (/\d/.test(source.content) && /财务|融资|估值|股权|市场|回报/.test(section.evidenceKeywords.join(''))) {
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
      right.score - left.score
      || sourcePriority(left.source) - sourcePriority(right.source)
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
      content: source.content.slice(0, 2400),
    }))
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
    evidenceScope: 'project_and_public_web',
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
) {
  const bySource = new Map<number, InvestmentProposalEvidenceItem>()
  plan.sections
    .filter((section) => sectionIds.has(section.sectionId))
    .flatMap((section) => section.evidence)
    .forEach((item) => {
      const existing = bySource.get(item.sourceIndex)
      if (!existing || item.score > existing.score) bySource.set(item.sourceIndex, item)
    })
  return [...bySource.values()]
    .sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex)
    .slice(0, 18)
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
