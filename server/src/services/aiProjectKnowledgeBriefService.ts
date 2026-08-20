import { createHash } from 'node:crypto'
import type { EvidenceSource } from './aiBusinessContentService.js'
import {
  collapseRepeatedText,
  dedupeTextList,
  isNearDuplicate,
} from './aiEvidenceQualityService.js'
import { cleanCorruptedText } from './textQualityService.js'
import { requestAiGatewayText } from './aiGatewayService.js'

type ProjectLike = {
  name: string
  companyName?: string | null
  industry?: string | null
  financing?: string | null
  valuation?: string | null
  summary?: string | null
  businessModel?: string | null
  market?: string | null
  team?: string | null
}

export const PROJECT_KNOWLEDGE_TOPICS = [
  '公司主体与历史沿革',
  '股权、融资与治理',
  '创始人与核心团队',
  '产品、技术与知识产权',
  '商业模式、客户与供应链',
  '行业、市场与竞争',
  '财务、现金流与预测',
  '交易方案、估值与退出',
  '合规、风险与待确认事项',
] as const

export type ProjectKnowledgeTopic = typeof PROJECT_KNOWLEDGE_TOPICS[number]

export type ProjectKnowledgeFact = {
  topic: ProjectKnowledgeTopic
  text: string
  sourceIndexes: number[]
  nature: '事实' | '公司陈述' | '预测或意向' | '分析判断' | '冲突或缺口'
}

export type ProjectKnowledgeChronologyItem = {
  date: string
  event: string
  sourceIndexes: number[]
}

export type ProjectKnowledgeTable = {
  topic: ProjectKnowledgeTopic
  title: string
  columns: string[]
  rows: string[][]
  sourceIndexes: number[]
}

export type ProjectKnowledgeBrief = {
  version: 'project-knowledge-study-v1'
  projectName: string
  companyName: string
  sourceCutoffDate: string
  facts: ProjectKnowledgeFact[]
  chronology: ProjectKnowledgeChronologyItem[]
  conflicts: string[]
  gaps: string[]
  recommendedTables: ProjectKnowledgeTable[]
  audit: {
    mode: 'model-study' | 'deterministic-study'
    model: string
    sourceDocumentCount: number
    sourceFilesRepresented: string[]
    selectedSourceFiles: string[]
    sourceFileCoverageRatio: number
    requiredSourceDocumentCount: number
    requiredSourceFiles: string[]
    missingRequiredSourceFiles: string[]
    requiredSourceFileCoverageRatio: number
    completeProjectFileCoverage: boolean
    sourceChunkCount: number
    includedChunkCount: number
    completeSourceChunkCoverage: boolean
    studyBatchCount: number
    includedCharacterCount: number
    corpusSha256: string
  }
}

type CorpusEntry = {
  sourceIndex: number
  source: EvidenceSource
  content: string
  score: number
}

const GW_BASE = (
  process.env.LLM_BASE_URL
  || process.env.OPENAI_BASE_URL
  || 'http://127.0.0.1:18081/v1'
).replace(/\/$/, '')
const GW_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''
const MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-6'
const STUDY_TIMEOUT_MS = Math.max(
  30_000,
  Math.min(Number(process.env.AI_PROJECT_KNOWLEDGE_STUDY_TIMEOUT_MS) || 120_000, 300_000),
)
const STUDY_BATCH_CHARACTERS = Math.max(
  12_000,
  Math.min(Number(process.env.AI_PROJECT_KNOWLEDGE_BATCH_CHARACTERS) || 42_000, 80_000),
)
const STUDY_BATCH_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.AI_PROJECT_KNOWLEDGE_BATCH_CONCURRENCY) || 2, 4),
)
const INTERNAL_STAGE_LANGUAGE =
  /线索阶段|处于线索|进入初筛|申请立项|启动尽调|提请上会|提交投决|继续跟踪|暂缓推进|归档建议|项目阶段(?:为|是|：|:)?\s*线索/
const FACT_SIGNAL =
  /公司|成立|注册|股东|持股|实控人|融资|估值|创始人|团队|产品|技术|专利|软著|客户|合同|订单|交付|验收|回款|收入|成本|毛利|利润|现金流|市场|竞品|交易|投资|合规|诉讼|处罚|风险/
const NUMBER_SIGNAL = /\d{4}[年./-]|\d+(?:[.,]\d+)*(?:%|％|万|万元|亿|亿元|人|家|项|轮|月|年)/

function safeText(value: unknown, limit = 360) {
  return cleanCorruptedText(String(value ?? '')).text
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit)
}

function clientSafeFactText(value: unknown, limit = 420) {
  const text = safeText(value, limit)
    .replace(/(?:当前|现阶段)?(?:项目)?(?:处于)?线索阶段/g, '')
    .replace(/(?:建议)?(?:进入初筛|申请立项|启动尽调|提请上会|提交投决|继续跟踪|暂缓推进|归档)/g, '')
    .replace(/项目阶段(?:为|是|：|:)?\s*线索/g, '')
    .replace(/[；;，,]\s*[；;，,]+/g, '；')
    .replace(/^\s*[；;，,。]+|[；;，,]+\s*$/g, '')
    .trim()
  return INTERNAL_STAGE_LANGUAGE.test(text) ? '' : text
}

function sourceDocumentKey(source: EvidenceSource) {
  return `${source.sourceType}:${source.sourceId || source.sourceName}`
}

function sourceContent(value: string) {
  return collapseRepeatedText(cleanCorruptedText(value).text)
    .replace(/(?:页面正文摘录|原文链接|来源网址)[：:]?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function contentScore(value: string) {
  return (FACT_SIGNAL.test(value) ? 5 : 0)
    + (NUMBER_SIGNAL.test(value) ? 4 : 0)
    + Math.min(4, Math.floor(value.length / 350))
}

function selectCorpusEntries(sources: EvidenceSource[], includeAllSourceChunks = false) {
  const groups = new Map<string, CorpusEntry[]>()
  sources.forEach((source, sourceIndex) => {
    const content = sourceContent(source.content)
    if (!content || (!includeAllSourceChunks && INTERNAL_STAGE_LANGUAGE.test(content) && content.length < 120)) return
    const key = sourceDocumentKey(source)
    const values = groups.get(key) ?? []
    values.push({ sourceIndex, source, content, score: contentScore(content) })
    groups.set(key, values)
  })

  if (includeAllSourceChunks) {
    return [...groups.values()]
      .flat()
      .sort((left, right) => left.sourceIndex - right.sourceIndex)
  }

  const representatives: CorpusEntry[] = []
  const extras: CorpusEntry[] = []
  for (const values of groups.values()) {
    const ordered = [...values].sort(
      (left, right) => Number(left.source.chunkIndex ?? left.sourceIndex)
        - Number(right.source.chunkIndex ?? right.sourceIndex),
    )
    const highestValue = [...ordered].sort((left, right) => right.score - left.score)[0]
    if (highestValue) representatives.push(highestValue)
    const candidates = [
      ...ordered.slice(0, 2),
      ...[...ordered].sort((left, right) => right.score - left.score).slice(0, 5),
      ...ordered.slice(-1),
    ]
    const seen = new Set<number>()
    for (const candidate of candidates) {
      if (seen.has(candidate.sourceIndex)) continue
      seen.add(candidate.sourceIndex)
      if (candidate.sourceIndex !== highestValue?.sourceIndex) extras.push(candidate)
      if (seen.size >= 6) break
    }
  }

  const representativeIndexes = new Set(representatives.map((entry) => entry.sourceIndex))
  const entryLimit = Math.max(96, representatives.length)
  const selectedExtras = extras
    .filter((entry) => !representativeIndexes.has(entry.sourceIndex))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, entryLimit - representatives.length))
  return [
    ...representatives,
    ...selectedExtras,
  ]
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .slice(0, entryLimit)
}

function corpusPrompt(entries: CorpusEntry[], preserveFullContent = false) {
  return entries.map(({ source, sourceIndex, content }) =>
    `[S${sourceIndex}] 文件=${source.sourceName}；类型=${source.sourceType}；片段=${source.chunkIndex ?? sourceIndex}；日期=${source.versionOrDate || '未注明'}\n${preserveFullContent ? content : content.slice(0, 1_300)}`,
  ).join('\n\n')
}

function corpusBatches(entries: CorpusEntry[], preserveFullContent: boolean) {
  const batches: CorpusEntry[][] = []
  let current: CorpusEntry[] = []
  let currentCharacters = 0
  for (const entry of entries) {
    const entryCharacters = corpusPrompt([entry], preserveFullContent).length + 2
    if (current.length > 0 && currentCharacters + entryCharacters > STUDY_BATCH_CHARACTERS) {
      batches.push(current)
      current = []
      currentCharacters = 0
    }
    current.push(entry)
    currentCharacters += entryCharacters
  }
  if (current.length > 0) batches.push(current)
  return batches
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const run = async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= values.length) return
      results[index] = await worker(values[index], index)
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => run(),
  ))
  return results
}

function validIndexes(value: unknown, sourceCount: number, max = 16) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((entry): entry is number =>
    Number.isInteger(entry) && Number(entry) >= 0 && Number(entry) < sourceCount))]
    .slice(0, max)
}

function topicOf(value: unknown): ProjectKnowledgeTopic | undefined {
  const text = safeText(value, 80)
  return PROJECT_KNOWLEDGE_TOPICS.find((topic) => topic === text)
}

function natureOf(value: unknown): ProjectKnowledgeFact['nature'] {
  const values: ProjectKnowledgeFact['nature'][] = [
    '事实',
    '公司陈述',
    '预测或意向',
    '分析判断',
    '冲突或缺口',
  ]
  return values.includes(value as ProjectKnowledgeFact['nature'])
    ? value as ProjectKnowledgeFact['nature']
    : '事实'
}

function factNumbersSupported(text: string, indexes: number[], sources: EvidenceSource[]) {
  const numbers = text.match(/\d+(?:[.,]\d+)*(?:%|％)?/g) ?? []
  if (!numbers.length || !indexes.length) return true
  const sourceText = indexes.map((index) => sources[index]?.content ?? '').join(' ')
    .replace(/[,，]/g, '')
  return numbers.every((number) => sourceText.includes(number.replace(/[,，]/g, '')))
}

function normalizeModelBrief(
  raw: unknown,
  input: {
    project: ProjectLike
    sources: EvidenceSource[]
    sourceCutoffDate: string
    entries: CorpusEntry[]
  },
): Omit<ProjectKnowledgeBrief, 'audit'> {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const factsRaw = Array.isArray(value.facts) ? value.facts : []
  const seenFacts: string[] = []
  const facts = factsRaw.flatMap((entry): ProjectKnowledgeFact[] => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const topic = topicOf(item.topic)
    const text = clientSafeFactText(item.text)
    const sourceIndexes = validIndexes(item.sourceIndexes, input.sources.length)
    if (!topic || !text || !sourceIndexes.length) return []
    if (!factNumbersSupported(text, sourceIndexes, input.sources)) return []
    if (isNearDuplicate(text, seenFacts, 0.86)) return []
    seenFacts.push(text)
    return [{ topic, text, sourceIndexes, nature: natureOf(item.nature) }]
  }).slice(0, 90)

  const chronologyRaw = Array.isArray(value.chronology) ? value.chronology : []
  const chronology = chronologyRaw.flatMap((entry): ProjectKnowledgeChronologyItem[] => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const date = safeText(item.date, 40)
    const event = clientSafeFactText(item.event, 320)
    const sourceIndexes = validIndexes(item.sourceIndexes, input.sources.length)
    return date && event && sourceIndexes.length && factNumbersSupported(`${date}${event}`, sourceIndexes, input.sources)
      ? [{ date, event, sourceIndexes }]
      : []
  }).slice(0, 24)

  const tablesRaw = Array.isArray(value.recommendedTables) ? value.recommendedTables : []
  const recommendedTables = tablesRaw.flatMap((entry): ProjectKnowledgeTable[] => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const topic = topicOf(item.topic)
    const title = clientSafeFactText(item.title, 120)
    const columns = Array.isArray(item.columns)
      ? item.columns.map((cell) => clientSafeFactText(cell, 50)).filter(Boolean).slice(0, 7)
      : []
    const rows = Array.isArray(item.rows)
      ? item.rows.slice(0, 12).flatMap((row): string[][] => {
        if (!Array.isArray(row) || row.length !== columns.length) return []
        const cells = row.map((cell) => clientSafeFactText(cell, 160))
        return cells.every(Boolean) ? [cells] : []
      })
      : []
    const sourceIndexes = validIndexes(item.sourceIndexes, input.sources.length)
    if (!topic || !title || columns.length < 2 || rows.length < 2 || !sourceIndexes.length) return []
    if (!factNumbersSupported(rows.flat().join(' '), sourceIndexes, input.sources)) return []
    return [{ topic, title, columns, rows, sourceIndexes }]
  }).slice(0, 24)

  return {
    version: 'project-knowledge-study-v1',
    projectName: input.project.name,
    companyName: input.project.companyName || input.project.name,
    sourceCutoffDate: input.sourceCutoffDate,
    facts,
    chronology,
    conflicts: dedupeTextList(
      Array.isArray(value.conflicts)
        ? value.conflicts.map((entry) => clientSafeFactText(entry, 320)).filter(Boolean)
        : [],
      { limit: 12 },
    ),
    gaps: dedupeTextList(
      Array.isArray(value.gaps)
        ? value.gaps.map((entry) => clientSafeFactText(entry, 320)).filter(Boolean)
        : [],
      { limit: 16 },
    ),
    recommendedTables,
  }
}

function mergeModelBriefs(
  briefs: Array<Omit<ProjectKnowledgeBrief, 'audit'>>,
  input: {
    project: ProjectLike
    sourceCutoffDate: string
  },
): Omit<ProjectKnowledgeBrief, 'audit'> {
  const facts: ProjectKnowledgeFact[] = []
  const seenFacts: string[] = []
  for (const fact of briefs.flatMap((brief) => brief.facts)) {
    if (isNearDuplicate(fact.text, seenFacts, 0.88)) continue
    seenFacts.push(fact.text)
    facts.push(fact)
  }
  const chronologySeen = new Set<string>()
  const chronology = briefs.flatMap((brief) => brief.chronology).filter((item) => {
    const key = `${item.date}\u001f${item.event}`
    if (chronologySeen.has(key)) return false
    chronologySeen.add(key)
    return true
  })
  const tableSeen = new Set<string>()
  const recommendedTables = briefs.flatMap((brief) => brief.recommendedTables).filter((table) => {
    const key = `${table.topic}\u001f${table.title}\u001f${JSON.stringify(table.rows)}`
    if (tableSeen.has(key)) return false
    tableSeen.add(key)
    return true
  })
  return {
    version: 'project-knowledge-study-v1',
    projectName: input.project.name,
    companyName: input.project.companyName || input.project.name,
    sourceCutoffDate: input.sourceCutoffDate,
    facts,
    chronology,
    conflicts: dedupeTextList(briefs.flatMap((brief) => brief.conflicts), { limit: 64 }),
    gaps: dedupeTextList(briefs.flatMap((brief) => brief.gaps), { limit: 64 }),
    recommendedTables,
  }
}

function deterministicBrief(input: {
  project: ProjectLike
  sources: EvidenceSource[]
  sourceCutoffDate: string
  entries: CorpusEntry[]
}): Omit<ProjectKnowledgeBrief, 'audit'> {
  const facts: ProjectKnowledgeFact[] = []
  const seen: string[] = []
  for (const topic of PROJECT_KNOWLEDGE_TOPICS) {
    const keywords = topic.split(/[、与]/).filter((word) => word.length >= 2)
    const candidates = input.entries.flatMap((entry) =>
      entry.content.split(/(?<=[。！？；!?;])|\n+/).map((sentence) => ({
        sentence: clientSafeFactText(sentence, 360),
        sourceIndex: entry.sourceIndex,
        score: keywords.reduce((score, keyword) => score + (sentence.includes(keyword) ? 3 : 0), 0)
          + (FACT_SIGNAL.test(sentence) ? 2 : 0)
          + (NUMBER_SIGNAL.test(sentence) ? 2 : 0),
      })))
      .filter((item) => item.sentence.length >= 18 && item.score > 0)
      .sort((left, right) => right.score - left.score)
    for (const candidate of candidates) {
      if (facts.filter((fact) => fact.topic === topic).length >= 7) break
      if (isNearDuplicate(candidate.sentence, seen, 0.82)) continue
      seen.push(candidate.sentence)
      facts.push({
        topic,
        text: candidate.sentence,
        sourceIndexes: [candidate.sourceIndex],
        nature: /预计|目标|计划|拟/.test(candidate.sentence) ? '预测或意向' : '事实',
      })
    }
  }
  return {
    version: 'project-knowledge-study-v1',
    projectName: input.project.name,
    companyName: input.project.companyName || input.project.name,
    sourceCutoffDate: input.sourceCutoffDate,
    facts,
    chronology: [],
    conflicts: [],
    gaps: [],
    recommendedTables: [],
  }
}

function parseJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned) as unknown
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('项目资料研读未返回完整 JSON')
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown
  }
}

export async function buildProjectKnowledgeBrief(input: {
  project: ProjectLike
  sources: EvidenceSource[]
  sourceCutoffDate: string
  requiredProjectFiles?: Array<{ sourceId: string; sourceName: string }>
  includeAllSourceChunks?: boolean
  fetchImpl?: typeof fetch
}): Promise<ProjectKnowledgeBrief> {
  const includeAllSourceChunks = input.includeAllSourceChunks === true
  const entries = selectCorpusEntries(input.sources, includeAllSourceChunks)
  const corpus = corpusPrompt(entries, includeAllSourceChunks)
  const batches = corpusBatches(entries, includeAllSourceChunks)
  if (includeAllSourceChunks && entries.length !== input.sources.length) {
    throw Object.assign(new Error(
      `项目资料完整研读覆盖失败：应读取 ${input.sources.length} 个片段，实际纳入 ${entries.length} 个片段`,
    ), { code: 'PROJECT_KNOWLEDGE_CHUNK_COVERAGE_INCOMPLETE' })
  }
  const documentCount = new Set(input.sources.map(sourceDocumentKey)).size
  const sourceFilesRepresented = [...new Set(input.sources.map((source) => source.sourceName))]
  const selectedSourceFiles = [...new Set(entries.map((entry) => entry.source.sourceName))]
  const requiredProjectFiles = input.requiredProjectFiles ?? []
  const selectedSourceIds = new Set(entries
    .map((entry) => entry.source.sourceId)
    .filter((sourceId): sourceId is string => Boolean(sourceId)))
  const missingRequiredSourceFiles = requiredProjectFiles
    .filter((file) => !selectedSourceIds.has(file.sourceId))
    .map((file) => file.sourceName)
  const requiredSourceFileCoverageRatio = requiredProjectFiles.length
    ? Number(((requiredProjectFiles.length - missingRequiredSourceFiles.length)
      / requiredProjectFiles.length).toFixed(4))
    : 1
  const auditBase = {
    model: MODEL,
    sourceDocumentCount: documentCount,
    sourceFilesRepresented,
    selectedSourceFiles,
    sourceFileCoverageRatio: sourceFilesRepresented.length
      ? Number((selectedSourceFiles.length / sourceFilesRepresented.length).toFixed(4))
      : 1,
    requiredSourceDocumentCount: requiredProjectFiles.length,
    requiredSourceFiles: requiredProjectFiles.map((file) => file.sourceName),
    missingRequiredSourceFiles,
    requiredSourceFileCoverageRatio,
    completeProjectFileCoverage: missingRequiredSourceFiles.length === 0,
    sourceChunkCount: input.sources.length,
    includedChunkCount: entries.length,
    completeSourceChunkCoverage: entries.length === input.sources.length,
    studyBatchCount: batches.length,
    includedCharacterCount: corpus.length,
    corpusSha256: createHash('sha256').update(corpus).digest('hex'),
  }
  const fallback = () => ({
    ...deterministicBrief({ ...input, entries }),
    audit: { mode: 'deterministic-study' as const, ...auditBase },
  })
  if (!entries.length || process.env.AI_PROJECT_KNOWLEDGE_DISABLE_LLM === '1') return fallback()

  try {
    const normalizedBatches = await mapWithConcurrency(
      batches,
      STUDY_BATCH_CONCURRENCY,
      async (batch, batchIndex) => {
        const text = await requestAiGatewayText({
          baseUrl: GW_BASE,
          apiKey: GW_KEY,
          model: MODEL,
          messages: [
          {
            role: 'system',
            content: `你是 Project Corpus Analyst。你的唯一任务是先完整研读当前项目资料，再形成供后续四类正式投资文档共同使用的内部事实底稿；你不撰写报告正文。
要求：
1. 阅读所有带 S 编号的资料片段，先按文件和时间理解，再跨文件合并；不得只依据项目摘要或第一个片段。
2. 统一公司主体、人物、产品、客户、融资事件、交易安排、日期、金额、比例和历史/预测口径；相互冲突的口径不得擅自选择，必须写入 conflicts。
3. 每项事实必须保留真正支持它的 sourceIndexes；数字必须能在相应来源中逐字找到。
4. 区分事实、公司陈述、预测或意向、分析判断、冲突或缺口；不得把计划、接触、测试、意向写成合同、收入、回款或已完成交易。
5. 不输出“线索阶段、进入初筛、申请立项、启动尽调、提请上会、提交投决、继续跟踪、暂缓推进、归档”等系统流程词。
6. “创始人与核心团队”必须一名成员形成一项独立事实，明确姓名、职务、教育或任职经历及职责；不得把多名成员和多页团队材料压成一个长事实，人员对应关系不清楚的残片写入 gaps。
7. “产品、技术与知识产权”必须一项产品、平台、模型、系统、方案或技术能力形成一项独立事实，明确名称、机制、指标或验证及应用场景；不得混入团队履历、行业原理或页眉目录。
8. recommendedTables 只整理已有同口径数据，优先覆盖公司基本信息、历史沿革、股权、融资、团队、产品矩阵、客户验证、供应商、财务、预测、交易方案、风险与对策；不得为凑表格编造内容。
9. 只返回 JSON：{"facts":[{"topic":"公司主体与历史沿革|股权、融资与治理|创始人与核心团队|产品、技术与知识产权|商业模式、客户与供应链|行业、市场与竞争|财务、现金流与预测|交易方案、估值与退出|合规、风险与待确认事项","text":"","sourceIndexes":[0],"nature":"事实|公司陈述|预测或意向|分析判断|冲突或缺口"}],"chronology":[{"date":"","event":"","sourceIndexes":[0]}],"conflicts":[""],"gaps":[""],"recommendedTables":[{"topic":"","title":"","columns":[""],"rows":[[""]],"sourceIndexes":[0]}]}。`,
          },
          {
            role: 'user',
            content: `项目：${JSON.stringify({
              name: input.project.name,
              companyName: input.project.companyName,
              industry: input.project.industry,
              financing: input.project.financing,
              valuation: input.project.valuation,
              summary: input.project.summary,
              businessModel: input.project.businessModel,
              market: input.project.market,
              team: input.project.team,
})}
资料截止日：${input.sourceCutoffDate}
资料文件数：${documentCount}
资料片段数：${input.sources.length}
当前研读批次：${batchIndex + 1}/${batches.length}
本批片段数：${batch.length}

请逐条研读本批全部片段并形成批次事实底稿；S 编号是全局索引，不得改号或遗漏阅读：
${corpusPrompt(batch, includeAllSourceChunks)}`,
          },
        ],
          maxTokens: 12_000,
          reasoningEffort: 'medium',
          json: true,
          timeoutMs: STUDY_TIMEOUT_MS,
          fetchImpl: input.fetchImpl,
        })
        return normalizeModelBrief(parseJsonObject(text), { ...input, entries: batch })
      },
    )
    let normalized = mergeModelBriefs(normalizedBatches, input)
    if (normalized.facts.length < Math.min(8, Math.max(1, documentCount * 2))) {
      if (!includeAllSourceChunks) return fallback()
      normalized = mergeModelBriefs([
        ...normalizedBatches,
        deterministicBrief({ ...input, entries }),
      ], input)
    }
    return {
      ...normalized,
      audit: { mode: 'model-study', ...auditBase },
    }
  } catch (error) {
    if (includeAllSourceChunks) {
      throw Object.assign(new Error(
        `项目全部资料片段研读失败，已停止生成，避免以部分资料形成提案：${(error as Error).message}`,
      ), { code: 'PROJECT_KNOWLEDGE_COMPLETE_STUDY_FAILED', cause: error })
    }
    console.warn('[aiProjectKnowledgeBrief] 大模型研读不可用，使用确定性事实底稿:', (error as Error).message)
    return fallback()
  }
}

export function projectKnowledgeBriefForPrompt(
  brief: ProjectKnowledgeBrief | undefined,
  topics: readonly ProjectKnowledgeTopic[] = PROJECT_KNOWLEDGE_TOPICS,
) {
  if (!brief) return '未提供项目研读底稿；只能依据本章 Evidence 写作。'
  const topicSet = new Set(topics)
  const facts = brief.facts
    .filter((fact) => topicSet.has(fact.topic))
    .slice(0, 48)
    .map((fact) => `- [${fact.topic}/${fact.nature}] ${fact.text}（S${fact.sourceIndexes.join('、S')}）`)
  const tables = brief.recommendedTables
    .filter((table) => topicSet.has(table.topic))
    .slice(0, 10)
    .map((table) => `- ${table.title}：${table.columns.join('｜')}；${table.rows
      .slice(0, 6)
      .map((row) => row.join('｜'))
      .join('；')}（S${table.sourceIndexes.join('、S')}）`)
  return [
    `研读模式：${brief.audit.mode}；覆盖 ${brief.audit.sourceDocumentCount} 份文件、${brief.audit.sourceChunkCount} 个片段。`,
    '已消化事实：',
    ...facts,
    ...(tables.length ? ['可落表的结构化数据：', ...tables] : []),
    ...(brief.conflicts.length ? ['冲突口径：', ...brief.conflicts.slice(0, 8).map((item) => `- ${item}`)] : []),
    ...(brief.gaps.length ? ['重大缺口：', ...brief.gaps.slice(0, 8).map((item) => `- ${item}`)] : []),
  ].join('\n')
}

export function projectKnowledgeStudyPromptSummary() {
  return [
    '先逐份研读当前项目资料库文件并形成统一事实底稿，再开始正式材料写作。',
    '事实底稿统一主体、时间、关系、事件阶段和数字口径，保留来源索引并标记冲突。',
    '四类文档只能吸收底稿中的项目事实；模板只控制结构和版式，不提供项目事实。',
  ]
}
