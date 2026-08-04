function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * 旧评分中的竞对没有项目级证据，默认不再向用户展示。
 * 新评分只有经过工作流逐字证据校验并标记 evidence-backed 的竞对可见。
 */
export function filterEvidenceBackedCompetitors(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value.map(recordValue).filter(Boolean) as Record<string, unknown>[] : []
  const competitors = rows.filter((row) => (
    row.is_self !== true
    && row.verificationStatus === 'evidence-backed'
    && typeof row.evidence === 'string'
    && row.evidence.trim().length > 0
    && typeof row.sourceRef === 'string'
    && row.sourceRef.trim().length > 0
  ))
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
