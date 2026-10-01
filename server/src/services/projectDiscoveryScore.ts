/** A display-only score: never writes back to the audited lead rating. */
export type DiscoveryScoreDimension = {
  key: 'investor' | 'funding' | 'frontier' | 'technology'
  label: string
  score: number | null
  evidence: string
  status: 'ready' | 'insufficient'
}

type ScoreInput = {
  institutions?: Array<{ name?: string; major?: boolean }> | null
  financing?: { latestAmountValue?: unknown; latestAmountCurrency?: unknown } | null
  ratingV3?: {
    schemaVersion?: unknown
    status?: unknown
    computed?: { ratingStatus?: unknown }
    detailView?: { dimensionScores?: Array<{ key?: unknown; score?: unknown; assessment?: unknown }> }
  } | null
}

const weights = { investor: 20, funding: 20, frontier: 25, technology: 35 } as const

export function fundingAmountDiscoveryScore(value: unknown, currency: unknown): number | null {
  if (currency !== 'CNY' || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  if (value >= 1_000_000_000) return 100
  if (value >= 100_000_000) return 90
  if (value >= 10_000_000) return 75
  if (value >= 1_000_000) return 60
  return 45
}

function dimension(
  key: DiscoveryScoreDimension['key'], label: string, score: number | null, evidence: string,
): DiscoveryScoreDimension {
  return {
    key, label, score,
    evidence: score === null ? '资料不足，待核验' : evidence.slice(0, 240),
    status: score === null ? 'insufficient' : 'ready',
  }
}

function ratedDimension(input: ScoreInput['ratingV3'], key: string) {
  if (input?.schemaVersion !== 'lead-rating-v3'
    || input.status === 'stale' || input.status === 'invalidated'
    || input.computed?.ratingStatus === '无法评级') return null
  const rated = input.detailView?.dimensionScores?.find((item) => item.key === key)
  const raw = rated?.score
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 10) return null
  return { score: Math.round(raw * 10), assessment: typeof rated?.assessment === 'string' ? rated.assessment : 'AI 评级结果' }
}

export function buildProjectDiscoveryScore(input: ScoreInput) {
  const majorNames = (input.institutions ?? [])
    .filter((item) => item.major === true && typeof item.name === 'string')
    .map((item) => item.name!.trim()).filter(Boolean).slice(0, 2)
  const amount = input.financing?.latestAmountValue
  const amountScore = fundingAmountDiscoveryScore(amount, input.financing?.latestAmountCurrency)
  const frontier = ratedDimension(input.ratingV3, 'industry_policy_space')
  const technology = ratedDimension(input.ratingV3, 'technology_rd')
  const dimensions = [
    dimension('investor', '投资机构知名度', majorNames.length ? 90 : null,
      majorNames.length ? `机构词典标记为重点机构：${majorNames.join('、')}` : ''),
    dimension('funding', '融资金额', amountScore,
      amountScore === null ? '' : `已结构化融资金额：人民币 ${Number(amount).toLocaleString('zh-CN')} 元；按固定金额分档`),
    dimension('frontier', '产业前沿度', frontier?.score ?? null, frontier?.assessment ?? ''),
    dimension('technology', '技术含量', technology?.score ?? null, technology?.assessment ?? ''),
  ] satisfies DiscoveryScoreDimension[]
  const ready = dimensions.filter((item) => item.score !== null)
  const sumWeight = ready.reduce((sum, item) => sum + weights[item.key], 0)
  // Without both researched dimensions a financial signal is not a credible technology-project rating.
  const overall = frontier && technology && sumWeight > 0
    ? Number((ready.reduce((sum, item) => sum + item.score! * weights[item.key], 0) / sumWeight).toFixed(1))
    : null
  return { overall, coverage: ready.length, dimensions }
}
