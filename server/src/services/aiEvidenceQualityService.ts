import { cleanCorruptedText } from './textQualityService.js'
import { stripInvestmentProposalPageChrome } from './aiInvestmentProposalTextService.js'

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
const DIAGNOSTIC_SOURCE_NAME = /(?:^|[/\\_-])(?:local)?perf[_-]?\d|(?:大文件测试|解析测试|卡住排查|异步上传|日志测试|需求\d*复核|csv测试|pptx测试|txt测试)/i
const PUBLIC_WEB_FOOTER =
  /(?:京ICP备\d+号?|京公网安备|Copyright\s*©|All Rights Reserved|英诺嘿呀\s*版权所有|免责声明\s*使用条款\s*隐私政策)/i
const PUBLIC_WEB_CONTACT_FOOTER =
  /(?:联系我们\s*(?:北京|中国)|英诺嘿呀(?:助手微信号|邮箱|电话)|企业旗舰店\s*英诺嘿呀|小程序\s*英诺嘿呀)/i
const PUBLIC_WEB_NAVIGATION_TERMS = [
  '行情中心',
  '数据中心',
  '股吧',
  '期指',
  '期权',
  '龙虎榜',
  '新股申购',
  '基金净值',
  '板块资金',
  '公告大全',
  '个股研报',
  '融资融券',
]

export function isDiagnosticEvidenceSourceName(value: unknown) {
  return DIAGNOSTIC_SOURCE_NAME.test(String(value ?? '').trim())
}

function isPlaceholderLine(value: string) {
  const withoutLabel = value.replace(/^[^：:\n]{1,12}[：:]\s*/, '')
    .replace(/[。.!！?？；;]+$/, '')
    .trim()
  // “待……完成后再……”属于有效的条件与行动安排，不是待补充占位符。
  // 若在这里误删，结论会只剩方向而丢失下一步动作和审批边界。
  if (
    /^待/.test(withoutLabel)
    && /(?:完成后|确认后|落实后|再决定|履行|发起|提交|申请|启动)/.test(withoutLabel)
  ) return false
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

function sanitizePublicWebContent(sourceType: string, value: string) {
  if (!sourceType.startsWith('public_web')) return { content: value, navigationHeavy: false }
  const footerIndexes = [
    value.search(PUBLIC_WEB_FOOTER),
    value.search(PUBLIC_WEB_CONTACT_FOOTER),
  ].filter((index) => index >= 0)
  const footerIndex = footerIndexes.length ? Math.min(...footerIndexes) : -1
  const content = stripInvestmentProposalPageChrome(
    footerIndex >= 0 ? value.slice(0, footerIndex) : value,
  ).trim()
  const navigationHits = PUBLIC_WEB_NAVIGATION_TERMS
    .filter((term) => content.includes(term))
    .length
  return {
    content,
    navigationHeavy: navigationHits >= 6,
  }
}

function evidenceGroupKey(source: EvidenceLike) {
  return `${source.sourceType}:${source.sourceId || source.sourceName}`
}

export function curateEvidenceSources<T extends EvidenceLike>(
  sources: readonly T[],
  options: {
    maxTotal?: number
    maxPerDocument?: number
    guaranteeDocumentCoverage?: boolean
    retainAllUsable?: boolean
    preserveFullContent?: boolean
    retainEveryReadableChunk?: boolean
  } = {},
) {
  const rejected: RejectedEvidence[] = []
  const cleanedCandidates: Array<T & { content: string; _score: number; _order: number }> = []
  const seenContent: string[] = []
  const seenContentByDocument = new Map<string, string[]>()

  sources.forEach((source, order) => {
    if (isDiagnosticEvidenceSourceName(source.sourceName)) {
      rejected.push({
        sourceName: source.sourceName,
        chunkIndex: source.chunkIndex,
        reason: '来源属于性能、解析或上传诊断文件，已排除',
      })
      return
    }
    const quality = cleanCorruptedText(source.content)
    const collapsed = options.preserveFullContent && !source.sourceType.startsWith('public_web')
      ? quality.cleaned
      : collapseRepeatedText(quality.cleaned)
    const publicWeb = sanitizePublicWebContent(source.sourceType, collapsed)
    const curatedContent = publicWeb.content
    if (publicWeb.navigationHeavy) {
      rejected.push({
        sourceName: source.sourceName,
        chunkIndex: source.chunkIndex,
        reason: '公开页面主要为导航、行情或站点目录，未形成可引用的项目事实，已排除',
      })
      return
    }
    const readableCjk = (curatedContent.match(/[\u3400-\u9FFF]/g) || []).length
    const readableLatin = (curatedContent.match(/[A-Za-z]/g) || []).length
    if (!quality.usable || !curatedContent) {
      rejected.push({
        sourceName: source.sourceName,
        chunkIndex: source.chunkIndex,
        reason: '片段编码异常或无可读正文，已排除',
      })
      return
    }
    if (
      DIAGNOSTIC_NOISE.test(curatedContent)
      || (!options.retainEveryReadableChunk && (
        (readableCjk < 6 && readableLatin < 40)
        || (informationScore(curatedContent) < 14 && readableLatin < 80)
      ))
    ) {
      rejected.push({
        sourceName: source.sourceName,
        chunkIndex: source.chunkIndex,
        reason: '片段属于测试、占位或低信息内容，已排除',
      })
      return
    }
    const documentKey = evidenceGroupKey(source)
    const dedupeCorpus = options.guaranteeDocumentCoverage
      ? seenContentByDocument.get(documentKey) ?? []
      : seenContent
    if (!options.retainEveryReadableChunk && isNearDuplicate(curatedContent, dedupeCorpus, 0.9)) {
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
    dedupeCorpus.push(curatedContent)
    if (options.guaranteeDocumentCoverage) {
      seenContentByDocument.set(documentKey, dedupeCorpus)
    }
    cleanedCandidates.push({
      ...source,
      content: options.preserveFullContent ? curatedContent : curatedContent.slice(0, 4000),
      _score: informationScore(curatedContent),
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
  const priority = (sourceType: string) =>
    sourceType === 'user_input' ? 0 : sourceType === 'project_record' ? 1 : 2
  const sortByPriorityAndOrder = (
    left: typeof cleanedCandidates[number],
    right: typeof cleanedCandidates[number],
  ) => {
    const priorityDiff = priority(left.sourceType) - priority(right.sourceType)
    if (priorityDiff) return priorityDiff
    return left._order - right._order
  }
  const candidatesByGroup = [...byGroup.values()].map((group) =>
    group
      .sort((left, right) => right._score - left._score || left._order - right._order)
      .slice(0, maxPerDocument))
  const selectedCandidates = options.retainAllUsable
    ? [...cleanedCandidates].sort(sortByPriorityAndOrder)
    : options.guaranteeDocumentCoverage
    ? (() => {
        // Complete-document workflows must not let the first few large files consume
        // the global chunk budget. Reserve one readable representative for every
        // document first, then spend the remaining budget on the highest-value extras.
        const representatives = candidatesByGroup
          .flatMap((group) => group.slice(0, 1))
          .sort(sortByPriorityAndOrder)
        const extras = candidatesByGroup
          .flatMap((group) => group.slice(1))
          .sort((left, right) => right._score - left._score || sortByPriorityAndOrder(left, right))
          .slice(0, Math.max(0, maxTotal - representatives.length))
        // When the project has more documents than maxTotal, document coverage wins:
        // every document remains represented and downstream batching controls context.
        return [...representatives, ...extras].sort(sortByPriorityAndOrder)
      })()
    : candidatesByGroup
      .flat()
      .sort(sortByPriorityAndOrder)
      .slice(0, maxTotal)
  const selected = selectedCandidates
    .map(({ _score: _ignoredScore, _order: _ignoredOrder, ...source }) => source as T)

  return { usable: selected, rejected }
}
