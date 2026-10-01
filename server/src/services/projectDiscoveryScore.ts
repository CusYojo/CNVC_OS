/** A display-only score: never writes back to the audited lead rating. */
import { lookupDiscoveryInstitutionRanking } from '../data/discoveryInstitutionRankings.js'

export type DiscoveryScoreDimension = {
  key: 'investor' | 'funding' | 'frontier' | 'technology'
  label: string
  score: number | null
  evidence: string
  sourceUrl?: string
  status: 'ready' | 'insufficient'
}

type ScoreInput = {
  investmentProfileStatus?: string | null
  institutions?: Array<{ name?: string; major?: boolean; role?: string }> | null
  hasMajorInstitution?: boolean | null
  financing?: { latestAmountValue?: unknown; latestAmountCurrency?: unknown; latestRound?: unknown } | null
  ratingV3?: {
    schemaVersion?: unknown
    status?: unknown
    computed?: { ratingStatus?: unknown }
    detailView?: { dimensionScores?: Array<{ key?: unknown; score?: unknown; assessment?: unknown }> }
  } | null
}

const weights = { investor: 20, funding: 20, frontier: 25, technology: 35 } as const

export function fundingAmountDiscoveryScore(value: unknown, currency: unknown, round: unknown): number | null {
  if (currency !== 'CNY' || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const normalizedRound = typeof round === 'string' ? round.trim().toLowerCase() : ''
  const bands = /^(种子|天使|seed|angel|pre-?a)/u.test(normalizedRound)
    ? [10_000_000, 30_000_000, 100_000_000]
    : /^a(?:轮|\+|$| round)/u.test(normalizedRound)
      ? [30_000_000, 100_000_000, 300_000_000]
      : /^[b-z](?:轮|\+|$| round)/u.test(normalizedRound)
        ? [100_000_000, 300_000_000, 1_000_000_000]
        : null
  if (!bands) return null
  if (value >= bands[2]) return 90
  if (value >= bands[1]) return 80
  if (value >= bands[0]) return 65
  return 50
}

function investorDimension(institutions: ScoreInput['institutions']): DiscoveryScoreDimension {
  const named = (institutions ?? []).filter((item) => typeof item.name === 'string' && item.name.trim())
  if (!named.length) return dimension('investor', '投资机构知名度', null, '')
  const ranked = named.map((item) => ({ item, ranking: lookupDiscoveryInstitutionRanking(item.name!) }))
    .filter((entry) => entry.ranking !== null)
    .sort((a, b) => (b.ranking!.score + (b.item.role === 'lead' ? 5 : 0)) - (a.ranking!.score + (a.item.role === 'lead' ? 5 : 0)))[0]
  if (!ranked) return dimension('investor', '投资机构知名度', 50, `已记录投资机构：${named[0].name}；未命中公开榜单，采用中性参考分`)
  const { item, ranking } = ranked
  return {
    ...dimension('investor', '投资机构知名度', Math.min(95, ranking!.score + (item.role === 'lead' ? 5 : 0)),
      `${item.name}：${ranking!.year} 投中 ${ranking!.category} TOP100 第 ${ranking!.rank} 名${item.role === 'lead' ? '；领投加 5 分' : ''}`),
    sourceUrl: ranking!.sourceUrl,
  }
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
  const investmentDataStale = input.investmentProfileStatus === 'stale'
  const amount = input.financing?.latestAmountValue
  const amountScore = investmentDataStale ? null : fundingAmountDiscoveryScore(amount, input.financing?.latestAmountCurrency, input.financing?.latestRound)
  const frontier = ratedDimension(input.ratingV3, 'industry_policy_space')
  const technology = ratedDimension(input.ratingV3, 'technology_rd')
  const dimensions = [
    investorDimension(investmentDataStale ? [] : input.institutions),
    dimension('funding', '融资金额', amountScore,
      amountScore === null ? '' : `已结构化融资金额：人民币 ${Number(amount).toLocaleString('zh-CN')} 元，${input.financing?.latestRound}；临时轮次参考档（非同赛道分位数）`),
    dimension('frontier', '产业前沿度', frontier?.score ?? null, frontier?.assessment ?? ''),
    dimension('technology', '技术含量', technology?.score ?? null, technology?.assessment ?? ''),
  ] satisfies DiscoveryScoreDimension[]
  const ready = dimensions.filter((item) => item.score !== null)
  const sumWeight = ready.reduce((sum, item) => sum + weights[item.key], 0)
  // Without both researched dimensions a financial signal is not a credible technology-project rating.
  const overall = frontier && technology && ready.length >= 3 && sumWeight > 0
    ? Number((ready.reduce((sum, item) => sum + item.score! * weights[item.key], 0) / sumWeight).toFixed(1))
    : null
  return { overall, coverage: ready.length, dimensions }
}
