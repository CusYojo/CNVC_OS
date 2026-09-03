export function splitLeadIndustryTags(value: unknown, fallback = '行业待核验') {
  const source = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  const tags = source
    .split(/[，,、；;｜|]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Set(tags.length ? tags : [fallback])]
}

const PENDING_VERIFICATION_TEXT = /(?:待[^，。；\n]{0,12}核验|待核实|待确认)/
const UNDISCLOSED_PLACEHOLDER_TEXT = /^(?:未确认|未披露|暂未披露|未透露)$/

/**
 * Project-detail fields use a neutral dash for any value that still carries a
 * pending-verification qualifier. The underlying value and evidence state stay
 * unchanged; this helper is display-only.
 */
export function displayLeadDetailValue(value: unknown, fallback = '-') {
  const candidate = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value).trim()
    : ''
  const displayed = candidate && !['null', 'undefined'].includes(candidate) ? candidate : fallback
  return PENDING_VERIFICATION_TEXT.test(displayed) || UNDISCLOSED_PLACEHOLDER_TEXT.test(displayed) ? '-' : displayed
}

const INVALID_REGISTERED_ADDRESS = new Set([
  '', '高', '中', '低', '中国', '待核验', '待核实', '待确认', '未披露', '未公开', 'null', 'undefined',
])

/**
 * Pick the first useful registered address without ever rendering a confidence label,
 * country-only value or other malformed one-character fallback as a company address.
 */
export function displayLeadRegisteredAddress(...values: unknown[]) {
  for (const value of values) {
    const address = typeof value === 'string' || typeof value === 'number'
      ? String(value).normalize('NFKC').trim()
      : ''
    if (!INVALID_REGISTERED_ADDRESS.has(address) && address.length >= 6) return address
  }
  return '待核验'
}

const FUNDING_PLACEHOLDERS = /^(?:融资金额|融资轮次)?(?:待核验|待核实|待确认|未披露|暂未披露|未透露|无|不适用)?$/

export function displayLeadFundingValue(...values: unknown[]) {
  for (const value of values) {
    const candidate = typeof value === 'string' || typeof value === 'number'
      ? String(value).normalize('NFKC').trim()
      : ''
    if (candidate && !FUNDING_PLACEHOLDERS.test(candidate)) return candidate
  }
  return ''
}

export function displayLeadEvidenceStatus(value: unknown) {
  if (value === 'source_supported') return '多源已核验'
  if (value === 'conflicting') return '存在冲突'
  if (value === 'source_labeled') return '原文已标注，待交叉核验'
  return ''
}

const INVALID_INVESTOR_TEXT = /(?:观点|融资由|本轮融资|轮融资|领投方|投资方|投资机构)/

export function displayLeadInvestorNames(value: unknown) {
  const items = Array.isArray(value) ? value : []
  return [...new Set(items
    .map((item) => typeof item === 'string' ? item.normalize('NFKC').trim() : '')
    .filter((item) => item.length >= 2 && item.length <= 80 && !INVALID_INVESTOR_TEXT.test(item)))]
}

export function verifiedCompanyWebsite(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue
    try {
      const url = new URL(value)
      const hostname = url.hostname.toLocaleLowerCase()
      if (!['http:', 'https:'].includes(url.protocol)) continue
      if (/(?:^|\.)(?:mp\.weixin\.qq\.com|weixin\.qq\.com)$/.test(hostname)) continue
      return url.toString()
    } catch { /* continue */ }
  }
  return ''
}

export function isLegalCompanyName(value: unknown) {
  const name = typeof value === 'string' ? value.normalize('NFKC').trim() : ''
  return /(?:有限责任公司|股份有限公司|集团有限公司|有限公司|公司)$/.test(name)
}
