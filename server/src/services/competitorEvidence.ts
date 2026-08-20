function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

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

function normalizeEvidenceText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

function occursInCorpus(corpus: string, value: string, minimumLength = 4): boolean {
  const needle = normalizeEvidenceText(value)
  return needle.length >= minimumLength && normalizeEvidenceText(corpus).includes(needle)
}

/**
 * 判断竞对依据是否仅停留在行业/赛道层面，缺乏实质竞争关系。
 * 实质竞对必须说明：具体目标客户、具体任务/场景、或具体可替代产品。
 * 仅说"同属XX行业""同为XX赛道"的不算竞对。
 */
export function isWeakCompetitorBasis(basis: unknown): boolean {
  const text = String(basis ?? '').trim()
  if (text.length < 15) return true

  // 实质竞争关系关键词：必须包含客户/订单/替代/交付/场景/争夺/对标/需求等
  const substantialPatterns = [
    /客户|用户|买方|采购/,
    /订单|签约|中标|竞标/,
    /替代|取代|替换|切换/,
    /交付|提供|供应|输出/,
    /场景|任务|用例|用途/,
    /争夺|抢占|竞争|对标|抗衡/,
    /需求|痛点|问题/,
    /产品[线型类]|方案|系统|平台/,
  ]
  const hasSubstantial = substantialPatterns.some((p) => p.test(text))
  if (!hasSubstantial) return true

  // 仅行业/赛道分类，无具体竞争维度的 → 弱
  const industryOnlyPatterns = [
    /^同属.{1,6}(行业|领域|赛道|市场|产业)[，。]?$/,
    /^均为.{1,6}(企业|公司|厂商|玩家)[，。]?$/,
    /^同在.{1,6}(行业|领域|赛道|市场)[，。]?$/,
    /^都属于.{1,10}(行业|领域|赛道)[，。]?$/,
    /^属于同一(行业|赛道|领域|市场)[，。]?$/,
  ]
  if (industryOnlyPatterns.some((p) => p.test(text))) return true

  return false
}

/**
 * 对模型抽取的竞对逐项执行证据约束。名称、证据、来源和实质竞争关系
 * 都必须能在本次输入语料中闭环，不能依靠行业常识补齐。
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
    const nameKey = normalizeEvidenceText(row.name)
    if (nameKey.length < 2 || seen.has(nameKey)) return false
    if (!row.sameUseCase || !row.sameDeliverable) return false
    if (kind === 'project' && !row.sameTargetUser) return false
    if (!Number.isFinite(row.confidence) || row.confidence < 0.8) return false
    if (isWeakCompetitorBasis(row.comparisonBasis)) return false
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

/**
 * 竞对属于高风险产品事实：必须经过工作流逐字证据校验。
 *
 * 展示规则：
 * - evidence-backed + 经过严密证据校验的 → 展示
 * - 无 verificationStatus 的历史数据 → 需要有效 comparisonBasis 才展示
 * - 显式 rejected 或 comparisonBasis 太弱（仅行业层面） → 不展示
 */
export function filterEvidenceBackedCompetitors(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value.map(recordValue).filter(Boolean) as Record<string, unknown>[] : []
  const competitors = rows.filter((row) => {
    if (row.is_self === true) return false
    // 经过完整证据校验的 → 直接通过
    if (row.verificationStatus === 'evidence-backed') return true
    // 显式被拒绝的 → 不展示
    if (row.verificationStatus === 'rejected') return false
    // 历史数据无 verificationStatus：
    // 有实质 competition basis 的保留，仅行业层面的丢弃
    const basis = row.comparisonBasis
    if (!basis || isWeakCompetitorBasis(basis)) return false
    // 历史竞对至少需要有 evidence 文本
    const evidence = String(row.evidence ?? '').trim()
    const sourceRef = String(row.sourceRef ?? '').trim()
    if (evidence.length < 10 || sourceRef.length < 2) return false
    return true
  })
  if (!competitors.length) return []
  const self = rows.find((row) => row.is_self === true)
  return self ? [self, ...competitors] : competitors
}

export function sanitizeScoringCompetitors(value: unknown): Record<string, unknown> {
  const scoring = recordValue(value) ?? {}
  return {
    ...scoring,
    competitors: filterEvidenceBackedCompetitors(scoring.competitors),
  }
}
