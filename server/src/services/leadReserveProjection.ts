type JsonObject = Record<string, any>

function objectValue(value: unknown): JsonObject {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) as JsonObject } catch { return {} }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function text(value: unknown, maximum = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

function sourceDate(value: unknown): string {
  if (!value) return ''
  const raw = String(value).trim()
  if (/^\d{12,}$/.test(raw)) {
    const date = new Date(Number(raw))
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
  }
  return raw.slice(0, 32)
}

export function normalizeLeadSourceWebsite(value: unknown): string {
  const raw = text(value, 1_000)
  if (!raw) return ''
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
    return parsed.toString()
  } catch { return '' }
}

function entryIdentity(value: unknown, fields: string[]): string {
  const item = objectValue(value)
  const parts = fields.flatMap((field) => {
    const candidate = text(item[field], 500).toLocaleLowerCase('zh-CN').replace(/\s+/g, '')
    return candidate ? [`${field}:${candidate}`] : []
  })
  if (parts.length) return parts.join('|')
  return `json:${JSON.stringify(item)}`
}

/** Merge source-owned arrays without allowing an empty AI result to erase retained source facts. */
export function mergeLeadSourceEntries(existing: unknown, incoming: unknown, identityFields: string[]): JsonObject[] {
  const oldItems = Array.isArray(existing) ? existing.map(objectValue).filter((item) => Object.keys(item).length) : []
  const newItems = Array.isArray(incoming) ? incoming.map(objectValue).filter((item) => Object.keys(item).length) : []
  const merged = oldItems.map((item) => ({ ...item }))
  const positions = new Map(merged.map((item, index) => [entryIdentity(item, identityFields), index]))
  for (const item of newItems) {
    const key = entryIdentity(item, identityFields)
    const position = positions.get(key)
    if (position === undefined) {
      positions.set(key, merged.length)
      merged.push({ ...item })
      continue
    }
    const current = merged[position]
    merged[position] = Object.fromEntries(Object.entries({ ...current, ...item }).filter(([, value]) => (
      value !== undefined && value !== null && value !== ''
    )))
  }
  return merged
}

export function mergeLeadScoringWithRetainedSources(
  currentValue: unknown,
  incomingValue: unknown,
  registry: Record<string, unknown>,
  options: { preserveDataQuality?: boolean } = {},
): Record<string, unknown> {
  const current = objectValue(currentValue)
  const incoming = objectValue(incomingValue)
  const merged: Record<string, unknown> = { ...current, ...incoming, registry }

  merged.structuredTeam = mergeLeadSourceEntries(current.structuredTeam, incoming.structuredTeam, ['name'])
  merged.structuredShareholders = mergeLeadSourceEntries(
    current.structuredShareholders,
    incoming.structuredShareholders,
    ['name'],
  )
  merged.registryEvidence = mergeLeadSourceEntries(
    current.registryEvidence,
    incoming.registryEvidence,
    ['field', 'sourceUrl', 'value'],
  )
  merged.sourceLabeledProfile = {
    ...objectValue(current.sourceLabeledProfile),
    ...objectValue(incoming.sourceLabeledProfile),
  }
  merged.fundingRoundsResearched = mergeLeadSourceEntries(
    current.fundingRoundsResearched,
    incoming.fundingRoundsResearched,
    ['sourceFinancingId', 'round', 'date'],
  )
  merged.researchSources = mergeLeadSourceEntries(current.researchSources, incoming.researchSources, ['url', 'sourceUrl'])
  if (!text(incoming.officialSite, 1_000) && text(current.officialSite, 1_000)) merged.officialSite = current.officialSite
  if (!text(incoming.companyIntroduction) && text(current.companyIntroduction)) {
    merged.companyIntroduction = current.companyIntroduction
  }
  if (options.preserveDataQuality && current.dataQualityV1) merged.dataQualityV1 = current.dataQualityV1
  return merged
}

export function project36KrLeadDetail(detailValue: unknown, detailUrlValue: unknown, fallbackName = '') {
  const detail = objectValue(detailValue)
  const business = objectValue(detail.business)
  const detailUrl = text(detailUrlValue, 1_000)
  const projectName = text(detail.name || fallbackName, 128) || '未命名项目'
  const companyName = text(detail.companyName || business.name || projectName, 128)
  const introduction = text(detail.intro || detail.oneWord)
  const oneWord = text(detail.oneWord || introduction, 1_000)
  const sourceTitle = `${projectName} | 项目信息-36氪`
  const industry = Array.isArray(detail.industryList) && detail.industryList.length
    ? detail.industryList.map((item: unknown) => text(objectValue(item).name, 64)).filter(Boolean).join('、')
    : (Array.isArray(detail.tagList)
        ? detail.tagList.map((item: unknown) => text(objectValue(item).name || item, 64)).filter(Boolean).join('、')
        : '')
  const registrationStatus = text(
    business.registrationStatus || business.businessStatus || business.regStatus || business.regStatusName
      || detail.registrationStatus || detail.businessStatus || detail.regStatus,
    64,
  )
  const foundedAt = sourceDate(business.estiblishTime || detail.setupDate)
  const officialSite = normalizeLeadSourceWebsite(detail.corpWebUrl)
  const logoUrl = normalizeLeadSourceWebsite(detail.logo)
  const evidence = (field: string, value: string, quote = value) => ({
    field, value, quote, sourceUrl: detailUrl, evidenceStatus: 'source_labeled',
    note: '36氪项目页原文标注，待官方或企业来源交叉核验',
  })
  const registry = {
    companyName,
    legalRepresentative: text(business.legalPersonName, 100),
    foundedAt,
    registeredAddress: text(business.regLocation, 500),
    regLocation: text(business.regLocation, 500),
    province: text(detail.provinceName, 32),
    registrationStatus,
  }
  const registryEvidence = [
    companyName && evidence('companyName', companyName),
    foundedAt && evidence('foundedAt', foundedAt, sourceDate(business.estiblishTime || detail.setupDate)),
    registry.legalRepresentative && evidence('legalRepresentative', registry.legalRepresentative),
    registry.registeredAddress && evidence('registeredAddress', registry.registeredAddress),
    officialSite && evidence('website', officialSite, text(detail.corpWebUrl, 1_000)),
  ].filter(Boolean) as JsonObject[]
  const structuredTeam = (Array.isArray(detail.teamList) ? detail.teamList : []).flatMap((value: unknown) => {
    const member = objectValue(value)
    const name = text(member.name, 100)
    if (!name) return []
    const sourceMemberId = member.memberId === undefined || member.memberId === null ? '' : String(member.memberId).trim().slice(0, 128)
    return [{
      name,
      title: text(member.profile, 150) || '团队成员',
      background: text(member.experience, 1_000) || '36氪项目页列为团队成员，完整履历待进一步核验。',
      sourceUrl: detailUrl,
      profileUrl: normalizeLeadSourceWebsite(member.faceUrl),
      ...(sourceMemberId ? { sourceMemberId } : {}),
      evidenceStatus: 'source_labeled',
    }]
  })
  const structuredShareholders = (Array.isArray(business.shareholder) ? business.shareholder : []).flatMap((value: unknown) => {
    const shareholder = objectValue(value)
    const name = text(shareholder.name, 100)
    if (!name) return []
    return [{
      name,
      percentage: text(shareholder.percent, 64),
      percent: text(shareholder.percent, 64),
      amount: text(shareholder.amomon, 128),
      date: sourceDate(shareholder.time),
      type: '股东',
      sourceUrl: detailUrl,
      evidenceStatus: 'source_labeled',
    }]
  })
  const fundingRounds = (Array.isArray(detail.financingList) ? detail.financingList : []).map((value: unknown) => {
    const item = objectValue(value)
    const investors = Array.isArray(item.investorList)
      ? item.investorList.map((investor: unknown) => text(objectValue(investor).name, 128)).filter((name: string) => name && name !== 'null').join('、')
      : ''
    const sourceFinancingId = item.financingId === undefined || item.financingId === null
      ? '' : String(item.financingId).trim().slice(0, 128)
    return {
      round: text(item.roundTxt, 64) || '未披露',
      amount: text(item.amount, 128) || '未披露',
      valuation: '未披露',
      investors: investors || (text(item.vc, 500) !== 'null' ? text(item.vc, 500) : '') || '待核验',
      date: sourceDate(item.date),
      sourceUrl: detailUrl,
      ...(sourceFinancingId ? { sourceFinancingId } : {}),
      evidenceStatus: 'source_labeled',
    }
  })
  const sourceLabeledProfile = introduction && detailUrl ? {
    projectIntroduction: {
      value: introduction,
      quote: introduction,
      sourceUrl: detailUrl,
      sourceTitle,
      evidenceStatus: 'source_labeled',
    },
    ...(structuredTeam.length ? {
      teamIntroduction: {
        value: `36氪项目页列出${structuredTeam.map((member) => `${member.name}（${member.title}）`).join('、')}。`,
        quote: structuredTeam.map((member) => `${member.name} ${member.title}`).join('；'),
        sourceUrl: detailUrl,
        sourceTitle,
        evidenceStatus: 'source_labeled',
      },
    } : {}),
  } : {}

  return {
    detail,
    detailUrl,
    projectName,
    companyName,
    introduction,
    oneWord,
    industry,
    officialSite,
    logoUrl,
    registrationStatus,
    registry,
    registryEvidence,
    structuredTeam,
    structuredShareholders,
    fundingRounds,
    sourceLabeledProfile,
    region: text(detail.provinceName || detail.cityName || business.regLocation, 32),
    projectRound: text(objectValue(detail.currentFinancing).name, 64) || fundingRounds[0]?.round || '未披露',
  }
}
