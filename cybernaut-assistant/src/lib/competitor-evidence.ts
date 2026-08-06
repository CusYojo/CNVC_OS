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

function occursInCorpus(corpus: string, value: string, minLength = 4) {
  const needle = normalized(value)
  return needle.length >= minLength && normalized(corpus).includes(needle)
}

/**
 * 竞对属于高风险产品事实：模型只能从本次输入证据中抽取，不能凭行业常识补齐。
 * 同行业、同技术标签或同融资阶段都不足以构成竞对关系。
 */

function isWeakComparisonBasis(text: string): boolean {
  if (text.length < 15) return true
  // 仅行业/赛道分类，无具体竞争维度的 → 弱
  const industryOnly = /^(同属|均为|同在|都属于|属于同一).{1,10}(行业|领域|赛道|市场|企业|公司|厂商)[，。]?$/
  if (industryOnly.test(text)) return true
  // 必须包含实质竞争关系关键词
  return !/[客户用户买方采购订单签约中标竞标替代取代替换切换交付提供供应输出场景任务用例用途争夺抢占竞争对标抗衡需求痛点问题产品线型类方案系统平台]/.test(text)
}

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
    // comparisonBasis 必须包含实质竞争关系，不能仅是行业分类
    if (isWeakComparisonBasis(normalized(row.comparisonBasis))) return false
    if (!occursInCorpus(corpus, row.evidence) || !occursInCorpus(row.evidence, row.name, 2)) return false
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
