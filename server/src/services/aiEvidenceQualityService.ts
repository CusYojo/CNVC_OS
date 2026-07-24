import { cleanCorruptedText } from './textQualityService.js'

export type EvidenceLike = {
  sourceType: string
  sourceId?: string | null
  sourceName: string
  chunkIndex?: number
  content: string
}

export type RejectedEvidence = {
  sourceName: string
  chunkIndex?: number
  reason: string
}

const PLACEHOLDER_TEXT = /^(?:待.{0,30}(?:补充|核验|确认|解析).*|项目已创建.{0,60}(?:等待上传|生成).*|暂无(?:相关)?(?:资料|数据|信息|内容)?|无可用(?:资料|数据|信息)|N\/?A|unknown|未提供)$/i
const DIAGNOSTIC_NOISE = /(?:上传测试|测试文本资料|解析验证|卡住排查|异步上传测试|大文件测试)/

function isPlaceholderLine(value: string) {
  const withoutLabel = value.replace(/^[^：:\n]{1,12}[：:]\s*/, '')
    .replace(/[。.!！?？；;]+$/, '')
    .trim()
  return PLACEHOLDER_TEXT.test(withoutLabel)
}

export function comparisonKey(value: unknown) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[【】[\]（）()《》〈〉“”‘’'"`~!！?？,，.。:：;；、\s\-—_]/g, '')
}

function characterNgrams(value: string, size = 3) {
  const normalized = comparisonKey(value)
  if (!normalized) return new Set<string>()
  if (normalized.length <= size) return new Set([normalized])
  const grams = new Set<string>()
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size))
  }
  return grams
}

export function textSimilarity(left: unknown, right: unknown) {
  const a = comparisonKey(left)
  const b = comparisonKey(right)
  if (!a || !b) return 0
  if (a === b) return 1
  if (Math.min(a.length, b.length) >= 16 && (a.includes(b) || b.includes(a))) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length)
  }
  const leftGrams = characterNgrams(a)
  const rightGrams = characterNgrams(b)
  let intersection = 0
  leftGrams.forEach((gram) => {
    if (rightGrams.has(gram)) intersection += 1
  })
  const union = leftGrams.size + rightGrams.size - intersection
  return union ? intersection / union : 0
}

export function isNearDuplicate(value: unknown, existing: readonly string[], threshold = 0.82) {
  const key = comparisonKey(value)
  if (!key) return true
  return existing.some((item) => {
    const itemKey = comparisonKey(item)
    if (!itemKey) return false
    if (key === itemKey) return true
    return textSimilarity(key, itemKey) >= threshold
  })
}

export function collapseRepeatedText(value: unknown) {
  let text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
  // 历史测试文件中存在同一句或同一短语连续复制数百次的情况。
  // 先压缩连续重复片段，再按句子去重，避免把垃圾片段送入模型。
  for (let pass = 0; pass < 4; pass += 1) {
    const collapsed = text.replace(/(.{4,120}?)(?:\1){2,}/gs, '$1')
    if (collapsed === text) break
    text = collapsed
  }
  const parts = text
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const unique: string[] = []
  for (const part of parts) {
    if (isPlaceholderLine(part)) continue
    if (isNearDuplicate(part, unique, 0.9)) continue
    unique.push(part)
  }
  return unique.join('\n').trim()
}

export function dedupeTextList(
  values: readonly unknown[],
  options: { limit?: number; against?: readonly string[]; threshold?: number } = {},
) {
  const accepted = [...(options.against ?? [])]
  const result: string[] = []
  for (const value of values) {
    const cleaned = collapseRepeatedText(value)
    if (!cleaned || isPlaceholderLine(cleaned) || DIAGNOSTIC_NOISE.test(cleaned)) continue
    if (isNearDuplicate(cleaned, accepted, options.threshold ?? 0.82)) continue
    result.push(cleaned)
    accepted.push(cleaned)
    if (result.length >= (options.limit ?? Number.POSITIVE_INFINITY)) break
  }
  return result
}

function informationScore(value: string) {
  const normalized = comparisonKey(value)
  const cjk = (value.match(/[\u3400-\u9FFF]/g) || []).length
  const digits = (value.match(/\d/g) || []).length
  const unique = new Set(normalized).size
  return cjk + digits * 1.5 + unique * 0.4
}

function evidenceGroupKey(source: EvidenceLike) {
  return `${source.sourceType}:${source.sourceId || source.sourceName}`
}

export function curateEvidenceSources<T extends EvidenceLike>(
  sources: readonly T[],
  options: { maxTotal?: number; maxPerDocument?: number } = {},
) {
  const rejected: RejectedEvidence[] = []
  const cleanedCandidates: Array<T & { content: string; _score: number; _order: number }> = []
  const seenContent: string[] = []

  sources.forEach((source, order) => {
    const quality = cleanCorruptedText(source.content)
    const collapsed = collapseRepeatedText(quality.cleaned)
    const readableCjk = (collapsed.match(/[\u3400-\u9FFF]/g) || []).length
    if (!quality.usable || !collapsed) {
      rejected.push({
        sourceName: source.sourceName,
        chunkIndex: source.chunkIndex,
        reason: '片段编码异常或无可读正文，已排除',
      })
      return
    }
    if (DIAGNOSTIC_NOISE.test(collapsed) || readableCjk < 6 || informationScore(collapsed) < 14) {
      rejected.push({
        sourceName: source.sourceName,
        chunkIndex: source.chunkIndex,
        reason: '片段属于测试、占位或低信息内容，已排除',
      })
      return
    }
    if (isNearDuplicate(collapsed, seenContent, 0.9)) {
      rejected.push({
        sourceName: source.sourceName,
        chunkIndex: source.chunkIndex,
        reason: '片段与已选证据重复，已合并',
      })
      return
    }
    if (quality.corrupted) {
      rejected.push({
        sourceName: source.sourceName,
        chunkIndex: source.chunkIndex,
        reason: '片段含损坏字符，已清除损坏部分后使用可读内容',
      })
    }
    seenContent.push(collapsed)
    cleanedCandidates.push({
      ...source,
      content: collapsed.slice(0, 4000),
      _score: informationScore(collapsed),
      _order: order,
    })
  })

  const maxTotal = options.maxTotal ?? 18
  const maxPerDocument = options.maxPerDocument ?? 3
  const byGroup = new Map<string, typeof cleanedCandidates>()
  cleanedCandidates.forEach((source) => {
    const key = evidenceGroupKey(source)
    const values = byGroup.get(key) ?? []
    values.push(source)
    byGroup.set(key, values)
  })
  const selected = [...byGroup.values()].flatMap((group) =>
    group
      .sort((left, right) => right._score - left._score || left._order - right._order)
      .slice(0, maxPerDocument))
    .sort((left, right) => {
      if (left.sourceType === 'project_record' && right.sourceType !== 'project_record') return -1
      if (right.sourceType === 'project_record' && left.sourceType !== 'project_record') return 1
      return left._order - right._order
    })
    .slice(0, maxTotal)
    .map(({ _score: _ignoredScore, _order: _ignoredOrder, ...source }) => source as T)

  return { usable: selected, rejected }
}
