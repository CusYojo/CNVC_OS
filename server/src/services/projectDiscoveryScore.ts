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
  summary?: string | null
  sourceUrls?: Array<string | null | undefined> | null
  industryTags?: string[] | null
  technologies?: string[] | null
  teamDescription?: string | null
  candidateInstitutions?: Array<{ name?: string }> | null
  candidateFinancing?: { status?: string; latestAmount?: string } | null
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

const priorityIndustry = /人工智能|^AI$|大模型|具身智能|机器人|半导体|芯片|集成电路|生物医药|创新药|航空航天|商业航天/u
const strategicIndustry = /先进制造|高端装备|新材料|新能源|储能|量子|低空经济|医疗器械|生物技术|生命科学/u
const specificSegment = /算力|智能体|工业软件|光刻|先进封装|第三代半导体|功率半导体|基因|细胞治疗|脑机接口|合成生物|卫星|火箭|无人机/u

function safeArticleUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.hostname ? url.href : null
  } catch {
    return null
  }
}

function provisionalReferenceScore(input: ScoreInput) {
  const sourceUrl = input.sourceUrls?.map(safeArticleUrl).find((value): value is string => Boolean(value)) ?? null
  if (!input.summary?.trim() || !sourceUrl) return { referenceScore: null, referenceSourceUrl: null, referenceEvidence: [] as string[] }

  const industryTags = (input.industryTags ?? []).filter((value) => value && value !== '其他' && value !== '待核验')
  const industryText = industryTags.join(' ')
  const evidence = ['有项目摘要及公开来源链接；原文和实体归属仍待核验']
  let score = 50
  if (priorityIndustry.test(industryText)) {
    score += 8
    evidence.push('入池行业标注涉及重点硬科技赛道（待核验） +8')
  } else if (strategicIndustry.test(industryText)) {
    score += 5
    evidence.push('入池行业标注涉及战略性新兴产业（待核验） +5')
  } else if (industryTags.length) {
    score += 2
    evidence.push('入池资料含具体行业标注（待核验） +2')
  }
  if (specificSegment.test(industryText)) {
    score += 2
    evidence.push('入池资料含明确产业细分方向（待核验） +2')
  }
  if (input.technologies?.some((value) => value.trim().length >= 4)) {
    score += 3
    evidence.push('入池资料含技术路线描述（待核验） +3')
  }
  const team = input.teamDescription ?? ''
  if (/(?:来自|毕业于|依托|联合)(?:.{0,18})(?:清华大学|北京大学|上海交通大学|复旦大学|浙江大学|中国科学技术大学|中国科学院)/u.test(team)) {
    score += 2
    evidence.push('团队资料提示重点高校或科研院所背景（待核验） +2')
  }
  if (/(?:曾任|来自|任职于).{0,20}(?:华为|中芯国际|宁德时代|比亚迪|大疆|字节跳动|腾讯|阿里巴巴)/u.test(team)) {
    score += 2
    evidence.push('团队资料提示龙头企业产业背景（待核验） +2')
  }
  const ranked = (input.candidateInstitutions ?? []).map((item) => lookupDiscoveryInstitutionRanking(item.name ?? ''))
    .filter((item) => item !== null).sort((a, b) => a!.rank - b!.rank)[0]
  if (ranked) {
    const bonus = ranked.rank <= 30 ? 5 : ranked.rank <= 50 ? 4 : 3
    score += bonus
    evidence.push(`候选投资机构命中 ${ranked.year} 投中榜 TOP100（机构关系待核验） +${bonus}`)
  }
  if (input.candidateFinancing?.status !== '候选冲突' && /^(?:人民币)?\d+(?:\.\d+)?(?:亿元|万元)(?:人民币)?$/u.test(input.candidateFinancing?.latestAmount?.trim() ?? '')) {
    score += 3
    evidence.push('入池资料含明确人民币融资金额（待核验） +3')
  }
  return { referenceScore: Math.min(score, 75), referenceSourceUrl: sourceUrl, referenceEvidence: evidence }
}

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
  return { overall, coverage: ready.length, dimensions, ...provisionalReferenceScore(input) }
}
