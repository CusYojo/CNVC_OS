export type CompetitorMatchType = 'self' | 'direct' | 'substitute'

export interface CompetitorEvidenceRow {
  name: string
  is_self: boolean
  tech: string
  product: string
  funding: string
  differentiation: string
  matchType: CompetitorMatchType
  sameTargetUser: boolean
  sameUseCase: boolean
  sameDeliverable: boolean
  comparisonBasis: string
  evidence: string
  sourceRef: string
  sourceUrl: string
  confidence: number
}

export interface VerifiedCompetitorEvidenceRow extends CompetitorEvidenceRow {
  [key: string]: string | boolean | number
  verificationStatus: 'self' | 'evidence-backed'
}

function normalized(value: unknown) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

function occursInCorpus(corpus: string, value: string) {
  const needle = normalized(value)
  return needle.length >= 4 && normalized(corpus).includes(needle)
}

/**
 * 竞对属于高风险产品事实：模型只能从本次输入证据中抽取，不能凭行业常识补齐。
 * 同行业、同技术标签或同融资阶段都不足以构成竞对关系。
 */
export function verifyCompetitorEvidence(
  rows: CompetitorEvidenceRow[],
  corpus: string,
  kind: 'project' | 'paper' = 'project',
): VerifiedCompetitorEvidenceRow[] {
  const self = rows.find((row) => row.is_self)
  const verifiedSelf = self ? [{ ...self, verificationStatus: 'self' as const }] : []
  const seen = new Set<string>()
  const verified = rows.filter((row) => {
    if (row.is_self || !['direct', 'substitute'].includes(row.matchType)) return false
    const nameKey = normalized(row.name)
    if (nameKey.length < 2 || seen.has(nameKey)) return false
    if (!row.sameUseCase || !row.sameDeliverable) return false
    if (kind === 'project' && !row.sameTargetUser) return false
    if (row.matchType === 'direct' && kind === 'project' && !row.sameDeliverable) return false
    if (!Number.isFinite(row.confidence) || row.confidence < 0.8) return false
    if (normalized(row.comparisonBasis).length < 8) return false
    if (!occursInCorpus(corpus, row.evidence) || !occursInCorpus(row.evidence, row.name)) return false
    if (!occursInCorpus(corpus, row.sourceRef)) return false
    if (row.sourceUrl && !corpus.includes(row.sourceUrl)) return false
    seen.add(nameKey)
    return true
  }).slice(0, 3).map((row) => ({
    ...row,
    verificationStatus: 'evidence-backed' as const,
  }))
  return [...verifiedSelf, ...verified]
}
