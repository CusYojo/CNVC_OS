import type { BusinessContent, BusinessSection } from './aiBusinessContentService.js'
import {
  collapseRepeatedText,
  comparisonKey,
  textSimilarity,
} from './aiEvidenceQualityService.js'
import { cleanCorruptedText } from './textQualityService.js'

export type DocumentEditorialIssue = {
  code:
    | 'BROKEN_ENUMERATION'
    | 'BROKEN_LATIN_TOKEN'
    | 'DUPLICATED_SENTENCE'
    | 'FORMULAIC_CAVEAT_DENSITY'
    | 'FINANCIAL_FACT_CONFLICT'
    | 'FINANCIAL_UNIT_MISSING'
    | 'INTERNAL_WORKFLOW_LEAK'
    | 'MARKDOWN_LEAK'
    | 'RAW_TECHNICAL_DUMP'
    | 'SOURCE_LAYOUT_FRAGMENT'
  message: string
  sectionTitle?: string
}

const ENUMERATION_NUMBER = String.raw`(?:\d+|[一二三四五六七八九十]+)`
const EMPTY_ENUMERATION_TOKEN = new RegExp(
  String.raw`(?:${ENUMERATION_NUMBER}\s*[、.．]\s*[；;]|[（(]\s*${ENUMERATION_NUMBER}\s*[）)]\s*[；;])`,
  'g',
)
const BROKEN_ENUMERATION = new RegExp(EMPTY_ENUMERATION_TOKEN.source)
const MARKDOWN_DECORATION = /(?:```|\*\*|__|^\s{0,3}#{1,6}\s+)/m
const SOURCE_PAGE_HEADING_PREFIX =
  /^\s*\d{1,3}\s+\d{1,3}\s*[丨|｜]\s*[^。！？；\n]{2,30}\s+(?=\d+(?:\.\d+){1,4}\s*)/
const SOURCE_OUTLINE_PREFIX =
  /(^|[\n。！？；]\s*)\d+(?:\.\d+){1,4}\s*[、.．]?\s*(?=[\u3400-\u9fffA-Za-z])/g
const SOURCE_LAYOUT_TERMS = [
  '目录', '公司介绍', '公司概况', '核心团队', '产品及技术', '产品介绍',
  '市场预期', '融资发展', '机会与风险', '风险总结',
] as const
const SPLIT_LATIN_TOKEN =
  /(?:\b(?:A\s+I|C\s+EO|C\s+OO|C\s+TO|C\s+FO|C\s+IO|C\s+MO|G\s+PT|L\s+LM|R\s+AG|A\s+PI|S\s+DK)\b|\b\d+\s+D\b|[A-Za-z0-9]\s+[-‐‑–—]|[-‐‑–—]\s+[A-Za-z0-9])/i
const INTERNAL_WORKFLOW = /(?:OA\s*(?:流程|审批|流转)|错误编号|Reviewer|Generator|Formatter|LLM\s*Gateway)/i
const FORMULAIC_CAVEAT =
  /(?:尚未|尚不能|目前(?:仍)?(?:不能|无法)|仍需|需进一步|应进一步|后续应|后续需|有待进一步|最终取决于)/g
const FORMULAIC_OPENING =
  /^(?:总体来看|综合来看|综上所述|值得注意的是|需要指出的是|需要强调的是|不难看出|由此可见|在此背景下)[，,:：\s]*/
const MONEY_TOKEN = /(\d+(?:\.\d+)?)\s*(万|亿)?\s*元/g
const FINANCIAL_CONTEXT = /(?:估值|融资(?:计划|金额|规模|安排)?|投前|投后)/
const FINANCIAL_RECONCILIATION = /(?:不同口径|口径不一|存在差异|尚未统一|分别为|投前与投后|历史与本轮)/

function looksLikeConcatenatedSourceNavigation(value: string) {
  const termHits = SOURCE_LAYOUT_TERMS.filter((term) => value.includes(term)).length
  const directoryHits = (value.match(/目录/g) ?? []).length
  const compactNumberHits = (value.match(/(?:^|\s)0?\d{1,2}(?=\s|$)/g) ?? []).length
  return value.length >= 40
    && (directoryHits >= 2 || (directoryHits >= 1 && termHits >= 4 && compactNumberHits >= 2))
}

export function containsParsedSourceLayoutArtifact(value: unknown) {
  const text = String(value ?? '')
  const normalized = text
    .replace(/```(?:json|markdown|md)?/gi, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .trim()
  return SOURCE_PAGE_HEADING_PREFIX.test(normalized)
    || looksLikeConcatenatedSourceNavigation(normalized.replace(/\s+/g, ' '))
}

export function containsBrokenLatinTokenSpacing(value: unknown) {
  return SPLIT_LATIN_TOKEN.test(String(value ?? ''))
}

function normalizeLatinTokenSpacing(value: string) {
  return value
    .replace(/\bA\s+I\b/gi, 'AI')
    .replace(/\bC\s+EO\b/gi, 'CEO')
    .replace(/\bC\s+OO\b/gi, 'COO')
    .replace(/\bC\s+TO\b/gi, 'CTO')
    .replace(/\bC\s+FO\b/gi, 'CFO')
    .replace(/\bC\s+IO\b/gi, 'CIO')
    .replace(/\bC\s+MO\b/gi, 'CMO')
    .replace(/\bG\s+PT\b/gi, 'GPT')
    .replace(/\bL\s+LM\b/gi, 'LLM')
    .replace(/\bR\s+AG\b/gi, 'RAG')
    .replace(/\bA\s+PI\b/gi, 'API')
    .replace(/\bS\s+DK\b/gi, 'SDK')
    .replace(/\b(\d+)\s+D\b/g, '$1D')
    .replace(/([A-Za-z0-9])\s*[-‐‑–—]\s*(?=[A-Za-z0-9])/g, '$1-')
}

function stripParsedSourceLayout(value: string) {
  const lines = value
    .replace(/```(?:json|markdown|md)?/gi, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !looksLikeConcatenatedSourceNavigation(line))
  return lines
    .join('\n')
    .replace(SOURCE_PAGE_HEADING_PREFIX, '')
    .replace(SOURCE_OUTLINE_PREFIX, '$1')
}

function cleanText(value: unknown) {
  return collapseRepeatedText(cleanCorruptedText(stripParsedSourceLayout(String(value ?? ''))).cleaned)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。；：！？、])/g, '$1')
    .replace(/([，。；：！？、])\s+/g, '$1')
    .replace(/([（【])\s+/g, '$1')
    .replace(/\s+([）】])/g, '$1')
    .replace(/[；;]{2,}/g, '；')
    .replace(/[。]{2,}/g, '。')
    .trim()
}

/**
 * 修复从 PDF、PPT 或旧模板抽取后残留的空编号。编号夹在标题与正文之间时
 * 转为冒号；位于行首或句尾时直接删除，避免为了清理编号丢掉后续有效事实。
 */
function repairEmptyEnumeration(value: string) {
  const trailingEmptyEnumeration = new RegExp(
    String.raw`${EMPTY_ENUMERATION_TOKEN.source}\s*$`,
  )
  const hasTrailingEmptyEnumeration = trailingEmptyEnumeration.test(value)
  const contentBeforeTrailingEnumeration = hasTrailingEmptyEnumeration
    ? value.replace(trailingEmptyEnumeration, '').trim()
    : value
  if (
    hasTrailingEmptyEnumeration
    && contentBeforeTrailingEnumeration.length <= 24
    && !/[。！？；]/.test(contentBeforeTrailingEnumeration)
  ) {
    return ''
  }
  const repaired = value
    .replace(
      new RegExp(String.raw`([^\s。；！？：])\s*${EMPTY_ENUMERATION_TOKEN.source}\s*(?=\S)`, 'g'),
      '$1：',
    )
    .replace(new RegExp(EMPTY_ENUMERATION_TOKEN.source, 'g'), '')
    .replace(/：{2,}/g, '：')
    .trim()
  return hasTrailingEmptyEnumeration
    ? repaired.replace(/[，、,:：]\s*$/, '。')
    : repaired
}

function sentences(value: string) {
  return value
    .split(/(?<=[。！？；])|\n+/)
    .map((item) => cleanText(item))
    .filter(Boolean)
}

function editorialSimilarity(left: string, right: string) {
  const normalize = (value: string) => comparisonKey(value)
    .replace(/已经/g, '已')
    .replace(/目前/g, '当前')
  return textSimilarity(normalize(left), normalize(right))
}

function narrativeBlocks(
  content: BusinessContent,
  options: { includeSummaries?: boolean } = {},
) {
  return content.sections.flatMap((section) => [
    ...(options.includeSummaries !== false && section.summary
      ? [{ sectionTitle: section.title, text: section.summary }]
      : []),
    ...section.findings.map((finding) => ({
      sectionTitle: section.title,
      text: finding.text,
    })),
  ])
}

function moneyValue(value: string, unit: string | undefined) {
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  if (unit === '亿') return number * 100_000_000
  if (unit === '万') return number * 10_000
  return number
}

function financialConflictIssues(
  content: BusinessContent,
  options: { includeSummaries?: boolean } = {},
) {
  const claims = narrativeBlocks(content, options)
    .flatMap(({ sectionTitle, text }) => sentences(text).flatMap((sentence) => {
      if (!FINANCIAL_CONTEXT.test(sentence)) return []
      const metric = /估值|投前|投后/.test(sentence) ? '估值' : '融资金额'
      const values = [...sentence.matchAll(MONEY_TOKEN)]
        .flatMap((match) => {
          const value = moneyValue(match[1], match[2])
          return value === undefined ? [] : [value]
        })
      return values.length ? [{ sectionTitle, sentence, metric, values }] : []
    }))
  const issues: DocumentEditorialIssue[] = []
  for (const metric of ['估值', '融资金额'] as const) {
    const metricClaims = claims.filter((claim) => claim.metric === metric)
    const values = [...new Set(metricClaims.flatMap((claim) => claim.values))]
    if (values.length <= 1) continue
    const reconciled = metricClaims.some((claim) =>
      FINANCIAL_RECONCILIATION.test(claim.sentence)
      && values.every((value) => claim.values.includes(value)))
    if (!reconciled) {
      issues.push({
        code: 'FINANCIAL_FACT_CONFLICT',
        sectionTitle: metricClaims.at(-1)?.sectionTitle,
        message: `${metric}在全文存在多个数值口径，但正文未在同一处说明日期、投前/投后、报价/成交或冲突关系`,
      })
    }
  }
  return issues
}

function technicalDump(value: string) {
  const englishTokens = value.match(/[A-Za-z][A-Za-z0-9_./+-]{2,}/g) ?? []
  const englishCharacters = (value.match(/[A-Za-z]/g) ?? []).length
  const interpretation = /(?:产品|客户|交付|性能|成本|收入|壁垒|风险|投资|成熟度|验证|商业化)/
  return value.length >= 90
    && englishTokens.length >= 7
    && englishCharacters / value.length >= 0.22
    && !interpretation.test(value)
}

export function professionalizeDocumentText(value: string) {
  const cleaned = normalizeLatinTokenSpacing(repairEmptyEnumeration(cleanText(value)))
    .replace(FORMULAIC_OPENING, '')
    .replace(/通过\s*OA\s*(?:流程|审批|流转)\s*(?:提交|申请)?/gi, '提交审批')
    .replace(/\s*OA\s*(?:流程|审批|流转)/gi, '审批程序')
    .replace(/(?:阶段与推进建议|判断依据|关键风险|前置条件|下一步动作)\s*[：:]/g, '')
    .trim()
  return cleaned
}

function sanitizeSection(section: BusinessSection, seenSentences: string[]): BusinessSection {
  const filterRepeatedSentences = (value: string) => {
    const kept = sentences(professionalizeDocumentText(value)).filter((sentence) => {
      if (sentence.length < 18 || !comparisonKey(sentence)) return true
      if (seenSentences.some((existing) => editorialSimilarity(existing, sentence) >= 0.86)) return false
      seenSentences.push(sentence)
      return true
    })
    return kept.join('')
  }
  const summary = filterRepeatedSentences(section.summary)
  const findings = section.findings.flatMap((finding) => {
    const text = filterRepeatedSentences(finding.text)
    return text ? [{ ...finding, text }] : []
  })
  return {
    ...section,
    summary,
    findings,
    tables: section.tables?.map((table) => ({
      ...table,
      title: professionalizeDocumentText(table.title),
      unit: professionalizeDocumentText(table.unit),
      columns: table.columns.map(professionalizeDocumentText),
      rows: table.rows.map((row) => row.map(professionalizeDocumentText)),
    })),
  }
}

/**
 * 仅做确定性、不会引入新事实的交付前清洗。执行摘要允许概括正文，
 * 因此跨章节去重从正文开始，不拿摘要占用事实的首次出现位置。
 */
export function sanitizeBusinessContentForDelivery(
  content: BusinessContent,
  options: { sectionPriority?: string[] } = {},
): BusinessContent {
  const seenSentences: string[] = []
  const priority = new Map((options.sectionPriority ?? [])
    .map((title, index) => [title, index]))
  const sanitizedByIndex = new Map<number, BusinessSection>()
  content.sections
    .map((section, index) => ({ section, index }))
    .sort((left, right) =>
      (priority.get(left.section.title) ?? Number.MAX_SAFE_INTEGER)
      - (priority.get(right.section.title) ?? Number.MAX_SAFE_INTEGER)
      || left.index - right.index)
    .forEach(({ section, index }) => {
      sanitizedByIndex.set(index, sanitizeSection(section, seenSentences))
    })
  return {
    ...content,
    title: professionalizeDocumentText(content.title),
    executiveSummary: professionalizeDocumentText(content.executiveSummary),
    sections: content.sections.map((section, index) => sanitizedByIndex.get(index) ?? section),
    highlights: content.highlights.map(professionalizeDocumentText).filter(Boolean),
    risks: content.risks.map(professionalizeDocumentText).filter(Boolean),
    missing: content.missing.map(professionalizeDocumentText).filter(Boolean),
  }
}

export function reviewBusinessDocumentEditorialQuality(
  content: BusinessContent,
  options: { includeSummaries?: boolean; maxFormulaicCaveats?: number } = {},
): DocumentEditorialIssue[] {
  const issues: DocumentEditorialIssue[] = []
  const blocks = narrativeBlocks(content, options)
  const seen: Array<{ sectionTitle: string; sentence: string }> = []
  let caveatCount = 0
  let visibleCharacters = 0
  const caveatsBySection = new Map<string, number>()

  for (const block of blocks) {
    const rawText = String(block.text ?? '')
    const text = cleanText(rawText)
    visibleCharacters += text.length
    const blockCaveats = (text.match(FORMULAIC_CAVEAT) ?? []).length
    caveatCount += blockCaveats
    caveatsBySection.set(
      block.sectionTitle,
      (caveatsBySection.get(block.sectionTitle) ?? 0) + blockCaveats,
    )
    if (BROKEN_ENUMERATION.test(text)) {
      issues.push({
        code: 'BROKEN_ENUMERATION',
        sectionTitle: block.sectionTitle,
        message: '正文包含“1、；”一类未完成的编号或残缺条目',
      })
    }
    if (MARKDOWN_DECORATION.test(rawText)) {
      issues.push({
        code: 'MARKDOWN_LEAK',
        sectionTitle: block.sectionTitle,
        message: '正文包含 Markdown 星号、井号或代码围栏，必须在排版前清除',
      })
    }
    if (containsParsedSourceLayoutArtifact(rawText)) {
      issues.push({
        code: 'SOURCE_LAYOUT_FRAGMENT',
        sectionTitle: block.sectionTitle,
        message: '正文包含来源页码、目录或章节导航残片，不能作为项目事实交付',
      })
    }
    if (containsBrokenLatinTokenSpacing(rawText)) {
      issues.push({
        code: 'BROKEN_LATIN_TOKEN',
        sectionTitle: block.sectionTitle,
        message: '英文缩写、连字符术语或数字技术名存在异常拆分空格',
      })
    }
    if (INTERNAL_WORKFLOW.test(text)) {
      issues.push({
        code: 'INTERNAL_WORKFLOW_LEAK',
        sectionTitle: block.sectionTitle,
        message: '客户可见正文包含 OA、Reviewer、网关或错误编号等内部流程词',
      })
    }
    if (technicalDump(text)) {
      issues.push({
        code: 'RAW_TECHNICAL_DUMP',
        sectionTitle: block.sectionTitle,
        message: '技术原文或英文术语密度过高，未转化为产品能力、验证状态和投资含义',
      })
    }
    for (const sentence of sentences(text)) {
      if (sentence.length < 20) continue
      if (!comparisonKey(sentence)) continue
      const previous = seen.find((item) => editorialSimilarity(item.sentence, sentence) >= 0.86)
      if (previous && previous.sectionTitle !== block.sectionTitle) {
        issues.push({
          code: 'DUPLICATED_SENTENCE',
          sectionTitle: block.sectionTitle,
          message: `与“${previous.sectionTitle}”重复同一事实或判断：${sentence.slice(0, 56)}`,
        })
      } else if (!previous) {
        seen.push({ sectionTitle: block.sectionTitle, sentence })
      }
      if (
        /(?:估值|融资(?:金额|规模|计划)|计划融资|拟融资|本轮融资|投前|投后)/.test(sentence)
        && /\d/.test(sentence)
        && !/(?:\d+(?:\.\d+)?\s*(?:元|万元|亿元|万美?元|亿美?元|%|倍|股))/.test(sentence)
      ) {
        issues.push({
          code: 'FINANCIAL_UNIT_MISSING',
          sectionTitle: block.sectionTitle,
          message: `融资或估值数字缺少单位或明确口径：${sentence.slice(0, 70)}`,
        })
      }
    }
  }

  const caveatThreshold = options.maxFormulaicCaveats
    ?? Math.max(7, Math.ceil(visibleCharacters / 1_000) * 6)
  if (caveatCount > caveatThreshold) {
    const mostFormulaicSection = [...caveatsBySection.entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0]
    issues.push({
      code: 'FORMULAIC_CAVEAT_DENSITY',
      sectionTitle: mostFormulaicSection,
      message: `全文“尚未/仍需/进一步确认”等谨慎套句出现 ${caveatCount} 次，超过当前篇幅建议上限 ${caveatThreshold} 次`,
    })
  }
  issues.push(...financialConflictIssues(content, options))
  return issues.filter((issue, index, all) =>
    all.findIndex((candidate) =>
      candidate.code === issue.code
      && candidate.sectionTitle === issue.sectionTitle
      && candidate.message === issue.message) === index)
}
