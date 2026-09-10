const MARKDOWN_NOISE = /^(?:[-*_]{3,}|```|>\s*|!\[[^\]]*\]\([^)]*\)\s*$)/

export function weixinPublicSourceLink(value: string) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

function cleanLine(value: string) {
  return value
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)、]\s*/, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractWeixinKnowledgeSummary(text: string, publisher: string, limit = 500) {
  const selected: string[] = []
  const seen = new Set<string>()
  const lines = text.replace(/\r/g, '').split('\n')
  for (const raw of lines) {
    if (!raw.trim() || MARKDOWN_NOISE.test(raw.trim())) continue
    const cleaned = cleanLine(raw)
    if (cleaned.length < 8) continue
    const sentences = cleaned.split(/(?<=[。！？!?；;])\s*/).filter(Boolean)
    for (const sentence of sentences) {
      const normalized = sentence.replace(/\s+/g, '')
      if (normalized.length < 8 || seen.has(normalized)) continue
      seen.add(normalized)
      selected.push(sentence)
      if (selected.join('').length >= limit - 40 || selected.length >= 5) break
    }
    if (selected.join('').length >= limit - 40 || selected.length >= 5) break
  }
  const digest = selected.join(' ').slice(0, limit - 20).trim() || cleanLine(text).slice(0, limit - 20)
  return `微信收录 · ${publisher || '公众号'}\n${digest}`.slice(0, limit)
}
