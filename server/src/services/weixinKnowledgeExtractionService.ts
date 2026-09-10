const MARKDOWN_NOISE = /^(?:[-*_]{3,}|```|>\s*|#{1,6}\s+|!\[[^\]]*\]\([^)]*\)\s*$|【微信文件：|【文件结束】|--\s*\d+\s+of\s+\d+\s*--)/i
const PAGE_NOISE = /^(?:.*PDF.*(?:第\s*\d+\s*页|测试文件)\s*|已关注|关注|重播|分享|赞|关闭|观看更多|更多|退出全屏|刷新|视频详情|视频加载失败，请刷新页面再试)$/i
const SIGNALS = /项目|公司|产品|技术|业务|客户|市场|团队|融资|收入|订单|试点|发布|完成|核心|优势|风险|挑战|问题|计划|建议|核验|增长|合作/

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
  const seen = new Set<string>()
  const cleanedLines = text.replace(/\r/g, '').split('\n').flatMap(raw => {
    const trimmed = raw.trim()
    if (!trimmed || MARKDOWN_NOISE.test(trimmed)) return []
    const cleaned = cleanLine(trimmed)
    return cleaned.length >= 2 && !PAGE_NOISE.test(cleaned) ? [cleaned] : []
  })
  // PDF extractors commonly inserts a newline in the middle of a sentence. Joining first
  // lets punctuation, rather than page layout, define the candidate facts.
  const joined = cleanedLines.join(' ')
    .replace(/视频加载失败[^。！？!?]*[。！？!?]?/g, ' ')
    .replace(/\s+/g, ' ')
  const candidates = joined.split(/(?<=[。！？!?；;])\s*/).map(cleanLine).filter(Boolean)
    .flatMap((sentence, index) => {
      const normalized = sentence.replace(/\s+/g, '')
      if (normalized.length < 12 || normalized.length > 260 || seen.has(normalized)) return []
      seen.add(normalized)
      const score = (SIGNALS.test(sentence) ? 4 : 0)
        + (/\d/.test(sentence) ? 2 : 0)
        + (/风险|挑战|问题|仍需|核验/.test(sentence) ? 2 : 0)
        + (sentence.length >= 24 && sentence.length <= 160 ? 1 : 0)
        + (index < 3 ? 1 : 0)
      return [{ sentence, index, score }]
    })
  const best = [...candidates].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 7)
    .sort((a, b) => a.index - b.index)
  const selected: string[] = []
  for (const item of best) {
    if (`微信收录 · ${publisher}\n${selected.join(' ')} ${item.sentence}`.length > limit) continue
    selected.push(item.sentence)
    if (selected.length >= 5) break
  }
  const digest = selected.join(' ').slice(0, limit - 20).trim() || cleanLine(joined).slice(0, limit - 20)
  return `微信收录 · ${publisher || '公众号'}\n${digest}`.slice(0, limit)
}
