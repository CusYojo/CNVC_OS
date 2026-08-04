function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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
