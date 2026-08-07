import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import JSZip from 'jszip'
import { db } from '../db/client.js'
import {
  aiArtifacts,
  aiTaskSources,
  aiTasks,
  auditLogs,
  chatConversations,
  fileChunks,
  knowledgeChunks,
  projectFiles,
  projects,
  users,
} from '../db/schema.js'
import {
  annotateDueDiligencePendingAfterResearch,
  composeBusinessContent,
  dueDiligencePendingResearchTopics,
  investmentRecommendationPendingResearchTopics,
  usedBusinessSourceIndexes,
  type BusinessContent,
  type EvidenceSource,
} from './aiBusinessContentService.js'
import {
  generateBusinessDocx,
  generateBusinessPptx,
  generateBusinessPptxPreview,
  makeArtifactFileName,
} from './aiBusinessDocumentService.js'
import {
  AI_TEMPLATE_CATALOG,
  assertAiTemplateReferences,
  isAiExecutableTaskType,
  type AiBusinessTaskType,
  type AiExecutableTaskType,
} from './aiTemplateCatalog.js'
import { loadAiSkill } from './aiSkillService.js'
import { resolveAiCustomTemplateForTask } from './aiCustomTemplateService.js'
import {
  curateEvidenceSources,
  dedupeTextList,
  isDiagnosticEvidenceSourceName,
} from './aiEvidenceQualityService.js'
import {
  complianceBlueprintMetadata,
  parseComplianceDocumentBlueprint,
  type ComplianceDocumentBlueprint,
} from './aiComplianceBlueprintService.js'
import {
  buildComplianceEvidencePackets,
  composeComplianceStatement,
  type ComplianceWorkflowResult,
} from './aiComplianceWorkflowService.js'
import {
  reviewGeneratedComplianceDocx,
  type ComplianceOutputReview,
} from './aiComplianceOutputService.js'
import {
  fetchDueDiligenceNetworkEvidence,
  type DueDiligenceNetworkResearchAudit,
} from './aiDueDiligenceNetworkResearchService.js'
import {
  fetchComplianceModelEvidence,
  type ComplianceModelResearchAudit,
} from './aiComplianceModelResearchService.js'
import {
  inspectProjectQaDocx,
  makeProjectQaFileNames,
} from './aiQaDocumentService.js'
import { generateProjectQaWithSkill } from './aiProjectQaSkillRuntimeService.js'
import {
  buildProjectQaDocumentContent,
  generateProjectQaAnswers,
  generateProjectQaQuestions,
  PROJECT_QA_ANSWER_TARGET_MIN_CHARACTERS,
  PROJECT_QA_QUESTION_MAX_CHARACTERS,
  reviewProjectQaAnswers,
  usedProjectQaSourceIndexes,
  type ProjectQaDepth,
  type ProjectQaMode,
} from './aiQaPipelineService.js'
import {
  buildProjectKnowledgeBrief,
  type ProjectKnowledgeBrief,
} from './aiProjectKnowledgeBriefService.js'
import {
  fetchProjectQaModelEvidence,
  fetchVerifiedProjectWebEvidence,
  PROJECT_QA_RESEARCH_TOPICS,
  projectQaResearchTopicsForSources,
  projectWebResearchTopicsForSources,
  type ProjectQaModelResearchAudit,
  type ProjectQaResearchTopic,
  type ProjectWebResearchAudit,
} from './aiQaModelResearchService.js'
import {
  createProjectQaSkillProfile,
  type QaTemplateProfile,
} from './aiQaTemplateParser.js'
import {
  loadInvestmentProposalBlueprint,
  type InvestmentProposalDocumentBlueprint,
} from './aiInvestmentProposalBlueprintService.js'
import {
  reviewInvestmentProposalDocx,
  type InvestmentProposalOutputReview,
} from './aiInvestmentProposalDocumentService.js'
import { validateInvestmentProposalWithSkill } from './aiInvestmentProposalSkillRuntimeService.js'
import {
  safeAiTaskFailureMessage,
  safeAiTaskFailureStage,
} from './aiTaskErrorService.js'
import {
  assessTemplateFidelity,
  TEMPLATE_FIDELITY_MINIMUM,
  type TemplateFidelityAssessment,
  type TemplateFidelityCheck,
} from './aiTemplateFidelityService.js'
import {
  buildInvestmentRecommendationGenerationAudit,
  prepareInvestmentRecommendationPptWorkflow,
  reviewInvestmentRecommendationPpt,
  type InvestmentRecommendationPptWorkflow,
} from './aiInvestmentRecommendationPptWorkflowService.js'

export type AiTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type AiTaskUser = {
  uid: string
  name: string
  role: string
}

export type CreateAiTaskInput = {
  type: AiExecutableTaskType
  projectId: string
  conversationId?: string
  parameters: Record<string, unknown>
  idempotencyKey: string
  retryOfTaskId?: string
}

export type CreateInvestmentPptPreparationInput = {
  projectId: string
  conversationId: string
  fileName: string
  progressId: string
  startedAt: string
  sourceCutoffDate: string
  outputFormat: 'PPTX'
  language: '中文'
  structureMode: 'strict-template'
  userInstructions?: string
  idempotencyKey: string
}

const ARTIFACT_ROOT = path.resolve(process.env.AI_ARTIFACT_ROOT || path.join(process.cwd(), 'server', 'ai-artifacts'))
const running = new Set<string>()
const AUTO_RECOVERY_TASK_TYPES = new Set<AiExecutableTaskType>([
  'compliance_statement',
  'investment_proposal',
  'investment_recommendation_ppt',
  'due_diligence_report',
  'project_qa',
  'custom_template_document',
])

async function retryDocumentStep<T>(
  label: string,
  operation: (attempt: number) => Promise<T>,
  maxAttempts = 2,
) {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      console.warn(
        `[aiTask] ${label}第 ${attempt} 次未完成${attempt < maxAttempts ? '，自动再次生成' : ''}:`,
        (error as Error).message,
      )
    }
  }
  throw lastError
}

async function withTaskHeartbeat<T>(
  taskId: string,
  operation: () => Promise<T>,
  options: {
    startProgress: number
    endProgress: number
    stage: (elapsedSeconds: number) => string
  },
) {
  const startedAt = Date.now()
  let progressWrite = Promise.resolve()
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    const progress = Math.min(
      options.endProgress,
      options.startProgress + Math.floor(elapsedSeconds / 15),
    )
    progressWrite = progressWrite
      .then(() => updateStage(taskId, options.stage(elapsedSeconds), progress))
      .catch((error) => {
        console.warn('[aiTask] 任务进度心跳写入未完成:', (error as Error).message)
      })
  }, 15_000)
  heartbeat.unref?.()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await progressWrite
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function createRequestHash(input: CreateAiTaskInput) {
  return createHash('sha256').update(canonicalJson({
    type: input.type,
    projectId: input.projectId,
    conversationId: input.conversationId ?? null,
    parameters: input.parameters,
  })).digest('hex')
}

function publicArtifact(row: typeof aiArtifacts.$inferSelect) {
  const { storagePath: _storagePath, ...safe } = row
  return {
    ...safe,
    downloadUrl: `/api/ai/artifacts/${row.id}/download`,
  }
}

async function userCanAccessProject(user: AiTaskUser, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) return { allowed: false as const, project: undefined, reason: '项目不存在' }
  const collaborators = Array.isArray(project.collaborators) ? project.collaborators : []
  // 兼容历史项目：created_by 为空时维持当前系统的全员可见行为；新项目按创建者、负责人和协作者判断。
  const allowed = user.role === '系统管理员'
    || !project.createdBy
    || project.createdBy === user.uid
    || project.owner === user.name
    || collaborators.includes(user.name)
  return { allowed, project, reason: allowed ? '' : '无权访问该项目' }
}

async function writeTaskAudit(user: AiTaskUser, action: string, target: string) {
  await db.insert(auditLogs).values({
    userId: user.uid,
    userName: user.name,
    module: 'AI 智能助手',
    action,
    target,
  })
}

async function sourcesForProject(
  projectId: string,
  sourceCutoffDate: string,
  limit = 40,
): Promise<EvidenceSource[]> {
  const cutoff = new Date(`${sourceCutoffDate}T23:59:59.999Z`)
  const [rows, legacyFileRows] = await Promise.all([
    db.select().from(knowledgeChunks)
      .where(and(
        eq(knowledgeChunks.scope, 'project'),
        eq(knowledgeChunks.refId, projectId),
        lte(knowledgeChunks.createdAt, cutoff),
      ))
      .orderBy(
        sql`CASE
          WHEN lower(${knowledgeChunks.sourceName}) LIKE 'perf\_%'
            OR lower(${knowledgeChunks.sourceName}) LIKE 'localperf\_%'
            OR ${knowledgeChunks.sourceName} LIKE '%大文件测试%'
            OR ${knowledgeChunks.sourceName} LIKE '%解析测试%'
            OR ${knowledgeChunks.sourceName} LIKE '%卡住排查%'
            OR ${knowledgeChunks.sourceName} LIKE '%异步上传%'
            OR ${knowledgeChunks.sourceName} LIKE '%日志测试%'
            OR ${knowledgeChunks.sourceName} LIKE '%需求1复核%'
            OR lower(${knowledgeChunks.sourceName}) LIKE 'csv测试%'
            OR lower(${knowledgeChunks.sourceName}) LIKE 'pptx测试%'
            OR lower(${knowledgeChunks.sourceName}) LIKE 'txt测试%'
          THEN 2
          WHEN ${knowledgeChunks.sourceType} LIKE 'public_web%' THEN 1
          ELSE 0
        END`,
        asc(knowledgeChunks.sourceName),
        asc(knowledgeChunks.chunkIndex),
      )
      .limit(limit),
    // 历史文件可能已解析进 file_chunks，但知识库双写曾失败。这里直接兜底读取，
    // 避免“资料库有文件、生成任务却判无资料”。
    db.select().from(fileChunks)
      .where(and(
        eq(fileChunks.projectId, projectId),
        lte(fileChunks.createdAt, cutoff),
      ))
      .orderBy(
        sql`CASE
          WHEN lower(${fileChunks.fileName}) LIKE 'perf\_%'
            OR lower(${fileChunks.fileName}) LIKE 'localperf\_%'
            OR ${fileChunks.fileName} LIKE '%大文件测试%'
            OR ${fileChunks.fileName} LIKE '%解析测试%'
            OR ${fileChunks.fileName} LIKE '%卡住排查%'
            OR ${fileChunks.fileName} LIKE '%异步上传%'
            OR ${fileChunks.fileName} LIKE '%日志测试%'
            OR ${fileChunks.fileName} LIKE '%需求1复核%'
            OR lower(${fileChunks.fileName}) LIKE 'csv测试%'
            OR lower(${fileChunks.fileName}) LIKE 'pptx测试%'
            OR lower(${fileChunks.fileName}) LIKE 'txt测试%'
          THEN 1
          ELSE 0
        END`,
        asc(fileChunks.fileName),
        asc(fileChunks.chunkIndex),
      )
      .limit(limit),
  ])
  const knowledgeSources = rows.filter((row) =>
    !isDiagnosticEvidenceSourceName(row.sourceName)).map((row) => {
    const cachedUrl = row.sourceType.startsWith('public_web')
      ? row.content.match(/(?:来源网址|规范化\s*URL|页面\s*URL)[:：]\s*(https?:\/\/\S+)/i)?.[1]
      : undefined
    return {
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      sourceName: row.sourceName || '项目资料',
      chunkIndex: row.chunkIndex,
      versionOrDate: row.createdAt.toISOString().slice(0, 10),
      locator: cachedUrl,
      content: row.content,
    }
  })
  const contentHashes = new Set(knowledgeSources.map((source) =>
    createHash('sha256').update(source.content.trim()).digest('hex')))
  const legacyFileSources: EvidenceSource[] = []
  for (const row of legacyFileRows) {
    if (isDiagnosticEvidenceSourceName(row.fileName)) continue
    const content = row.content.trim()
    if (!content) continue
    const contentHash = createHash('sha256').update(content).digest('hex')
    if (contentHashes.has(contentHash)) continue
    contentHashes.add(contentHash)
    legacyFileSources.push({
      sourceType: 'file',
      sourceId: row.fileId,
      sourceName: row.fileName || '项目文件',
      chunkIndex: row.chunkIndex,
      versionOrDate: row.createdAt.toISOString().slice(0, 10),
      content,
    })
  }
  return [...knowledgeSources, ...legacyFileSources]
}

async function cacheProjectNetworkEvidence(projectId: string, sources: EvidenceSource[]) {
  const cacheable = sources.filter((source) =>
    source.sourceType.startsWith('public_web') && source.sourceId && source.locator)
  for (const source of cacheable) {
    const [existing] = await db.select({ id: knowledgeChunks.id }).from(knowledgeChunks)
      .where(and(
        eq(knowledgeChunks.scope, 'project'),
        eq(knowledgeChunks.refId, projectId),
        eq(knowledgeChunks.sourceType, source.sourceType),
        eq(knowledgeChunks.sourceId, source.sourceId!),
      ))
      .limit(1)
    if (existing) continue
    await db.insert(knowledgeChunks).values({
      scope: 'project',
      refId: projectId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceName: source.sourceName,
      chunkIndex: source.chunkIndex ?? 0,
      content: [
        source.content,
        source.locator ? `来源网址：${source.locator}` : '',
      ].filter(Boolean).join('\n'),
    })
  }
}

function complianceNetworkResearchTopics(
  sources: EvidenceSource[],
  project: {
    name: string
    companyName?: string | null
    industry?: string | null
  },
  parameters: Record<string, unknown>,
) {
  const subject = project.companyName || project.name
  const userIntent = [
    typeof parameters.researchIntent === 'string' ? parameters.researchIntent : '',
    typeof parameters.userInstructions === 'string' ? parameters.userInstructions : '',
  ].map((value) => value.trim()).find(Boolean)
  const compactUserIntent = userIntent?.replace(/\s+/g, ' ').slice(0, 300) ?? ''
  const packets = buildComplianceEvidencePackets(sources)
  const emptySections = new Set(
    packets.filter((packet) => packet.items.length === 0).map((packet) => packet.sectionTitle),
  )
  const cachedPublicText = sources
    .filter((source) => source.sourceType.startsWith('public_web'))
    .map((source) => `${source.sourceName}\n${source.content}`)
    .join('\n')
  const fundEntities = [...new Set(
    sources
      .filter((source) => !source.sourceType.startsWith('public_web'))
      .flatMap((source) =>
        source.content.match(/[\u3400-\u9fffA-Za-z0-9（）()·-]{2,36}(?:基金|合伙企业)/g) ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length <= 40),
  )].slice(0, 2)
  const fundScope = fundEntities.length ? `${fundEntities.join('、')} ` : ''
  const topics: string[] = compactUserIntent
    ? [`${subject} ${compactUserIntent}`]
    : []

  if (['公司简介', '核心团队', '产品及技术'].some((title) => emptySections.has(title))) {
    topics.push(`${subject} 公司简介、主体工商、核心团队、创始人、产品技术、知识产权、客户和商业化公开信息`)
  }
  if (emptySections.has('投资理由') || !/行业政策|市场趋势|产业政策/.test(cachedPublicText)) {
    topics.push(`${project.industry || '项目所属细分领域'} 行业政策、市场趋势和产业政策公开依据`)
  }
  if (emptySections.has('投资计划') || !/融资|估值|投资方|资金用途/.test(cachedPublicText)) {
    topics.push('融资事件、投资方、估值、交易方式和资金用途公开信息')
  }
  if (!/返投|投资限制|返投认定|返投台账/.test(cachedPublicText)) {
    topics.push(`${fundScope}投资方式、投资限制、返投政策、返投认定口径及可公开查询的返投记录`)
  }
  if (!/关联交易|投资方向|投资配置|SPV|集中度/.test(cachedPublicText)) {
    topics.push('关联交易、投资方向、SPV或直投配置和投资集中度监管规则')
  }
  if (!/许可|备案|处罚|诉讼|失信|制裁|监管/.test(cachedPublicText)) {
    topics.push('许可备案、处罚诉讼、失信制裁和其他监管合规公开信息')
  }

  return topics.slice(0, 8)
}

function sharedInvestmentResearchTopics(
  type: AiExecutableTaskType,
  project: {
    name: string
    companyName?: string | null
    industry?: string | null
  },
  parameters: Record<string, unknown>,
) {
  const subject = project.companyName || project.name
  const intent = typeof parameters.researchIntent === 'string'
    ? parameters.researchIntent.trim()
    : ''
  if (type === 'investment_recommendation_ppt') {
    const chapterResearch: Record<ProjectQaResearchTopic, string> = {
      '项目主体与工商': '法律主体、成立时间、注册资本、所在地和历史沿革',
      '股权、治理与关联关系': '股权结构、实际控制人、董事治理和关联关系',
      '创始人与核心团队': '创始人、核心团队履历、分工和任职关系',
      '产品、技术指标与工程化里程碑': '具名产品、技术路线、性能指标、工程化和交付进展',
      '知识产权与研发合作': '专利、软件著作权、论文、研发合作和权属',
      '客户、订单与商业化信号': '客户、测试、合同、订单、交付、验收、收入、回款和复购',
      '财务与现金流': '历史收入、成本、毛利、利润、现金流、应收回款和管理层预测',
      '融资、估值与投资方': '历史融资、本轮融资、投资方、投前投后估值和资金用途',
      '交易方案与关键条款': '投资金额、增资或老股、持股比例、交割条件、治理和保护性条款',
      '行业、市场空间与政策': `${project.industry || '所属细分行业'}定义、TAM/SAM/SOM、市场规模、增长率、渗透率、需求和政策`,
      '竞品、替代方案与项目级对标': '具名竞品、替代方案、产品参数、价格、客户场景、融资和商业化对标',
      '监管、诉讼与重大风险': '资质、行政处罚、诉讼、失信、监管和其他可能影响交易的风险',
    }
    return [...new Set([
      ...(intent ? [`${subject} ${intent}`] : []),
      ...PROJECT_QA_RESEARCH_TOPICS.map((topic) =>
        `${subject} ${chapterResearch[topic]}`),
    ])]
  }
  const common = [
    `${subject} 公司主体、股东与治理、创始人和核心团队`,
    `${subject} 产品、技术指标、知识产权、研发合作和工程化进展`,
    `${subject} 客户、合同、订单、交付、验收、收入、回款和商业化进展`,
    `${subject} 融资轮次、融资金额、投资方、估值、资金用途和交易事项`,
    `${subject} 行政处罚、诉讼、失信、监管、资质和其他重大风险`,
  ]
  const typeSpecific = type === 'investment_proposal'
    ? [`${subject} 商业模式、财务表现、投资亮点、交易条件和退出路径`]
    : type === 'due_diligence_report'
        ? [`${subject} 财务报表、现金流、关联交易、劳动用工和合规事项`]
        : type === 'project_qa'
          ? [`${subject} 近期进展、争议事项、公开回应和下一步投资核验重点`]
          : [`${subject} 近期公开进展、商业化信号和投资判断所需关键信息`]
  return [...new Set([
    ...(intent ? [`${subject} ${intent}`] : []),
    ...common,
    ...typeSpecific,
  ])].slice(0, 7)
}

function investmentRecommendationWebTopicsForSources(
  sources: readonly EvidenceSource[],
  maxTopics = 12,
): ProjectQaResearchTopic[] {
  return [...new Set<ProjectQaResearchTopic>([
    ...PROJECT_QA_RESEARCH_TOPICS,
    ...projectWebResearchTopicsForSources(sources, maxTopics),
  ])].slice(0, maxTopics)
}

function compactEvidenceName(value: unknown) {
  return String(value ?? '')
    .replace(/(?:有限责任公司|股份有限公司|有限公司|项目)$/g, '')
    .replace(/[“”"'《》\s]+/g, '')
}

/**
 * 历史公开网页缓存可能由同项目下的其他任务产生。只有命中当前主体，
 * 或明确标记为当前项目行业上下文的页面，才允许进入本次生成。
 */
export function evidenceSourceMatchesProject(
  source: EvidenceSource,
  project: {
    name: string
    companyName?: string | null
    industry?: string | null
  },
) {
  if (!source.sourceType.startsWith('public_web')) return true
  const text = `${source.sourceName}\n${source.content}`.replace(/\s+/g, '')
  const entityNames = [...new Set([
    compactEvidenceName(project.companyName),
    compactEvidenceName(project.name),
  ].filter((value) => value.length >= 2))]
  if (entityNames.some((name) => text.includes(name))) return true
  if (!/项目匹配：行业上下文一致/.test(source.content)) return false
  const generic = new Set(['科技', '技术', '智能', '人工智能', '软件', '硬件', '制造业', '服务业'])
  const industryTerms = String(project.industry ?? '')
    .split(/[、，,；;\/|·\s]+/)
    .map(compactEvidenceName)
    .filter((value) => value.length >= 3 && !generic.has(value))
  return industryTerms.some((term) => text.includes(term))
}

export function screenEvidenceSources(sources: EvidenceSource[], type?: AiExecutableTaskType) {
  const options = type === 'investment_proposal'
    ? { maxTotal: 120, maxPerDocument: 10 }
    : type === 'compliance_statement'
      ? { maxTotal: 96, maxPerDocument: 12 }
      : type === 'due_diligence_report' || type === 'custom_template_document'
        ? { maxTotal: 96, maxPerDocument: 4 }
    : type === 'project_qa'
          ? { maxTotal: 72, maxPerDocument: 8 }
          : type === 'investment_recommendation_ppt'
            ? { maxTotal: 120, maxPerDocument: 14 }
          : { maxTotal: 18, maxPerDocument: 3 }
  const result = curateEvidenceSources(sources, options)
  // 本地项目资料优先，项目档案和用户补充输入其次，缓存公开证据最后。
  const priority = (sourceType: string) => {
    if (sourceType.startsWith('public_web')) return 2
    if (sourceType === 'project_record' || sourceType === 'user_input') return 1
    return 0
  }
  result.usable.sort((left, right) =>
    priority(left.sourceType) - priority(right.sourceType))
  return result
}

async function getTaskRow(userId: string, taskId: string) {
  const [task] = await db.select().from(aiTasks)
    .where(and(eq(aiTasks.id, taskId), eq(aiTasks.userId, userId)))
    .limit(1)
  return task
}

async function isCancellationRequested(taskId: string) {
  const [row] = await db.select({ requested: aiTasks.cancellationRequested, status: aiTasks.status })
    .from(aiTasks).where(eq(aiTasks.id, taskId)).limit(1)
  return !row || row.requested || row.status === 'cancelled'
}

async function updateStage(taskId: string, stage: string, progress: number) {
  const boundedProgress = Math.max(0, Math.min(100, Math.round(progress)))
  await db.update(aiTasks).set({
    stage,
    progress: sql<number>`GREATEST(${aiTasks.progress}, ${boundedProgress})`,
    updatedAt: new Date(),
  }).where(eq(aiTasks.id, taskId))
}

type InvestmentRecommendationResumeCheckpoint = {
  content: BusinessContent
  sourceSnapshots: Array<Record<string, unknown>>
  checkpointPath: string
}

function checkpointSourceIdentity(source: Record<string, unknown>) {
  return [
    String(source.sourceType ?? source.type ?? ''),
    String(source.sourceName ?? source.name ?? source.title ?? ''),
    String(source.locator ?? ''),
    String(source.versionOrDate ?? source.version_or_date ?? ''),
  ].join('\u001f')
}

function isBusinessContentCheckpoint(value: unknown): value is BusinessContent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.title === 'string'
    && typeof record.executiveSummary === 'string'
    && Array.isArray(record.sections)
    && Array.isArray(record.highlights)
    && Array.isArray(record.risks)
    && Array.isArray(record.missing)
}

export function remapInvestmentRecommendationCheckpointSources(input: {
  content: BusinessContent
  checkpointSources: Array<Record<string, unknown>>
  currentSources: EvidenceSource[]
}) {
  const currentQueues = new Map<string, number[]>()
  input.currentSources.forEach((source, index) => {
    const key = checkpointSourceIdentity(source as unknown as Record<string, unknown>)
    currentQueues.set(key, [...(currentQueues.get(key) ?? []), index])
  })
  const indexMap = new Map<number, number>()
  input.checkpointSources.forEach((source, index) => {
    const exactCurrent = input.currentSources[index]
    const identity = checkpointSourceIdentity(source)
    const queue = currentQueues.get(identity) ?? []
    if (
      exactCurrent
      && checkpointSourceIdentity(exactCurrent as unknown as Record<string, unknown>)
        === identity
      && queue.includes(index)
    ) {
      indexMap.set(index, index)
      const position = queue.indexOf(index)
      if (position >= 0) queue.splice(position, 1)
      return
    }
    const next = queue.shift()
    if (next !== undefined) indexMap.set(index, next)
  })
  const remap = (indexes: number[] | undefined) => [...new Set((indexes ?? [])
    .map((index) => indexMap.get(index))
    .filter((index): index is number => index !== undefined))]
  const content = JSON.parse(JSON.stringify(input.content)) as BusinessContent
  content.executiveSummarySourceIndexes = remap(content.executiveSummarySourceIndexes)
  for (const section of content.sections) {
    section.summarySourceIndexes = remap(section.summarySourceIndexes)
    for (const finding of section.findings) finding.sourceIndexes = remap(finding.sourceIndexes)
    for (const table of section.tables ?? []) table.sourceIndexes = remap(table.sourceIndexes)
  }
  return content
}

async function loadInvestmentRecommendationResumeCheckpoint(
  directory: string | undefined,
  currentSources: EvidenceSource[],
) {
  if (!directory) return undefined
  const candidates: Array<{ path: string; modifiedAt: number }> = []
  const directPath = path.join(directory, '.investment-recommendation-checkpoint.json')
  const directStat = await stat(directPath).catch(() => undefined)
  if (directStat?.isFile()) candidates.push({ path: directPath, modifiedAt: directStat.mtimeMs })
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.gorden-super-ppt-')) continue
    const projectFactsPath = path.join(directory, entry.name, 'project-facts.json')
    const projectFactsStat = await stat(projectFactsPath).catch(() => undefined)
    if (projectFactsStat?.isFile()) {
      candidates.push({ path: projectFactsPath, modifiedAt: projectFactsStat.mtimeMs })
    }
  }
  for (const candidate of candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)) {
    try {
      const parsed = JSON.parse(await readFile(candidate.path, 'utf8')) as Record<string, unknown>
      const content = parsed.content ?? parsed.verifiedContent
      const sourceSnapshots = Array.isArray(parsed.sources)
        ? parsed.sources.filter((source): source is Record<string, unknown> => (
            Boolean(source) && typeof source === 'object'
          ))
        : []
      if (!isBusinessContentCheckpoint(content) || !sourceSnapshots.length) continue
      return {
        content: remapInvestmentRecommendationCheckpointSources({
          content,
          checkpointSources: sourceSnapshots,
          currentSources,
        }),
        sourceSnapshots,
        checkpointPath: candidate.path,
      } satisfies InvestmentRecommendationResumeCheckpoint
    } catch {
      // Ignore incomplete or incompatible checkpoints and continue from scratch.
    }
  }
  return undefined
}

async function saveInvestmentRecommendationCheckpoint(input: {
  checkpointPath: string
  content: BusinessContent
  sources: EvidenceSource[]
}) {
  const temporaryPath = `${input.checkpointPath}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, JSON.stringify({
    schemaVersion: '1.0',
    content: input.content,
    sources: input.sources,
  }), 'utf8')
  await rename(temporaryPath, input.checkpointPath)
}

function requestedAttachmentFileIds(parameters: Record<string, unknown>) {
  const values = Array.isArray(parameters.attachmentFileIds)
    ? parameters.attachmentFileIds
    : []
  return [...new Set(values.filter((value): value is string =>
    typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  ))].slice(0, 10)
}

async function waitForRequestedAttachments(
  taskId: string,
  projectId: string,
  fileIds: string[],
) {
  if (!fileIds.length) return true
  const timeoutMs = Math.max(
    10_000,
    Number(process.env.AI_TASK_ATTACHMENT_WAIT_MS || 5 * 60_000),
  )
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isCancellationRequested(taskId)) return false
    const rows = await db.select({
      id: projectFiles.id,
      name: projectFiles.name,
      parseStatus: projectFiles.parseStatus,
      parseError: projectFiles.parseError,
    }).from(projectFiles).where(and(
      eq(projectFiles.projectId, projectId),
      inArray(projectFiles.id, fileIds),
    ))
    const missingCount = fileIds.length - rows.length
    if (missingCount > 0) {
      throw Object.assign(new Error('本轮上传文件不存在或不属于当前项目'), {
        code: 'TASK_ATTACHMENT_NOT_FOUND',
      })
    }
    const failed = rows.filter((row) => row.parseStatus === '失败')
    if (failed.length > 0) {
      throw Object.assign(
        new Error(`本轮附件解析失败：${failed.map((row) =>
          `${row.name}${row.parseError ? `（${row.parseError}）` : ''}`).join('、')}`),
        { code: 'TASK_ATTACHMENT_PARSE_FAILED' },
      )
    }
    const completed = rows.filter((row) => row.parseStatus === '成功').length
    if (completed === rows.length) return true
    await updateStage(
      taskId,
      `等待本轮附件解析（${completed}/${rows.length}）`,
      12,
    )
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw Object.assign(new Error('本轮附件解析超时，请稍后重试生成'), {
    code: 'TASK_ATTACHMENT_PARSE_TIMEOUT',
  })
}

function isTemplatePreparationPending(parameters: Record<string, unknown> | null | undefined) {
  return parameters?._templatePreparationPending === true
}

async function cancelIfRequested(taskId: string) {
  if (!(await isCancellationRequested(taskId))) return false
  await db.update(aiTasks).set({
    status: 'cancelled',
    stage: '已取消',
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(aiTasks.id, taskId))
  return true
}

async function inspectGeneratedArtifact(
  filePath: string,
  format: 'docx' | 'pptx',
  options: {
    requireEndReferences?: boolean
    allowInheritedCjkLanguageMetadata?: boolean
    expectedSectionTitles?: string[]
    expectedTableCount?: number
  } = {},
) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile() || fileStat.size < 1000) throw new Error('生成文件为空或不完整')
  const zip = await JSZip.loadAsync(await import('node:fs/promises').then((fs) => fs.readFile(filePath)))
  if (format === 'docx') {
    if (!zip.file('word/document.xml')) throw new Error('DOCX 缺少 document.xml')
    const documentXml = await zip.file('word/document.xml')!.async('string')
    if (!documentXml.includes('<w:t')) throw new Error('DOCX 没有可编辑文本')
    if (documentXml.includes('\uFFFD')) throw new Error('DOCX 正文包含损坏的 Unicode 字符')
    if (/w:eastAsia="Arial Unicode MS"/.test(documentXml)) throw new Error('DOCX 使用了不兼容的中文字体')
    const requireEndReferences = options.requireEndReferences ?? true
    if (requireEndReferences && !documentXml.includes('引用资料')) {
      throw new Error('DOCX 文尾缺少引用资料')
    }
    const visibleText = documentXml.replace(/<[^>]+>/g, '')
    const expectedSectionTitles = options.expectedSectionTitles ?? []
    let sectionOffset = 0
    const sectionTreeValidated = expectedSectionTitles.every((title) => {
      const index = visibleText.indexOf(title, sectionOffset)
      if (index < 0) return false
      sectionOffset = index + title.length
      return true
    })
    const tableCount = (documentXml.match(/<w:tbl\b/g) || []).length
    const expectedTableCountValidated = options.expectedTableCount === undefined
      || tableCount === options.expectedTableCount
    const finalSection = [...documentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].at(-1)?.[0] ?? ''
    const pageSize = finalSection.match(/<w:pgSz\b[^>]*\/?>/)?.[0] ?? ''
    const pageWidth = Number.parseInt(pageSize.match(/\bw:w="(\d+)"/)?.[1] ?? '-1', 10)
    const pageHeight = Number.parseInt(pageSize.match(/\bw:h="(\d+)"/)?.[1] ?? '-1', 10)
    const a4PageValidated = pageWidth === 11906 && pageHeight === 16838
    return {
      qualityStatus: 'passed',
      metadata: {
        bytes: fileStat.size,
        editableText: true,
        encodingClean: true,
        cjkFontValidated: true,
        endReferencesValidated: requireEndReferences,
        stylesPartValidated: Boolean(zip.file('word/styles.xml')),
        fontTablePartValidated: Boolean(zip.file('word/fontTable.xml')),
        sectionTreeValidated,
        expectedSectionCount: expectedSectionTitles.length,
        tableCount,
        expectedTableCount: options.expectedTableCount,
        expectedTableCountValidated,
        a4PageValidated,
      },
    }
  }
  const pptxQualityError = (message: string, code: string) =>
    Object.assign(new Error(message), { code })
  if (!zip.file('ppt/presentation.xml')) {
    throw pptxQualityError('PPTX 缺少 presentation.xml', 'PPTX_OPENXML_INVALID')
  }
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  let editableTextElements = 0
  for (const name of slides) {
    const xml = await zip.file(name)!.async('string')
    if (xml.includes('\uFFFD')) {
      throw pptxQualityError(
        `PPTX ${name} 包含损坏的 Unicode 字符`,
        'PPTX_UNICODE_INVALID',
      )
    }
    const textRuns = [
      ...xml.matchAll(/<a:r\b[\s\S]*?<\/a:r>/g),
      ...xml.matchAll(/<a:fld\b[\s\S]*?<\/a:fld>/g),
    ].map((match) => match[0])
    if (
      !options.allowInheritedCjkLanguageMetadata
      && textRuns.some((run) =>
        /lang="en-US"/.test(run)
        && /<a:t\b[^>]*>[^<]*[\u3400-\u9FFF]/.test(run))
    ) {
      throw pptxQualityError(
        `PPTX ${name} 的中文文本语言标记错误`,
        'PPTX_CJK_LANGUAGE_INVALID',
      )
    }
    editableTextElements += (xml.match(/<a:t>/g) || []).length
  }
  const finalSlideXml = await zip.file(`ppt/slides/slide${slides.length}.xml`)?.async('string') || ''
  if (!/(?:资料来源与声明|引用资料与责任声明)/.test(finalSlideXml)) {
    throw pptxQualityError(
      'PPTX 最后一页缺少资料来源与声明',
      'PPTX_REFERENCES_MISSING',
    )
  }
  const themeXml = await zip.file('ppt/theme/theme1.xml')?.async('string')
  const themeFontTags = themeXml?.match(/<a:font\b[^>]*>/g) ?? []
  const hasEastAsiaThemeFont = !!themeXml && (
    /<a:ea[^>]+typeface="[^"]+"/.test(themeXml)
    || themeFontTags.some((tag) =>
      /script="Hans"/.test(tag) && /typeface="[^"]+"/.test(tag))
  )
  if (!hasEastAsiaThemeFont) {
    throw pptxQualityError('PPTX 缺少东亚主题字体', 'PPTX_CJK_THEME_MISSING')
  }
  if (slides.length < 3 || editableTextElements < slides.length * 2) {
    throw pptxQualityError(
      'PPTX 可编辑文本元素不足',
      'PPTX_EDITABLE_CONTENT_INSUFFICIENT',
    )
  }
  return {
    qualityStatus: 'passed',
    metadata: {
      bytes: fileStat.size,
      slideCount: slides.length,
      editableTextElements,
      openXmlValid: true,
      encodingClean: true,
      cjkFontValidated: true,
      endReferencesValidated: true,
    },
  }
}

type DocumentQualityResult = {
  qualityStatus: string
  metadata: Record<string, unknown>
}

function metadataFlag(metadata: Record<string, unknown>, key: string) {
  return metadata[key] === true
}

function fidelityCheck(code: string, passed: boolean, critical = false): TemplateFidelityCheck {
  return { code, passed, critical }
}

function exactSectionOrder(content: BusinessContent, expectedTitles: string[]) {
  return content.sections.length === expectedTitles.length
    && content.sections.every((section, index) => section.title === expectedTitles[index])
}

function reviewHasNone(
  review: { issues: Array<{ code: string }> } | undefined,
  codes: string[],
) {
  if (!review) return false
  const issueCodes = new Set(review.issues.map((issue) => issue.code))
  return codes.every((code) => !issueCodes.has(code))
}

function dueDiligenceMinimumPlannedTables(content: BusinessContent) {
  const tableFriendlySections = new Set([
    '公司基本信息', '历史沿革', '公司股东情况及实际控制人情况', '核心团队介绍',
    '组织架构', '关联公司及关联交易', '资质、荣誉及法律合规情况', '产品矩阵',
    '场景应用', '知识产权及数据权属', '客户验证情况', '供应商、采购与成本情况',
    '市场分析', '财务情况', '公司估值与投资方式', '退出方案', '风险提示与对策',
  ])
  const eligibleSections = content.sections.filter((section) => {
    if (!tableFriendlySections.has(section.title)) return false
    if ((section.tables?.length ?? 0) > 0) return true
    return section.findings.filter((finding) =>
      finding.sourceIndexes.length > 0 && finding.status === '资料记载').length >= 3
  }).length
  return Math.min(12, eligibleSections)
}

function assessBusinessDocumentTemplateFidelity(input: {
  type: AiBusinessTaskType
  templateSections: string[]
  content: BusinessContent
  quality: DocumentQualityResult
  generationMetadata: Record<string, unknown>
  complianceReview?: ComplianceOutputReview
  complianceContentReviewPassed?: boolean
  proposalReview?: InvestmentProposalOutputReview
}): TemplateFidelityAssessment {
  const quality = input.quality.metadata
  const exactSections = exactSectionOrder(input.content, input.templateSections)
  const contentAuditPassed = input.content.generationAudit?.reviewerPassed === true
  const expectedTableCount = input.content.sections.reduce(
    (count, section) => count + (section.tables?.length ?? 0),
    0,
  )

  if (input.type === 'compliance_statement') {
    const review = input.complianceReview
    const metadata = review?.metadata ?? {}
    return assessTemplateFidelity({ dimensions: {
      structure: [
        fidelityCheck('section-order', exactSections, true),
        fidelityCheck('outline', metadataFlag(metadata, 'outlineValidated'), true),
        fidelityCheck('numbering', metadataFlag(metadata, 'numberingValidated')),
      ],
      typography: [
        fidelityCheck('typography', metadataFlag(metadata, 'typographyValidated'), true),
        fidelityCheck('font-fallback', metadataFlag(metadata, 'fontFallbackAliasesValidated')),
        fidelityCheck('font-relationships', metadataFlag(metadata, 'fontEmbedRelationshipsValidated')),
        fidelityCheck('cjk-font', metadataFlag(quality, 'cjkFontValidated')),
      ],
      layout: [
        fidelityCheck('page-system', metadataFlag(metadata, 'pageSystemValidated'), true),
        fidelityCheck('template-parts', metadataFlag(metadata, 'templatePartsValidated')),
        fidelityCheck('relationship-closure', metadataFlag(metadata, 'relationshipClosureValidated')),
        fidelityCheck('a4-page', metadataFlag(quality, 'a4PageValidated')),
      ],
      tables: [
        fidelityCheck('template-table-count', Number(quality.tableCount ?? 0) === 0, true),
        fidelityCheck('no-unexpected-features', reviewHasNone(review, ['DOCX_UNEXPECTED_FEATURE'])),
      ],
      contentOrganization: [
        fidelityCheck('content-review', input.complianceContentReviewPassed === true, true),
        fidelityCheck('forbidden-content', metadataFlag(metadata, 'forbiddenContentValidated'), true),
        fidelityCheck('no-source-process-or-ai-style', reviewHasNone(review, [
          'DOCX_SOURCE_PROCESS_LEAK', 'DOCX_AI_STYLE_DRIFT', 'DOCX_TEXT_INVALID',
        ])),
      ],
    } })
  }

  if (input.type === 'investment_proposal') {
    const review = input.proposalReview
    const metadata = review?.metadata
    return assessTemplateFidelity({ dimensions: {
      structure: [
        fidelityCheck('section-order', exactSections, true),
        fidelityCheck(
          'section-tree',
          metadata !== undefined
            && metadata.foundSectionCount === metadata.expectedSectionCount,
          true,
        ),
        fidelityCheck('heading-levels', reviewHasNone(review, [
          'SECTION_TREE_MISMATCH', 'HEADING_STYLE_MISMATCH', 'HEADING3_FORBIDDEN',
        ])),
      ],
      typography: [
        fidelityCheck('title-and-heading-styles', reviewHasNone(review, ['TYPOGRAPHY_MISMATCH']), true),
        fidelityCheck('body-style', reviewHasNone(review, ['BODY_STYLE_MISMATCH']), true),
        fidelityCheck('spacing', reviewHasNone(review, ['ABNORMAL_TYPOGRAPHY_SPACING'])),
        fidelityCheck('cjk-font', metadataFlag(quality, 'cjkFontValidated')),
      ],
      layout: [
        fidelityCheck('page-geometry', metadata?.pageGeometryValidated === true, true),
        fidelityCheck('fixed-blocks', metadata?.fixedBlocksValidated === true, true),
        fidelityCheck('field-update', metadata?.updateFields === true),
        fidelityCheck('odd-even-header', metadata?.evenAndOddHeaders === true),
      ],
      tables: [
        fidelityCheck('table-count', reviewHasNone(review, ['TABLE_COUNT_MISMATCH']), true),
        fidelityCheck('table-format', reviewHasNone(review, ['TABLE_FORMAT_MISMATCH'])),
        fidelityCheck('table-geometry', reviewHasNone(review, ['TABLE_GEOMETRY_MISMATCH'])),
      ],
      contentOrganization: [
        fidelityCheck('content-review', contentAuditPassed, true),
        fidelityCheck('body-claims', metadata?.bodyClaimsValidated === true, true),
        fidelityCheck('no-client-or-ai-process-leak', reviewHasNone(review, [
          'INTERNAL_ERROR_TEXT_LEAK', 'SOURCE_PROCESS_WORDING_LEAK', 'AI_STYLE_BOILERPLATE',
          'CONVERSATIONAL_TRANSCRIPT_LEAK', 'FORMULAIC_ANALYSIS_WRAPPER',
          'GENERIC_NO_DATA_PREFACE', 'CLIENT_PROSE_LABEL_LEAK', 'CLIENT_COLON_LABEL_LEAK',
          'INLINE_NUMBERED_SUBHEADING_LEAK', 'INTERNAL_EVIDENCE_STATUS_TEXT_LEAK',
        ])),
      ],
    } })
  }

  if (input.type !== 'due_diligence_report') {
    throw new Error(`不支持的 DOCX 模板还原度任务：${input.type}`)
  }
  const coverage = input.content.generationAudit?.evidenceCoverage
  const coverageRatio = coverage?.totalLeafSections
    ? coverage.coveredLeafSections / coverage.totalLeafSections
    : 0
  const minimumPlannedTables = dueDiligenceMinimumPlannedTables(input.content)
  return assessTemplateFidelity({ dimensions: {
    structure: [
      fidelityCheck('section-order', exactSections, true),
      fidelityCheck('rendered-section-tree', metadataFlag(quality, 'sectionTreeValidated'), true),
      fidelityCheck('section-coverage', coverageRatio >= TEMPLATE_FIDELITY_MINIMUM),
    ],
    typography: [
      fidelityCheck('cjk-font', metadataFlag(quality, 'cjkFontValidated'), true),
      fidelityCheck('styles-part', metadataFlag(quality, 'stylesPartValidated'), true),
      fidelityCheck('font-table', metadataFlag(quality, 'fontTablePartValidated')),
      fidelityCheck(
        'template-typography-profile',
        Boolean(input.generationMetadata.typography),
      ),
    ],
    layout: [
      fidelityCheck('template-applied', input.generationMetadata.templateApplied === true, true),
      fidelityCheck('a4-page', metadataFlag(quality, 'a4PageValidated'), true),
      fidelityCheck('long-form-layout', input.generationMetadata.pageIntent === 'long-form'),
    ],
    tables: [
      fidelityCheck('rendered-table-count', metadataFlag(quality, 'expectedTableCountValidated'), true),
      fidelityCheck('planned-table-density', expectedTableCount >= minimumPlannedTables),
      fidelityCheck('editable-native-tables', Number(quality.tableCount ?? -1) === expectedTableCount),
    ],
    contentOrganization: [
      fidelityCheck('content-review', contentAuditPassed, true),
      fidelityCheck('no-reviewer-issues', (input.content.generationAudit?.reviewerIssueCodes.length ?? 1) === 0),
      fidelityCheck(
        'no-empty-sections',
        input.content.sections.every((section) =>
          section.findings.length > 0 || (section.tables?.length ?? 0) > 0),
      ),
    ],
  } })
}

function assessQaTemplateFidelity(input: {
  quality: DocumentQualityResult
  questionCount: number
  expectedQuestionCount: number
  categoryCount: number
  expectedCategoryCount: number
  reviewerStatus: string
}): TemplateFidelityAssessment {
  const metadata = input.quality.metadata
  const usesDirectQaLayout = [
    'lancheng_qa_a4_fixed',
    'qa_cn_formal_a4',
  ].includes(String(metadata.layoutProfile ?? ''))
  return assessTemplateFidelity({ dimensions: {
    structure: [
      fidelityCheck('question-count', input.questionCount === input.expectedQuestionCount, true),
      fidelityCheck('category-count', input.categoryCount === input.expectedCategoryCount, true),
      usesDirectQaLayout
        ? fidelityCheck('no-front-directory', metadataFlag(metadata, 'frontDirectoryAbsent'), true)
        : fidelityCheck('directory-before-body', metadataFlag(metadata, 'directoryCompleteBeforeBody'), true),
    ],
    typography: [
      fidelityCheck('cjk-font', metadataFlag(metadata, 'cjkFontValidated'), true),
      fidelityCheck('line-spacing', metadataFlag(metadata, 'lineSpacingValidated')),
      fidelityCheck('encoding', metadataFlag(metadata, 'encodingClean')),
    ],
    layout: [
      fidelityCheck('a4-and-margins', metadataFlag(metadata, 'pageGeometryValidated'), true),
      fidelityCheck('paragraph-range', metadataFlag(metadata, 'narrativeParagraphRangeValid')),
      fidelityCheck('openxml', metadataFlag(metadata, 'openXmlValid'), true),
    ],
    tables: [
      fidelityCheck('no-template-external-tables', Number(metadata.tableCount ?? -1) === 0, true),
      fidelityCheck('editable-text', metadataFlag(metadata, 'editableText')),
    ],
    contentOrganization: [
      fidelityCheck('reviewer', input.reviewerStatus.startsWith('passed'), true),
      fidelityCheck('natural-answer-form', metadataFlag(metadata, 'answerParagraphFormValid'), true),
      fidelityCheck(
        'concise-questions',
        Number(metadata.averageQuestionLength ?? Number.POSITIVE_INFINITY)
          <= PROJECT_QA_QUESTION_MAX_CHARACTERS,
        true,
      ),
      fidelityCheck(
        'substantive-answers',
        Number(metadata.averageAnswerLength ?? 0)
          >= PROJECT_QA_ANSWER_TARGET_MIN_CHARACTERS,
      ),
      fidelityCheck(
        'answer-question-ratio',
        Number(metadata.averageAnswerQuestionRatio ?? 0) >= 4,
      ),
      fidelityCheck('no-visible-process', metadataFlag(metadata, 'visibleSourceProcessAbsent'), true),
      fidelityCheck('no-placeholder', metadataFlag(metadata, 'placeholderAnswerAbsent')),
    ],
  } })
}

async function executeTask(taskId: string) {
  if (running.has(taskId)) return
  running.add(taskId)
  let rescheduleAfterRecovery = false
  try {
    const [task] = await db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).limit(1)
    if (!task || !isAiExecutableTaskType(task.type) || ['succeeded', 'cancelled'].includes(task.status)) return
    const parameters = (task.parameters ?? {}) as Record<string, unknown>
    const [retrySourceTask] = task.type === 'investment_recommendation_ppt' && task.retryOfTaskId
      ? await db.select({ progress: aiTasks.progress })
          .from(aiTasks)
          .where(eq(aiTasks.id, task.retryOfTaskId))
          .limit(1)
      : []
    const resumeProgressFloor = Math.max(
      0,
      Math.min(
        99,
        Math.max(
          Number(parameters._resumeProgressFloor ?? 0) || 0,
          task.type === 'investment_recommendation_ppt' && task.retryOfTaskId
            ? Number(retrySourceTask?.progress ?? 0) || 0
            : 0,
        ),
      ),
    )
    // 上传模板时会先创建正式任务记录，但模板分析完成前不能进入文档生成流水线。
    if (isTemplatePreparationPending(parameters)) return
    const resolvedCustomTemplate = (
      task.type === 'custom_template_document'
    )
      ? await resolveAiCustomTemplateForTask({
          userId: task.userId,
          projectId: task.projectId,
          conversationId: task.conversationId ?? undefined,
          templateId: String(parameters.customTemplateId || ''),
          taskType: task.type,
        })
      : undefined
    const template = resolvedCustomTemplate?.template ?? AI_TEMPLATE_CATALOG[task.type as AiBusinessTaskType]
    if (!template) throw new Error('AI 任务模板不存在')
    if (resolvedCustomTemplate) {
      const expectedOutputFormat = template.outputFormat.toUpperCase()
      if (parameters.outputFormat !== expectedOutputFormat) {
        throw Object.assign(new Error(`上传模板输出格式应为 ${expectedOutputFormat}`), {
          status: 409,
          code: 'CUSTOM_TEMPLATE_FORMAT_MISMATCH',
        })
      }
    } else {
      if (task.type !== 'investment_recommendation_ppt') {
        assertAiTemplateReferences(template)
      }
    }
    const skill = resolvedCustomTemplate?.skill ?? await loadAiSkill(
      AI_TEMPLATE_CATALOG[task.type as AiBusinessTaskType].skillName,
    )
    const pptWorkflow: InvestmentRecommendationPptWorkflow | undefined
      = task.type === 'investment_recommendation_ppt'
        ? await prepareInvestmentRecommendationPptWorkflow(template)
        : undefined
    let complianceBlueprint: ComplianceDocumentBlueprint | undefined
    if (task.type === 'compliance_statement') {
      await updateStage(taskId, '解析合规模板并建立 Blueprint', 6)
      complianceBlueprint = await parseComplianceDocumentBlueprint(template)
    }
    let proposalBlueprint: InvestmentProposalDocumentBlueprint | undefined
    if (task.type === 'investment_proposal') {
      await updateStage(taskId, '解析投资提案模板语料并建立 Document Blueprint', 6)
      proposalBlueprint = await loadInvestmentProposalBlueprint(template)
    }
    let qaTemplateProfile: QaTemplateProfile | undefined
    if (task.type === 'project_qa') {
      await updateStage(taskId, '加载 generate-project-qa-report 版式规范', 6)
      qaTemplateProfile = createProjectQaSkillProfile(skill)
    }
    const [claimed] = await db.update(aiTasks).set({
      status: 'running',
      stage: resumeProgressFloor > 0 ? '读取断点续跑检查点' : '读取项目资料',
      progress: Math.max(10, resumeProgressFloor),
      startedAt: task.startedAt ?? new Date(),
      errorId: null,
      errorMessage: null,
      updatedAt: new Date(),
    }).where(and(eq(aiTasks.id, taskId), eq(aiTasks.status, 'pending'))).returning()
    if (!claimed || await cancelIfRequested(taskId)) return

    const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1)
    if (!project) throw new Error('项目不存在或已删除')
    const attachmentsReady = await waitForRequestedAttachments(
      taskId,
      project.id,
      requestedAttachmentFileIds(parameters),
    )
    if (!attachmentsReady) {
      await cancelIfRequested(taskId)
      return
    }
    const sourceCutoffDate = String(parameters.sourceCutoffDate || new Date().toISOString().slice(0, 10))
    const knowledgeSources = await sourcesForProject(
      project.id,
      sourceCutoffDate,
      task.type === 'investment_proposal'
        ? 240
        : task.type === 'compliance_statement'
          ? 500
          : task.type === 'project_qa'
            ? 240
          : task.type === 'due_diligence_report'
            ? 500
          : task.type === 'custom_template_document'
              ? 80
          : task.type === 'investment_recommendation_ppt'
            ? 160
          : 40,
    )
    await updateStage(taskId, '整理当前项目资料库证据', 18)
    const userInstructions = typeof parameters.userInstructions === 'string'
      ? parameters.userInstructions.trim()
      : ''
    const researchIntent = typeof parameters.researchIntent === 'string'
      ? parameters.researchIntent.trim()
      : ''
    const rawSources: EvidenceSource[] = [
      ...knowledgeSources.filter((source) => evidenceSourceMatchesProject(source, project)),
      ...(project.updatedAt.toISOString().slice(0, 10) <= sourceCutoffDate ? [{
        sourceType: 'project_record',
        sourceId: project.id,
        sourceName: '项目档案',
        chunkIndex: 0,
        versionOrDate: project.updatedAt.toISOString().slice(0, 10),
        content: [
          `项目名称：${project.name}`,
          `公司主体：${project.companyName || '待核验'}`,
          `行业：${project.industry || '待核验'}`,
          `融资计划：${project.financing || '待核验'}`,
          `估值：${project.valuation || '待核验'}`,
          `项目概述：${project.summary || '待核验'}`,
          `商业模式：${project.businessModel || '待核验'}`,
          `市场：${project.market || '待核验'}`,
          `团队：${project.team || '待核验'}`,
        ].join('\n'),
      }] : []),
      ...(userInstructions ? [{
        sourceType: 'user_input',
        sourceName: '本次会话与用户补充输入',
        chunkIndex: 0,
        versionOrDate: sourceCutoffDate,
        content: userInstructions,
      }] : []),
    ]
    let evidenceScreening = screenEvidenceSources(rawSources, task.type)
    let sources = evidenceScreening.usable
    let complianceModelResearch: {
      agent?: DueDiligenceNetworkResearchAudit
      projectModel?: ComplianceModelResearchAudit
    } | undefined
    let dueDiligenceModelResearch: DueDiligenceNetworkResearchAudit | undefined
    let dueDiligencePageResearch: ProjectWebResearchAudit | undefined
    let sharedNetworkResearch: DueDiligenceNetworkResearchAudit | undefined
    let sharedModelResearch: ProjectWebResearchAudit | undefined
    let investmentRecommendationGapAgentResearch: DueDiligenceNetworkResearchAudit | undefined
    let investmentRecommendationGapPageResearch: ProjectWebResearchAudit | undefined
    let qaAgentResearch: DueDiligenceNetworkResearchAudit | undefined
    let qaModelResearch: ProjectQaModelResearchAudit | undefined
    let projectKnowledgeBrief: ProjectKnowledgeBrief | undefined
    if (task.type === 'compliance_statement') {
      const pendingTopics = complianceNetworkResearchTopics(sources, project, parameters)
      if (pendingTopics.length > 0) {
        await updateStage(taskId, '联网检索 Agent 补全公开证据', 22)
      }
      try {
        const research = await fetchDueDiligenceNetworkEvidence({
          project,
          sourceCutoffDate,
          pendingTopics,
          parameters,
          maxSources: 24,
        })
        complianceModelResearch = {
          ...complianceModelResearch,
          agent: research.audit,
        }
        if (research.sources.length > 0) {
          await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
            console.warn('[aiTask] 合规联网证据缓存失败，跳过缓存继续生成:', (error as Error).message)
          })
          rawSources.push(...research.sources)
          evidenceScreening = screenEvidenceSources(rawSources, task.type)
          sources = evidenceScreening.usable
        }
      } catch (error) {
        console.warn('[aiTask] 合规联网补充失败，使用项目资料继续生成:', (error as Error).message)
      }
      const remainingTopics = complianceNetworkResearchTopics(sources, project, parameters)
      if (remainingTopics.length > 0) {
        await updateStage(taskId, '项目大模型补全剩余公开证据', 24)
        try {
          const research = await fetchComplianceModelEvidence({
            project,
            sourceCutoffDate,
            missingSections: remainingTopics,
            parameters,
            maxSources: 24,
          })
          complianceModelResearch = {
            ...complianceModelResearch,
            projectModel: research.audit,
          }
          if (research.sources.length > 0) {
            await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
              console.warn('[aiTask] 合规项目大模型证据缓存失败，跳过缓存继续生成:', (error as Error).message)
            })
            rawSources.push(...research.sources)
            evidenceScreening = screenEvidenceSources(rawSources, task.type)
            sources = evidenceScreening.usable
          }
        } catch (error) {
          console.warn('[aiTask] 合规项目大模型补全失败，使用现有证据继续生成:', (error as Error).message)
        }
      }
    }
    if ([
      'investment_proposal',
      'investment_recommendation_ppt',
      'due_diligence_report',
      'custom_template_document',
    ].includes(task.type)) {
      let agentCandidates: EvidenceSource[] = []
      await updateStage(taskId, '联网检索 Agent 发现当前项目公开来源', 22)
      try {
        const research = await fetchDueDiligenceNetworkEvidence({
          project,
          sourceCutoffDate,
          pendingTopics: sharedInvestmentResearchTopics(task.type, project, parameters),
          parameters,
          maxSources: task.type === 'due_diligence_report'
            ? 24
            : task.type === 'investment_recommendation_ppt'
              ? 28
              : 18,
        })
        sharedNetworkResearch = research.audit
        agentCandidates = research.sources
      } catch (error) {
        console.warn('[aiTask] 联网检索 Agent 不可用，继续尝试页面核验与受控公开检索:', (error as Error).message)
      }

      await updateStage(taskId, 'LLM Gateway 补充检索并核验公开页面', 24)
      try {
        const research = await fetchVerifiedProjectWebEvidence({
          project,
          currentSources: sources,
          candidateSources: agentCandidates,
          sourceCutoffDate,
          parameters: {
            ...parameters,
            nativeModelSearch: true,
          },
          requestedTopics: task.type === 'investment_recommendation_ppt'
            ? investmentRecommendationWebTopicsForSources(sources, 12)
            : projectWebResearchTopicsForSources(
                sources,
                task.type === 'due_diligence_report' ? 8 : 6,
              ),
          allowIndustryContext: task.type === 'investment_recommendation_ppt',
          maxSources: task.type === 'due_diligence_report'
            ? 20
            : task.type === 'investment_recommendation_ppt'
              ? 24
              : 14,
        })
        sharedModelResearch = research.audit
        if (research.sources.length > 0) {
          await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
            console.warn('[aiTask] 已核验公开证据缓存失败，跳过缓存继续生成:', (error as Error).message)
          })
          rawSources.push(...research.sources)
          evidenceScreening = screenEvidenceSources(rawSources, task.type)
          sources = evidenceScreening.usable
        }
      } catch (error) {
        console.warn('[aiTask] LLM Gateway 页面核验失败，使用项目资料继续生成:', (error as Error).message)
      }
    }
    if (await cancelIfRequested(taskId)) return

    if ([
      'compliance_statement',
      'investment_proposal',
      'investment_recommendation_ppt',
      'due_diligence_report',
    ].includes(task.type)) {
      await updateStage(taskId, '深度研读项目资料并建立事实底稿', 26)
      projectKnowledgeBrief = await buildProjectKnowledgeBrief({
        project,
        sources,
        sourceCutoffDate,
      })
    }

    if (task.type === 'project_qa') {
      if (!qaTemplateProfile) throw new Error('Q&A 模板画像未生成')
      const qaMode: ProjectQaMode = parameters.qaMode === '尽调 Q&A'
        ? '尽调 Q&A'
        : '投资委员会 Q&A'
      const questionDepth: ProjectQaDepth = parameters.questionDepth === '深度版'
        ? '深度版'
        : '标准版'

      const qaTopics = projectQaResearchTopicsForSources(sources)
      let qaAgentCandidates: EvidenceSource[] = []
      await updateStage(taskId, '联网检索 Agent 发现当前项目公开来源', 22)
      try {
        const agentResearch = await fetchDueDiligenceNetworkEvidence({
          project,
          sourceCutoffDate,
          pendingTopics: [...new Set([
            ...sharedInvestmentResearchTopics(task.type, project, parameters),
            ...qaTopics.map((topic) => `${project.companyName || project.name} ${topic}`),
          ])].slice(0, 8),
          parameters,
          maxSources: questionDepth === '深度版' ? 24 : 18,
        })
        qaAgentResearch = agentResearch.audit
        qaAgentCandidates = agentResearch.sources
      } catch (error) {
        console.warn('[aiTask] Q&A 联网检索 Agent 不可用，继续尝试受控公开检索:', (error as Error).message)
      }
      await updateStage(taskId, '核验公开页面并补全项目证据', 24)
      try {
        const research = await fetchProjectQaModelEvidence({
          project,
          currentSources: sources,
          candidateSources: qaAgentCandidates,
          sourceCutoffDate,
          parameters,
          requestedTopics: qaTopics,
          maxSources: questionDepth === '深度版' ? 20 : 14,
        })
        qaModelResearch = research.audit
        if (research.sources.length > 0) {
          await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
            console.warn('[aiTask] Q&A 联网证据缓存失败，跳过缓存继续生成:', (error as Error).message)
          })
          rawSources.push(...research.sources)
          evidenceScreening = screenEvidenceSources(rawSources, task.type)
          sources = evidenceScreening.usable
        }
      } catch (error) {
        console.warn('[aiTask] Q&A 联网补充失败，使用项目资料继续生成:', (error as Error).message)
      }
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, '深度研读项目资料并建立事实底稿', 26)
      projectKnowledgeBrief = await buildProjectKnowledgeBrief({
        project,
        sources,
        sourceCutoffDate,
      })
      await updateStage(taskId, 'Question Generator 生成项目问题', 28)
      const duplicateCheck = await generateProjectQaQuestions({
        project,
        mode: qaMode,
        depth: questionDepth,
        sources,
        skill,
        userIntent: userInstructions || researchIntent,
        projectKnowledgeBrief,
      })
      if (duplicateCheck.questions.length === 0) {
        throw new Error('Question Generator 未生成有效问题')
      }
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, 'Duplicate Checker 去重', 40)
      await updateStage(taskId, '基于当前项目资料生成投资问答', 52)
      const draftAnswers = await generateProjectQaAnswers({
        project,
        mode: qaMode,
        questions: duplicateCheck.questions,
        sources,
        skill,
        userIntent: userInstructions || researchIntent,
        projectKnowledgeBrief,
      })
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, 'Reviewer 检查阶段建议与证据', 66)
      const reviewed = await reviewProjectQaAnswers({
        project,
        questions: duplicateCheck.questions,
        answers: draftAnswers,
        sources,
        duplicateCheck,
        skill,
      })
      const qaContent = buildProjectQaDocumentContent({
        project,
        mode: qaMode,
        depth: questionDepth,
        questions: duplicateCheck.questions,
        answers: reviewed.answers,
        review: reviewed.review,
      })
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, 'generate-project-qa-report 校验 Markdown 并生成 DOCX', 80)
      const taskDir = path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.id)
      await mkdir(taskDir, { recursive: true })
      const names = makeProjectQaFileNames(project.name, qaMode)
      const docxPath = path.join(taskDir, names.docx)
      const markdownPath = path.join(taskDir, '.generate-project-qa-report.md')
      const visualDirectory = path.join(taskDir, '.generate-project-qa-report-visual-qa')
      const qaDocument = await retryDocumentStep('Q&A DOCX 生成与质量检查', async () => {
        const generation = await generateProjectQaWithSkill({
          outputPath: docxPath,
          markdownPath,
          visualDirectory,
          projectName: project.companyName || project.name,
          content: qaContent,
          skill,
        })
        const quality = await inspectProjectQaDocx(docxPath, {
          questionCount: qaContent.questions.length,
          categoryCount: template.sections.length,
        })
        const templateFidelity = assessQaTemplateFidelity({
          quality,
          questionCount: Number(quality.metadata.questionCount ?? 0),
          expectedQuestionCount: qaContent.questions.length,
          categoryCount: Number(quality.metadata.categoryCount ?? 0),
          expectedCategoryCount: template.sections.length,
          reviewerStatus: reviewed.review.status,
        })
        if (!templateFidelity.passed) {
          throw new Error(
            `generate-project-qa-report 成品未通过模板一致性门禁：${
              templateFidelity.failedChecks.join('、')
            }`,
          )
        }
        return { generation, quality, templateFidelity }
      })
      const docxGeneration = qaDocument.generation
      const docxQuality = qaDocument.quality
      const templateFidelity = qaDocument.templateFidelity
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, '执行 DOCX 内容与版式质量检查', 92)
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(aiArtifacts)
        .where(and(
          eq(aiArtifacts.userId, task.userId),
          eq(aiArtifacts.projectId, task.projectId),
          eq(aiArtifacts.format, 'docx'),
        ))
      const version = Number(count ?? 0) + 1
      const sharedMetadata = {
        referenceTemplate: path.basename(template.referencePath),
        referenceTemplates: (template.referencePaths ?? [template.referencePath])
          .map((referencePath) => path.basename(referencePath)),
        templateCorpusSha256: qaTemplateProfile.corpusSha256,
        templateParserVersion: qaTemplateProfile.parserVersion,
        skillName: skill.name,
        skillVersion: skill.version,
        skillSha256: skill.sha256,
        qaMode,
        questionDepth,
        questionCount: qaContent.questions.length,
        categoryCount: template.sections.length,
        duplicateQuestionsRemoved: duplicateCheck.removed.length,
        reviewerStatus: reviewed.review.status,
        reviewerChecks: reviewed.review.checks,
        missingAnswerCount: reviewed.review.dataGapCount,
        rejectedEvidenceChunks: evidenceScreening.rejected.length,
        evidencePolicy: 'project_knowledge_primary_model_network_supplement',
        projectKnowledgeSourceCount: sources.filter((source) =>
          source.sourceType !== 'project_record'
          && source.sourceType !== 'user_input'
          && !source.sourceType.startsWith('public_web')).length,
        modelNetworkResearch: {
          agent: qaAgentResearch,
          verifiedPages: qaModelResearch,
        },
        networkEvidenceSourceCount: sources.filter((source) =>
          source.sourceType === 'public_web_llm').length,
        projectRecordSourceCount: sources.filter((source) =>
          source.sourceType === 'project_record').length,
        userInputSourceCount: sources.filter((source) =>
          source.sourceType === 'user_input').length,
        visibleReferencesIncluded: false,
        visibleReviewerIncluded: false,
        downloadableFormats: ['docx'],
        projectKnowledgeStudy: projectKnowledgeBrief?.audit,
        templateFidelityTarget: TEMPLATE_FIDELITY_MINIMUM,
        templateFidelity,
      }
      const [qaArtifact] = await db.insert(aiArtifacts).values({
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: names.docx,
        format: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        version,
        storagePath: docxPath,
        editableLevel: 'core-content',
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: docxQuality.qualityStatus,
        metadata: {
          ...docxQuality.metadata,
          ...docxGeneration,
          ...sharedMetadata,
        },
      }).returning()
      const usedSourceIndexes = usedProjectQaSourceIndexes(reviewed.answers, sources.length)
      if (usedSourceIndexes.length) {
        await db.insert(aiTaskSources).values(usedSourceIndexes.map((index) => {
          const source = sources[index]
          return {
            taskId: task.id,
            artifactId: qaArtifact.id,
            sourceType: source.sourceType,
            sourceId: source.sourceType.startsWith('public_web')
              ? createHash('sha256')
                  .update(source.sourceId || source.sourceName)
                  .digest('hex')
                  .slice(0, 64)
              : source.sourceId,
            sourceName: source.sourceName,
            locator: source.locator || `知识片段 ${source.chunkIndex ?? index}`,
            verificationStatus: source.sourceType.startsWith('public_web')
              ? '页面已核验，事实待交叉核验'
              : '资料记载',
          }
        })).catch((error) => {
          console.warn('[aiTask] Q&A 来源审计写入未完成，保留已生成 DOCX:', (error as Error).message)
        })
      }
      await db.update(aiTasks).set({
        status: 'succeeded',
        stage: 'DOCX 已生成',
        progress: 100,
        resultSummary: qaContent.executiveSummary,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(aiTasks.id, taskId))
      const [userRow] = await db.select().from(users).where(eq(users.id, task.userId)).limit(1)
      if (userRow) {
        await writeTaskAudit(
          { uid: userRow.id, name: userRow.name, role: userRow.role },
          '生成业务材料',
          `${qaMode}：${project.name}`,
        ).catch((error) => {
          console.warn('[aiTask] Q&A 操作审计写入未完成，保留已生成 DOCX:', (error as Error).message)
        })
      }
      return
    }

    const taskDir = path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.id)
    await mkdir(taskDir, { recursive: true })
    const proposalCheckpointPath = path.join(taskDir, '.investment-proposal-checkpoint.json')
    const retryCheckpointPath = task.retryOfTaskId
      ? path.join(
          ARTIFACT_ROOT,
          task.userId,
          task.projectId,
          task.retryOfTaskId,
          '.investment-proposal-checkpoint.json',
        )
      : undefined
    const investmentRecommendationResumeDirectory
      = task.type === 'investment_recommendation_ppt'
        ? task.retryOfTaskId
          ? path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.retryOfTaskId)
          : taskDir
        : undefined
    const investmentRecommendationCheckpointPath = path.join(
      taskDir,
      '.investment-recommendation-checkpoint.json',
    )
    const investmentRecommendationResume = task.type === 'investment_recommendation_ppt'
      ? await loadInvestmentRecommendationResumeCheckpoint(
          investmentRecommendationResumeDirectory,
          sources,
        )
      : undefined
    let checkpointWrite = Promise.resolve()
    let progressWrite = Promise.resolve()
    let proposalProgress = 35
    const dueDiligenceRuntime = (startProgress: number, endProgress: number) => ({
      timeoutMs: Number(process.env.AI_DUE_DILIGENCE_CHAPTER_TIMEOUT_MS || 120_000),
      concurrency: Number(process.env.AI_DUE_DILIGENCE_CHAPTER_CONCURRENCY || 3),
      maxGenerationAttempts: 2,
      onProgress: async (event: {
        chapterTitle: string
        chapterIndex: number
        chapterCount: number
        completedChapters: number
        phase: 'generating' | 'regenerating' | 'completed' | 'limited'
      }) => {
        const progress = Math.min(
          endProgress,
          startProgress + Math.round(
            (event.completedChapters / Math.max(1, event.chapterCount))
            * (endProgress - startProgress),
          ),
        )
        const phaseLabel = event.phase === 'regenerating'
          ? '重试受影响章节'
          : event.phase === 'completed'
            ? '章节生成完成'
            : event.phase === 'limited'
              ? '章节已使用受限内容'
              : '分章生成尽调正文'
        const stage = `${phaseLabel}（${event.chapterIndex + 1}/${event.chapterCount}）${event.chapterTitle}`
          .slice(0, 64)
        progressWrite = progressWrite.then(() => updateStage(taskId, stage, progress))
        await progressWrite
      },
    })

    let complianceWorkflow: ComplianceWorkflowResult | undefined
    let content: BusinessContent
    if (task.type === 'compliance_statement') {
      if (!complianceBlueprint) throw new Error('合规性说明缺少Document Blueprint')
      await updateStage(taskId, '建立章节级 Evidence', 25)
      await updateStage(taskId, '逐章节生成并执行 Reviewer', 35)
      complianceWorkflow = await composeComplianceStatement({
        template,
        skill,
        blueprint: complianceBlueprint,
        project,
        sources,
        sourceCutoffDate,
        parameters,
        projectKnowledgeBrief,
      })
      content = complianceWorkflow.content
    } else {
    await updateStage(
      taskId,
      investmentRecommendationResume
        ? '断点续跑：恢复已完成的投资建议书内容'
        : task.type === 'investment_proposal'
          ? '建立章节级 Evidence 并逐章节生成、执行 Reviewer'
          : task.type === 'custom_template_document'
            ? '基于项目资料与已核验联网证据重建标题和正文'
            : '生成结构化内容',
      investmentRecommendationResume ? 68 : 35,
    )
      const composeInitialContent = () => composeBusinessContent({
          type: task.type as AiExecutableTaskType,
          template,
          skill,
          project,
          sources,
          sourceCutoffDate,
          parameters,
          projectKnowledgeBrief,
          investmentRecommendationPass: task.type === 'investment_recommendation_ppt'
            ? 'gap-analysis'
            : undefined,
          // 投资建议书首轮只识别逐章缺口；联网补全后再执行最终专业性门禁。
          dueDiligencePass: task.type === 'due_diligence_report' ? 'final' : undefined,
          dueDiligenceRuntime: task.type === 'due_diligence_report'
            ? dueDiligenceRuntime(35, 49)
            : undefined,
          investmentProposalRuntime: task.type === 'investment_proposal'
            ? {
              timeoutMs: Number(process.env.AI_INVESTMENT_PROPOSAL_TIMEOUT_MS || 75_000),
              concurrency: Number(process.env.AI_PROPOSAL_CHAPTER_CONCURRENCY || 3),
              maxRequestAttempts: 1,
              maxGenerationAttempts: 1,
              loadCheckpoint: async () => {
                for (const checkpointPath of [
                  proposalCheckpointPath,
                  retryCheckpointPath,
                ].filter((value): value is string => Boolean(value))) {
                  try {
                    return JSON.parse(await readFile(checkpointPath, 'utf8')) as unknown
                  } catch {
                    // 当前任务首次执行或旧任务没有检查点时，从头开始生成。
                  }
                }
                return undefined
              },
              saveCheckpoint: async (checkpoint) => {
                checkpointWrite = checkpointWrite.then(async () => {
                  const temporaryPath = `${proposalCheckpointPath}.${randomUUID()}.tmp`
                  await writeFile(temporaryPath, JSON.stringify(checkpoint), 'utf8')
                  await rename(temporaryPath, proposalCheckpointPath)
                })
                await checkpointWrite
              },
              onProgress: async (event) => {
                const completedProgress = 35 + Math.round(
                  (event.completedChapters / Math.max(1, event.chapterCount)) * 32,
                )
                proposalProgress = Math.max(proposalProgress, Math.min(completedProgress, 67))
                const phaseLabel = event.phase === 'resumed'
                  ? '恢复已完成章节'
                  : event.phase === 'reviewing'
                    ? 'Reviewer 检查章节'
                    : event.phase === 'regenerating'
                      ? '按 Reviewer 意见重生章节'
                      : event.phase === 'completed'
                        ? '章节生成与 Reviewer 完成'
                        : event.phase === 'heartbeat'
                          ? '模型正在生成章节'
                          : '生成章节'
                const requestLabel = event.requestAttempt && event.requestAttempt > 1
                  ? `，请求重试${event.requestAttempt}`
                  : ''
                const waitLabel = event.phase === 'heartbeat' && event.elapsedMs
                  ? `，已等待${Math.max(1, Math.round(event.elapsedMs / 1000))}秒`
                  : ''
                const stage = `${phaseLabel}（${event.chapterIndex + 1}/${event.chapterCount}）${event.chapterTitle}${requestLabel}${waitLabel}`
                  .slice(0, 64)
                progressWrite = progressWrite.then(() =>
                  updateStage(taskId, stage, proposalProgress))
                await progressWrite
              },
              }
            : undefined,
        })
      content = investmentRecommendationResume
        ? investmentRecommendationResume.content
        : task.type === 'due_diligence_report'
          ? await withTaskHeartbeat(taskId, composeInitialContent, {
              startProgress: 35,
              endProgress: 49,
              stage: (elapsedSeconds) =>
                `大模型正在分章生成尽调正文（已等待 ${elapsedSeconds} 秒）`,
            })
          : task.type === 'investment_recommendation_ppt'
            ? await withTaskHeartbeat(taskId, composeInitialContent, {
                startProgress: 35,
                endProgress: 48,
                stage: (elapsedSeconds) =>
                  `大模型正在生成投资建议书初稿（已等待 ${elapsedSeconds} 秒）`,
              })
            : await composeInitialContent()
      if (task.type === 'due_diligence_report') {
        const pendingTopics = dueDiligencePendingResearchTopics(content)
        if (pendingTopics.length > 0) {
          let agentCandidates: EvidenceSource[] = []
          await updateStage(taskId, '联网检索 Agent 发现待核验事项来源', 52)
          try {
            const research = await fetchDueDiligenceNetworkEvidence({
              project,
              sourceCutoffDate,
              pendingTopics,
              parameters,
              maxSources: 20,
            })
            dueDiligenceModelResearch = research.audit
            agentCandidates = research.sources
          } catch (error) {
            console.warn('[aiTask] 尽调待核验事项来源发现失败，继续生成受限报告:', (error as Error).message)
          }

          await updateStage(taskId, 'LLM Gateway 核验待核验事项公开页面', 55)
          try {
            const research = await fetchVerifiedProjectWebEvidence({
              project,
              currentSources: sources,
              candidateSources: agentCandidates,
              sourceCutoffDate,
              parameters: {
                ...parameters,
                nativeModelSearch: true,
              },
              requestedTopics: projectWebResearchTopicsForSources(sources, 8),
              maxSources: 16,
            })
            dueDiligencePageResearch = research.audit
            if (research.sources.length > 0) {
              await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
                console.warn('[aiTask] 尽调已核验公开证据缓存失败，跳过缓存继续生成:', (error as Error).message)
              })
              rawSources.push(...research.sources)
              evidenceScreening = screenEvidenceSources(rawSources, task.type)
              sources = evidenceScreening.usable
            }
          } catch (error) {
            console.warn('[aiTask] 尽调公开页面核验失败，使用现有证据继续生成:', (error as Error).message)
          }

          await updateStage(taskId, '使用本地与联网证据重新生成尽调内容', 58)
          projectKnowledgeBrief = await buildProjectKnowledgeBrief({
            project,
            sources,
            sourceCutoffDate,
          })
          content = await withTaskHeartbeat(
            taskId,
            () => composeBusinessContent({
              type: task.type as AiExecutableTaskType,
              template,
              skill,
              project,
              sources,
              sourceCutoffDate,
              parameters,
              projectKnowledgeBrief,
              dueDiligencePass: 'final',
              dueDiligenceRuntime: dueDiligenceRuntime(58, 66),
            }),
            {
              startProgress: 58,
              endProgress: 66,
              stage: (elapsedSeconds) =>
                `大模型正在分章整合联网证据（已等待 ${elapsedSeconds} 秒）`,
            },
          )
          content = annotateDueDiligencePendingAfterResearch(
            content,
            dueDiligencePageResearch?.status
              ?? dueDiligenceModelResearch?.status
              ?? 'unavailable',
          )
        }
      }
      if (task.type === 'investment_recommendation_ppt' && !investmentRecommendationResume) {
        const pendingTopics = investmentRecommendationPendingResearchTopics(content)
        if (pendingTopics.length > 0) {
          let agentCandidates: EvidenceSource[] = []
          await updateStage(taskId, '识别内容缺口并定向联网检索', 50)
          try {
            const research = await fetchDueDiligenceNetworkEvidence({
              project,
              sourceCutoffDate,
              pendingTopics,
              parameters,
              maxSources: 24,
            })
            investmentRecommendationGapAgentResearch = research.audit
            agentCandidates = research.sources
          } catch (error) {
            console.warn(
              '[aiTask] 投资建议书缺口来源发现失败，继续使用已核验证据:',
              (error as Error).message,
            )
          }

          await updateStage(taskId, '核验市场、竞品及项目缺口网页', 54)
          try {
            const research = await fetchVerifiedProjectWebEvidence({
              project,
              currentSources: sources,
              candidateSources: agentCandidates,
              sourceCutoffDate,
              parameters: {
                ...parameters,
                nativeModelSearch: true,
              },
              requestedTopics: investmentRecommendationWebTopicsForSources(sources, 12),
              maxSources: 24,
              allowIndustryContext: true,
            })
            investmentRecommendationGapPageResearch = research.audit
            if (research.sources.length > 0) {
              await cacheProjectNetworkEvidence(project.id, research.sources).catch((error) => {
                console.warn(
                  '[aiTask] 投资建议书缺口证据缓存失败，跳过缓存继续生成:',
                  (error as Error).message,
                )
              })
              rawSources.push(...research.sources)
              evidenceScreening = screenEvidenceSources(rawSources, task.type)
              sources = evidenceScreening.usable
            }
          } catch (error) {
            console.warn(
              '[aiTask] 投资建议书缺口页面核验失败，使用首轮已核验证据继续生成:',
              (error as Error).message,
            )
          }
        }
        await updateStage(taskId, '按章节整合证据并执行投资专业性检查', 58)
        projectKnowledgeBrief = await buildProjectKnowledgeBrief({
          project,
          sources,
          sourceCutoffDate,
        })
        content = await withTaskHeartbeat(
          taskId,
          () => composeBusinessContent({
            type: task.type as AiExecutableTaskType,
            template,
            skill,
            project,
            sources,
            sourceCutoffDate,
            parameters,
            projectKnowledgeBrief,
            investmentRecommendationPass: 'final',
          }),
          {
            startProgress: 58,
            endProgress: 66,
            stage: (elapsedSeconds) =>
              `大模型正在逐章重写并复核投资建议书（已等待 ${elapsedSeconds} 秒）`,
          },
        )
      }
    }
    if (evidenceScreening.rejected.length && task.type !== 'custom_template_document') {
      const affectedFiles = [...new Set(evidenceScreening.rejected.map((item) => item.sourceName))]
      content.missing = dedupeTextList([
        ...content.missing,
        `有 ${evidenceScreening.rejected.length} 个重复、测试、占位或损坏的知识片段未用于正文；如其中包含有效资料，请重新上传原文件：${affectedFiles.slice(0, 5).join('、')}`,
      ], { limit: 8 })
    }
    if (task.type === 'investment_recommendation_ppt') {
      await saveInvestmentRecommendationCheckpoint({
        checkpointPath: investmentRecommendationCheckpointPath,
        content,
        sources,
      })
    }
    if (await cancelIfRequested(taskId)) return

    await updateStage(
      taskId,
      template.outputFormat === 'pptx'
        ? task.type === 'investment_recommendation_ppt'
          ? '先生成图片高保真版，再继续生成可编辑版'
          : '生成可编辑 PPTX'
        : task.type === 'compliance_statement'
          ? 'Formatter 生成 Word'
          : task.type === 'investment_proposal'
            ? 'Formatter 按 Document Blueprint 生成 Word'
          : '生成 DOCX',
      68,
    )
    const fileName = makeArtifactFileName(
      project.name,
      template,
      Date.now(),
      task.type === 'custom_template_document' ? content.title : undefined,
    )
    const outputPath = path.join(taskDir, fileName)
    let imageDeckArtifactVersion: number | undefined
    const publishImageDeck = async (imageDeck: {
      path: string
      slideCount: number
      bytes: number
      sha256: string
      metadata: Record<string, unknown>
    }) => {
      if (task.type !== 'investment_recommendation_ppt') return
      const imageDeckFileName = fileName.replace(/\.pptx$/i, '_图片高保真版.pptx')
      const existingArtifacts = await db.select().from(aiArtifacts)
        .where(and(
          eq(aiArtifacts.taskId, task.id),
          sql`(${aiArtifacts.metadata}->>'artifactStage' = 'image-deck' or ${aiArtifacts.editableLevel} = 'image')`,
        ))
        .orderBy(desc(aiArtifacts.createdAt))
        .limit(1)
      const existingArtifact = existingArtifacts[0]
      if (existingArtifact) {
        imageDeckArtifactVersion = existingArtifact.version
        return
      }
      const imageDeckPath = path.join(taskDir, imageDeckFileName)
      await copyFile(imageDeck.path, imageDeckPath)
      const copiedStat = await stat(imageDeckPath)
      if (!copiedStat.isFile() || copiedStat.size !== imageDeck.bytes) {
        throw Object.assign(
          new Error('图片高保真版复制后文件校验不一致'),
          { code: 'IMAGE_DECK_ARTIFACT_COPY_MISMATCH' },
        )
      }
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
        .from(aiArtifacts)
        .where(and(
          eq(aiArtifacts.userId, task.userId),
          eq(aiArtifacts.projectId, task.projectId),
          eq(aiArtifacts.format, 'pptx'),
        ))
      imageDeckArtifactVersion = Number(count ?? 0) + 1
      await db.insert(aiArtifacts).values({
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: imageDeckFileName,
        format: 'pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        version: imageDeckArtifactVersion,
        storagePath: imageDeckPath,
        editableLevel: 'image',
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: 'passed',
        metadata: {
          ...imageDeck.metadata,
          artifactStage: 'image-deck',
          artifactLabel: '图片高保真版',
          editableScope: 'image',
          slideCount: imageDeck.slideCount,
          bytes: copiedStat.size,
          sha256: imageDeck.sha256,
          encodingClean: true,
          qualityGate: 'image-generation-and-package',
          availableWhileTaskRunning: true,
        },
      })
      await updateStage(
        taskId,
        '图片高保真版已完成，可先下载；可编辑版继续生成中',
        78,
      )
    }
    let previewPath: string | undefined
    let previewMetadata: Record<string, unknown> | undefined
    let complianceDocxReview: ComplianceOutputReview | undefined
    let proposalDocxReview: InvestmentProposalOutputReview | undefined
    let proposalSkillValidation: Awaited<ReturnType<typeof validateInvestmentProposalWithSkill>>
      | { passed: false; code: string }
      | undefined
    let pptWorkflowReview: Awaited<ReturnType<typeof reviewInvestmentRecommendationPpt>> | undefined
    const pptGenerationAudit = pptWorkflow
      ? buildInvestmentRecommendationGenerationAudit({
          workflow: pptWorkflow,
          content,
          sources,
        })
      : undefined
    let generationMetadata = template.outputFormat === 'pptx'
      ? await (async () => {
        const result = await generateBusinessPptx({
          outputPath,
          template,
          project,
          content,
          sources,
          sourceCutoffDate,
          pageCount: String(parameters.pageCount || '15'),
          resumeFromDirectory: investmentRecommendationResumeDirectory,
          onProgress: ({ stage, progress }) =>
            updateStage(taskId, stage, progress),
          onImageDeckReady: publishImageDeck,
        })
        previewPath = outputPath.replace(/\.pptx$/i, '.preview.png')
        try {
          previewMetadata = await generateBusinessPptxPreview({
            outputPath: previewPath,
            template,
            project,
            content,
            sourceCutoffDate,
          })
        } catch (error) {
          previewPath = undefined
          console.warn('[aiTask] PPT 预览生成失败，继续交付 PPTX:', (error as Error).message)
        }
        if (pptWorkflow) {
          try {
            pptWorkflowReview = await reviewInvestmentRecommendationPpt({
              outputPath,
              projectName: project.name,
              disclaimer: template.disclaimer,
              workflow: pptWorkflow,
              template,
            })
            if (!pptWorkflowReview.passed) {
              throw Object.assign(
                new Error(
                  `投资建议书未通过 Gorden 可编辑分层 Reviewer：${pptWorkflowReview.issueCodes.join('、')}`,
                ),
                { code: 'INVESTMENT_RECOMMENDATION_CONTENT_REJECTED' },
              )
            }
          } catch (error) {
            if (
              (error as Error & { code?: string }).code
              === 'INVESTMENT_RECOMMENDATION_CONTENT_REJECTED'
            ) {
              throw error
            }
            console.warn(
              '[aiTask] 投资建议书 PPT Gorden Reviewer 执行失败，保留可编辑 PPTX:',
              (error as Error).message,
            )
          }
        }
        return result
      })()
      : await retryDocumentStep('DOCX Formatter', () => generateBusinessDocx({
          outputPath,
          template,
          project,
          content,
          sourceCutoffDate,
          sources,
          blueprint: complianceBlueprint,
        }))
    if (await cancelIfRequested(taskId)) return

    if (task.type === 'investment_proposal') {
      if (!proposalBlueprint) throw new Error('投资提案缺少 Document Blueprint')
      await updateStage(taskId, 'Reviewer 检查 Word 章节、固定内容、引用及格式', 76)
      try {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          proposalDocxReview = await reviewInvestmentProposalDocx({
            filePath: outputPath,
            template,
            blueprint: proposalBlueprint,
            content,
            projectName: project.name,
          })
          if (proposalDocxReview.passed) break
          if (attempt === 1) {
            generationMetadata = await generateBusinessDocx({
              outputPath,
              template,
              project,
              content,
              sourceCutoffDate,
              sources,
            })
          }
        }
      } catch (error) {
        console.warn('[aiTask] 投资提案 Word Reviewer 执行失败，保留已生成 Word:', (error as Error).message)
      }
      if (!proposalDocxReview?.passed) {
        console.warn(
          '[aiTask] 投资提案 Word Reviewer 未完全通过，按受限初稿继续交付:',
          proposalDocxReview?.issues
            .map((issue) => `${issue.code}:${issue.message}`)
            .join('；') || 'Reviewer 未返回结果',
        )
      }
    }

    if (task.type === 'compliance_statement') {
      if (!complianceBlueprint) throw new Error('合规性说明缺少Document Blueprint')
      await updateStage(taskId, 'Reviewer 检查 Word 结构与格式', 76)
      try {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          complianceDocxReview = await reviewGeneratedComplianceDocx({
            filePath: outputPath,
            template,
            blueprint: complianceBlueprint,
            content,
            projectName: project.name,
          })
          if (complianceDocxReview.passed) break
          if (attempt === 1) {
            generationMetadata = await generateBusinessDocx({
              outputPath,
              template,
              project,
              content,
              sourceCutoffDate,
              sources,
              blueprint: complianceBlueprint,
            })
          }
        }
      } catch (error) {
        console.warn('[aiTask] 合规性说明 Word Reviewer 执行失败，保留已生成 Word:', (error as Error).message)
      }
      if (!complianceDocxReview?.passed) {
        console.warn(
          '[aiTask] 合规性说明 Word Reviewer 未完全通过，按初稿继续交付:',
          complianceDocxReview?.issues
            .map((issue) => `${issue.code}:${issue.message}`)
            .join('；') || 'Reviewer 未返回结果',
        )
      }
    }
    await updateStage(taskId, '执行最终可编辑文件质量检查', 98)
    const qualityOptions = {
      // 合规性说明核心规范禁止“引用资料”等模板外正文板块；来源只保留在
      // ai_task_sources 与产物元数据中。尽调报告也按用户要求不显示文末来源。
      requireEndReferences: task.type !== 'compliance_statement'
        && task.type !== 'due_diligence_report'
        && task.type !== 'investment_proposal',
      // Gorden 依据上传模板生成新的四层可编辑 PPTX；模板分析结果中仍可能
      // 保留原始字体或语言元数据，因此质量检查允许继承的 CJK 元数据。
      allowInheritedCjkLanguageMetadata:
        task.type === 'investment_recommendation_ppt',
      expectedSectionTitles: task.type === 'due_diligence_report'
        ? template.sections
        : undefined,
      expectedTableCount: task.type === 'due_diligence_report'
        ? content.sections.reduce(
            (count, section) => count + (section.tables?.length ?? 0),
            0,
          )
        : undefined,
    }
    let quality: Awaited<ReturnType<typeof inspectGeneratedArtifact>>
    try {
      quality = await inspectGeneratedArtifact(
        outputPath,
        template.outputFormat as 'docx' | 'pptx',
        qualityOptions,
      )
    } catch (error) {
      if (template.outputFormat !== 'docx') throw error
      console.warn('[aiTask] DOCX 首次质量检查未通过，重新生成主文档:', (error as Error).message)
      generationMetadata = await retryDocumentStep('DOCX 质量恢复生成', () =>
        generateBusinessDocx({
          outputPath,
          template,
          project,
          content,
          sourceCutoffDate,
          sources,
          blueprint: complianceBlueprint,
        }))
      quality = await inspectGeneratedArtifact(outputPath, 'docx', qualityOptions)
    }
    const calculateTemplateFidelity = () => [
        'compliance_statement',
        'investment_proposal',
        'due_diligence_report',
      ].includes(task.type)
        ? assessBusinessDocumentTemplateFidelity({
          type: task.type as AiBusinessTaskType,
          templateSections: template.sections,
          content,
          quality,
          generationMetadata: generationMetadata as Record<string, unknown>,
          complianceReview: complianceDocxReview,
          complianceContentReviewPassed:
            complianceWorkflow?.reviewReports.at(-1)?.passed,
          proposalReview: proposalDocxReview,
        })
        : undefined
    let templateFidelity = calculateTemplateFidelity()
    if (templateFidelity && !templateFidelity.passed) {
      await updateStage(taskId, '按模板差异自动修订文档', 94)
      generationMetadata = await retryDocumentStep('模板还原度恢复生成', () =>
        generateBusinessDocx({
          outputPath,
          template,
          project,
          content,
          sourceCutoffDate,
          sources,
          blueprint: complianceBlueprint,
        }))
      quality = await inspectGeneratedArtifact(outputPath, 'docx', qualityOptions)
      if (task.type === 'compliance_statement' && complianceBlueprint) {
        complianceDocxReview = await reviewGeneratedComplianceDocx({
          filePath: outputPath,
          template,
          blueprint: complianceBlueprint,
          content,
          projectName: project.name,
        })
      }
      if (task.type === 'investment_proposal' && proposalBlueprint) {
        proposalDocxReview = await reviewInvestmentProposalDocx({
          filePath: outputPath,
          template,
          blueprint: proposalBlueprint,
          content,
          projectName: project.name,
        })
      }
      templateFidelity = calculateTemplateFidelity()
    }
    if (templateFidelity && !templateFidelity.passed) {
      console.warn(
        '[aiTask] 文档模板还原度未达到目标，保留已通过 OpenXML 检查的 DOCX 并记录质量限制:',
        JSON.stringify(templateFidelity.failedChecks),
      )
    }
    if (task.type === 'investment_proposal') {
      try {
        proposalSkillValidation = await validateInvestmentProposalWithSkill(outputPath)
      } catch (error) {
        const code = (error as Error & { code?: string }).code
          ?? 'INVESTMENT_PROPOSAL_SKILL_VALIDATION_UNAVAILABLE'
        proposalSkillValidation = { passed: false, code }
        console.warn(
          '[aiTask] draft-investment-proposal 原生成品校验未通过，保留已通过 OpenXML Reviewer 的 DOCX:',
          (error as Error).message,
        )
      }
    }
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(aiArtifacts)
      .where(and(eq(aiArtifacts.userId, task.userId), eq(aiArtifacts.projectId, task.projectId), eq(aiArtifacts.format, template.outputFormat)))
    const version = imageDeckArtifactVersion ?? Number(count ?? 0) + 1
    const [artifact] = await db.insert(aiArtifacts).values({
      taskId: task.id,
      userId: task.userId,
      projectId: task.projectId,
      conversationId: task.conversationId,
      fileName,
      format: template.outputFormat,
      mimeType: template.outputFormat === 'pptx'
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      version,
      storagePath: outputPath,
      editableLevel: task.type === 'investment_recommendation_ppt'
        ? 'all'
        : template.editableLevel,
      sourceCutoffDate,
      templateVersion: template.templateVersion,
      qualityStatus: quality.qualityStatus,
      metadata: {
        ...quality.metadata,
        ...generationMetadata,
        ...(task.type === 'investment_recommendation_ppt'
          ? {
              artifactStage: 'editable',
              artifactLabel: '元素级可编辑版',
              editableScope: 'all',
              intermediateDeliverable: false,
              generationContinues: false,
              generationSkill: 'create-reference-driven-editable-ppt',
              qualityGate: 'pipeline-handoff-and-final-artifact',
            }
          : {}),
        projectKnowledgeStudy: projectKnowledgeBrief?.audit,
        templateFidelityTarget: templateFidelity?.target ?? TEMPLATE_FIDELITY_MINIMUM,
        ...(templateFidelity ? { templateFidelity } : {}),
        evidencePolicy: task.type === 'compliance_statement'
          ? 'project_knowledge_primary_model_network_supplement'
          : [
              'investment_proposal',
              'investment_recommendation_ppt',
              'due_diligence_report',
              'custom_template_document',
            ].includes(task.type)
            ? 'project_knowledge_primary_flue_discovery_llm_page_verification'
            : 'project_knowledge_primary_flue_network_supplement',
        ...(complianceModelResearch
          || dueDiligenceModelResearch
          || dueDiligencePageResearch
          || sharedNetworkResearch
          || sharedModelResearch
          || investmentRecommendationGapAgentResearch
          || investmentRecommendationGapPageResearch
          ? {
              projectModelNetworkSupplement:
                complianceModelResearch
                ?? {
                  initial: {
                    agentDiscovery: sharedNetworkResearch,
                    pageVerification: sharedModelResearch,
                  },
                  gapCompletion: {
                    agentDiscovery: dueDiligenceModelResearch
                      ?? investmentRecommendationGapAgentResearch,
                    pageVerification: dueDiligencePageResearch
                      ?? investmentRecommendationGapPageResearch,
                  },
                },
            }
          : {}),
        ...(complianceBlueprint
          ? complianceBlueprintMetadata(complianceBlueprint)
          : {}),
        ...(complianceWorkflow
          ? {
              generationMode: complianceWorkflow.generationMode,
              reviewerRegenerationRounds: complianceWorkflow.reviewerRegenerationRounds,
              contentReviewPassed: complianceWorkflow.reviewReports.at(-1)?.passed ?? false,
              contentReviewAttempts: complianceWorkflow.reviewReports.length,
              contentReviewIssueCounts: complianceWorkflow.reviewReports.map((report) => report.issueCount),
              chapterEvidence: complianceWorkflow.evidencePackets.map((packet) => ({
                sectionTitle: packet.sectionTitle,
                sourceIndexes: packet.sourceIndexes,
                evidenceItemCount: packet.items.length,
              })),
            }
          : {}),
        ...(complianceDocxReview
          ? {
              wordReviewerPassed: complianceDocxReview.passed,
              wordReview: complianceDocxReview.metadata,
            }
          : {}),
        ...(proposalBlueprint
          ? {
              blueprintVersion: proposalBlueprint.version,
              coreStandardSha256: proposalBlueprint.coreStandardSha256,
              templateCorpusSha256: proposalBlueprint.corpusSha256,
              parsedTemplateCount: proposalBlueprint.templates.length,
              blueprintSectionCount: proposalBlueprint.sections.length,
            }
          : {}),
        ...(content.generationAudit
          ? {
              contentGenerationAudit: content.generationAudit,
              limitedDraft: content.generationAudit.limitedDraft ?? false,
              limitationCount: content.generationAudit.limitationCount ?? 0,
              limitationIssueCodes: content.generationAudit.limitationIssueCodes ?? [],
            }
          : {}),
        ...(proposalDocxReview
          ? {
              wordReviewerPassed: proposalDocxReview.passed,
              wordReview: proposalDocxReview.metadata,
            }
          : {}),
        ...(proposalSkillValidation
          ? { proposalSkillValidation }
          : {}),
        ...(pptWorkflow
          ? {
              pptWorkflow: {
                sourceMode: pptWorkflow.sourceMode,
                templateUsage: 'disabled',
                skills: pptWorkflow.skills,
              },
              gordenGenerationAudit: pptGenerationAudit,
              pptGordenReviewerPassed: pptWorkflowReview?.passed ?? false,
              pptGordenReview: pptWorkflowReview?.metadata,
              pptGordenIssueCodes: pptWorkflowReview?.issueCodes ?? [
                'reviewer-unavailable',
              ],
            }
          : {}),
        referenceTemplate: task.type === 'investment_recommendation_ppt'
          ? ''
          : task.type === 'due_diligence_report'
            ? '尽调报告模板语料库'
            : path.basename(template.referencePath),
        referenceTemplates: task.type === 'investment_recommendation_ppt'
          ? []
          : (template.referencePaths?.length
              ? template.referencePaths
              : [template.referencePath]).map((referencePath) => path.basename(referencePath)),
        templateReferenceMode: task.type === 'investment_recommendation_ppt'
          ? 'create-reference-driven-editable-ppt'
          : task.type === 'due_diligence_report' ? 'corpus' : 'single',
        skillName: skill.name,
        skillVersion: skill.version,
        skillSha256: skill.sha256,
        ...(resolvedCustomTemplate
          ? {
              customTemplateId: resolvedCustomTemplate.row.id,
              customTemplateName: resolvedCustomTemplate.row.originalFileName,
              customTemplateSha256: resolvedCustomTemplate.row.sha256,
              customTemplateAnalysis: resolvedCustomTemplate.row.analysis,
            }
          : {}),
        rejectedEvidenceChunks: evidenceScreening.rejected.length,
      },
    }).returning()
    if (previewPath && previewMetadata) {
      const previewStat = await stat(previewPath)
      if (previewStat.size < 1000) throw new Error('PPT 预览图为空或不完整')
      await db.insert(aiArtifacts).values({
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: fileName.replace(/\.pptx$/i, '.preview.png'),
        format: 'png',
        mimeType: 'image/png',
        version,
        storagePath: previewPath,
        editableLevel: 'preview-only',
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: 'passed',
        metadata: {
          bytes: previewStat.size,
          ...previewMetadata,
          referenceTemplate: task.type === 'investment_recommendation_ppt'
            ? ''
            : path.basename(template.referencePath),
          referenceTemplates: task.type === 'investment_recommendation_ppt'
            ? []
            : (template.referencePaths?.length
                ? template.referencePaths
                : [template.referencePath]).map((referencePath) => path.basename(referencePath)),
          skillName: skill.name,
          skillVersion: skill.version,
          skillSha256: skill.sha256,
          ...(pptWorkflow
            ? {
                pptWorkflow: {
                  sourceMode: pptWorkflow.sourceMode,
                  templateUsage: 'disabled',
                  skills: pptWorkflow.skills,
                },
              }
            : {}),
        },
      })
    }
    const usedSourceIndexes = usedBusinessSourceIndexes(content, sources.length)
    if (usedSourceIndexes.length) {
      const sourceArtifactIds = [artifact.id]
      await db.insert(aiTaskSources).values(sourceArtifactIds.flatMap((artifactId) =>
        usedSourceIndexes.map((index) => {
          const source = sources[index]
          return {
            taskId: task.id,
            artifactId,
            sourceType: source.sourceType,
            sourceId: source.sourceType.startsWith('public_web')
              ? createHash('sha256')
                  .update(source.sourceId || source.sourceName)
                  .digest('hex')
                  .slice(0, 64)
              : source.sourceId,
            sourceName: source.sourceName,
            locator: source.locator ?? (
              source.sourceType.startsWith('public_web')
                ? `公开网页 ${source.sourceId || source.sourceName}`
                : `知识片段 ${source.chunkIndex ?? index}`
            ),
            verificationStatus: source.sourceType.startsWith('public_web')
              ? '待核验'
              : '资料记载',
          }
        }))).catch((error) => {
          console.warn('[aiTask] 来源审计写入未完成，保留已生成主文档:', (error as Error).message)
        })
    }
    const limitedProposal = task.type === 'investment_proposal'
      && (
        (content.generationAudit?.limitedDraft ?? false)
        || proposalDocxReview?.passed !== true
      )
    await db.update(aiTasks).set({
      status: 'succeeded',
      stage: limitedProposal
        ? '受限初稿已生成'
        : task.type === 'investment_proposal'
          ? 'DOCX 已生成'
        : task.type === 'compliance_statement'
          ? 'DOCX 已生成'
          : '生成完成',
      progress: 100,
      resultSummary: content.executiveSummary,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(aiTasks.id, taskId))
    const [userRow] = await db.select().from(users).where(eq(users.id, task.userId)).limit(1)
    if (userRow) {
      await writeTaskAudit(
        { uid: userRow.id, name: userRow.name, role: userRow.role },
        '生成业务材料',
        `${template.label}：${project.name}`,
      ).catch((error) => {
        console.warn('[aiTask] 操作审计写入未完成，保留已生成主文档:', (error as Error).message)
      })
    }
  } catch (error) {
    const errorId = `AI-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8)}`
    const internalMessage = (error as Error).message
    const diagnosticError = error as {
      code?: unknown
      upstreamCode?: unknown
      status?: unknown
      gatewayRequestId?: unknown
      responseBytes?: unknown
      requestAttempt?: unknown
      requestDurationMs?: unknown
      slideNumber?: unknown
      layer?: unknown
    }
    const [context] = await db.select({
      userId: aiTasks.userId,
      projectId: aiTasks.projectId,
      type: aiTasks.type,
      stage: aiTasks.stage,
      progress: aiTasks.progress,
      parameters: aiTasks.parameters,
    }).from(aiTasks).where(eq(aiTasks.id, taskId)).limit(1).catch(() => [])
    console.error(
      `[${errorId}] AI 任务失败 task=${taskId} user=${context?.userId ?? 'unknown'} project=${context?.projectId ?? 'unknown'} type=${context?.type ?? 'unknown'} stage=${context?.stage ?? 'unknown'}:`,
      internalMessage,
      {
        code: diagnosticError.code,
        upstreamCode: diagnosticError.upstreamCode,
        status: diagnosticError.status,
        gatewayRequestId: diagnosticError.gatewayRequestId,
        responseBytes: diagnosticError.responseBytes,
        requestAttempt: diagnosticError.requestAttempt,
        requestDurationMs: diagnosticError.requestDurationMs,
        slideNumber: diagnosticError.slideNumber,
        layer: diagnosticError.layer,
      },
    )
    const recoveryParameters = (context?.parameters ?? {}) as Record<string, unknown>
    const recoveryAttempt = Math.max(
      0,
      Number(recoveryParameters._systemDocumentRecoveryAttempt ?? 0) || 0,
    )
    const nonRecoverableCode = [
      'CUSTOM_TEMPLATE_FORMAT_MISMATCH',
      'INVESTMENT_RECOMMENDATION_CONTENT_QUALITY_REJECTED',
      'GORDEN_VISIBLE_TEXT_CONTRACT_REJECTED',
      'GORDEN_VISUAL_QA_REJECTED',
      'TASK_NOT_FOUND',
      'PROJECT_NOT_FOUND',
    ].includes(String(diagnosticError.code ?? ''))
    const nonRecoverableMessage = /项目不存在|模板不存在|输出格式应为|缺少 Document Blueprint|缺少Document Blueprint/.test(
      internalMessage,
    )
    if (
      context
      && isAiExecutableTaskType(context.type)
      && AUTO_RECOVERY_TASK_TYPES.has(context.type)
    ) {
      const [existingMainArtifact] = await db.select({
        id: aiArtifacts.id,
        format: aiArtifacts.format,
      }).from(aiArtifacts).where(and(
        eq(aiArtifacts.taskId, taskId),
        inArray(aiArtifacts.format, ['docx', 'pptx']),
        context.type === 'investment_recommendation_ppt'
          ? sql`${aiArtifacts.metadata}->>'artifactStage' = 'editable' and ${aiArtifacts.editableLevel} <> 'image'`
          : undefined,
      )).orderBy(desc(aiArtifacts.createdAt)).limit(1).catch(() => [])
      if (existingMainArtifact) {
        await db.update(aiTasks).set({
          status: 'succeeded',
          stage: `${existingMainArtifact.format.toUpperCase()} 已生成`,
          progress: 100,
          errorId: null,
          errorMessage: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(aiTasks.id, taskId)).catch(() => {})
        console.warn(`[${errorId}] 主文档已登记，任务状态恢复为已完成 task=${taskId}`)
        return
      }
    }
    if (
      context
      && isAiExecutableTaskType(context.type)
      && AUTO_RECOVERY_TASK_TYPES.has(context.type)
      && recoveryAttempt < 1
      && !nonRecoverableCode
      && !nonRecoverableMessage
    ) {
      const [resetTask] = await db.update(aiTasks).set({
        status: 'pending',
        stage: context.type === 'investment_recommendation_ppt'
          ? '正在从 Gorden 检查点继续生成'
          : '正在继续生成文档',
        progress: context.type === 'investment_recommendation_ppt'
          ? Number(context.progress ?? 0)
          : Math.min(Number(context.progress ?? 0), 20),
        parameters: {
          ...recoveryParameters,
          _systemDocumentRecoveryAttempt: recoveryAttempt + 1,
          ...(context.type === 'investment_recommendation_ppt'
            ? { _resumeProgressFloor: Number(context.progress ?? 0) }
            : {}),
        },
        errorId: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: new Date(),
      }).where(and(eq(aiTasks.id, taskId), eq(aiTasks.status, 'running'))).returning()
        .catch(() => [])
      if (resetTask) {
        rescheduleAfterRecovery = true
        console.warn(`[${errorId}] 主文档尚未完成，系统自动继续生成 task=${taskId}`)
        return
      }
    }
    await db.update(aiTasks).set({
      status: 'failed',
      stage: safeAiTaskFailureStage(error),
      errorId,
      errorMessage: safeAiTaskFailureMessage(error),
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(aiTasks.id, taskId)).catch(() => {})
  } finally {
    running.delete(taskId)
    if (rescheduleAfterRecovery) scheduleTask(taskId)
  }
}

function scheduleTask(taskId: string) {
  setImmediate(() => { void executeTask(taskId) })
}

async function assertTaskProjectAndConversationAccess(
  user: AiTaskUser,
  projectId: string,
  conversationId?: string,
) {
  const access = await userCanAccessProject(user, projectId)
  if (!access.allowed || !access.project) {
    throw Object.assign(new Error(access.reason), {
      status: access.project ? 403 : 404,
      code: access.project ? 'FORBIDDEN' : 'NOT_FOUND',
    })
  }
  if (conversationId) {
    const [conversation] = await db.select().from(chatConversations)
      .where(and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.userId, user.uid),
      ))
      .limit(1)
    if (!conversation) {
      throw Object.assign(new Error('会话不存在或不属于当前用户'), {
        status: 404,
        code: 'CONVERSATION_NOT_FOUND',
      })
    }
    if (conversation.projectId && conversation.projectId !== projectId) {
      throw Object.assign(new Error('会话所属项目与任务项目不一致'), {
        status: 409,
        code: 'CONVERSATION_PROJECT_MISMATCH',
      })
    }
  }
  return access.project
}

export async function createInvestmentPptPreparationTask(
  user: AiTaskUser,
  input: CreateInvestmentPptPreparationInput,
) {
  const project = await assertTaskProjectAndConversationAccess(
    user,
    input.projectId,
    input.conversationId,
  )
  const parameters: Record<string, unknown> = {
    sourceCutoffDate: input.sourceCutoffDate,
    outputFormat: input.outputFormat,
    language: input.language,
    structureMode: input.structureMode,
    customTemplateName: input.fileName,
    clientPreparationId: input.progressId,
    clientTimelineStartedAt: input.startedAt,
    _templatePreparationPending: true,
    ...(input.userInstructions?.trim()
      ? {
          userInstructions: input.userInstructions.trim().slice(0, 2_000),
          researchIntent: input.userInstructions.trim().slice(0, 2_000),
          conversationTriggered: input.userInstructions.includes('本次会话生成要求：'),
          requestedSkill: 'GordenSuperPPTSkill',
        }
      : {}),
  }
  const hash = createRequestHash({
    type: 'investment_recommendation_ppt',
    projectId: input.projectId,
    conversationId: input.conversationId,
    parameters,
    idempotencyKey: input.idempotencyKey,
  })
  const [existing] = await db.select().from(aiTasks)
    .where(and(
      eq(aiTasks.userId, user.uid),
      eq(aiTasks.idempotencyKey, input.idempotencyKey),
    ))
    .limit(1)
  if (existing) {
    if (existing.requestHash && existing.requestHash !== hash) {
      throw Object.assign(new Error('该幂等键已用于不同的任务参数'), {
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
      })
    }
    return getAiTask(user.uid, existing.id)
  }
  try {
    const now = new Date()
    const startedAt = new Date(input.startedAt)
    const [task] = await db.insert(aiTasks).values({
      userId: user.uid,
      projectId: input.projectId,
      conversationId: input.conversationId,
      type: 'investment_recommendation_ppt',
      parameters,
      templateVersion: '模板上传与预检',
      status: 'running',
      stage: '正在读取并上传模板',
      progress: 1,
      startedAt,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      updatedAt: now,
    }).returning()
    await writeTaskAudit(user, '创建 AI 任务', `投资建议书（PPT）模板准备：${project.name}`)
    return getAiTask(user.uid, task.id)
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const [raceWinner] = await db.select().from(aiTasks)
        .where(and(
          eq(aiTasks.userId, user.uid),
          eq(aiTasks.idempotencyKey, input.idempotencyKey),
        ))
        .limit(1)
      if (raceWinner) return getAiTask(user.uid, raceWinner.id)
    }
    throw error
  }
}

export async function updateInvestmentPptPreparationTask(
  userId: string,
  taskId: string,
  update: { stage: string; progress: number },
  expected?: {
    projectId: string
    conversationId?: string
    progressId: string
  },
) {
  const task = await getTaskRow(userId, taskId)
  if (!task) return undefined
  const parameters = task.parameters as Record<string, unknown>
  if (expected && (
    task.projectId !== expected.projectId
    || task.conversationId !== (expected.conversationId ?? null)
    || parameters.clientPreparationId !== expected.progressId
    || task.type !== 'investment_recommendation_ppt'
    || !isTemplatePreparationPending(parameters)
  )) {
    throw Object.assign(new Error('模板分析请求与投资建议书任务不匹配'), {
      status: 409,
      code: 'TEMPLATE_TASK_MISMATCH',
    })
  }
  if (
    task.type !== 'investment_recommendation_ppt'
    || !isTemplatePreparationPending(parameters)
    || task.status !== 'running'
  ) return getAiTask(userId, taskId)
  await db.update(aiTasks).set({
    stage: update.stage.slice(0, 64),
    progress: Math.max(1, Math.min(10, Math.ceil(update.progress / 10))),
    updatedAt: new Date(),
  }).where(and(eq(aiTasks.id, taskId), eq(aiTasks.userId, userId)))
  return getAiTask(userId, taskId)
}

export async function failInvestmentPptPreparationTask(
  userId: string,
  taskId: string,
  errorMessage: string,
) {
  const task = await getTaskRow(userId, taskId)
  if (!task) return undefined
  const parameters = task.parameters as Record<string, unknown>
  if (
    task.type !== 'investment_recommendation_ppt'
    || !isTemplatePreparationPending(parameters)
    || ['succeeded', 'failed', 'cancelled'].includes(task.status)
  ) return getAiTask(userId, taskId)
  const now = new Date()
  await db.update(aiTasks).set({
    status: 'failed',
    stage: '模板分析失败',
    progress: Math.max(1, Math.min(10, task.progress || 1)),
    errorMessage: errorMessage.trim().slice(0, 2000) || '模板分析失败',
    completedAt: now,
    updatedAt: now,
  }).where(and(eq(aiTasks.id, taskId), eq(aiTasks.userId, userId)))
  return getAiTask(userId, taskId)
}

export async function startInvestmentPptTaskAfterPreparation(
  user: AiTaskUser,
  taskId: string,
  templateInput: { id: string; originalFileName: string },
) {
  const task = await getTaskRow(user.uid, taskId)
  if (!task) {
    throw Object.assign(new Error('投资建议书任务不存在'), {
      status: 404,
      code: 'TASK_NOT_FOUND',
    })
  }
  const currentParameters = task.parameters as Record<string, unknown>
  if (
    task.type !== 'investment_recommendation_ppt'
    || !isTemplatePreparationPending(currentParameters)
  ) return getAiTask(user.uid, taskId)
  if (task.cancellationRequested || task.status === 'cancelled') {
    await db.update(aiTasks).set({
      status: 'cancelled',
      stage: '已取消',
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(aiTasks.id, taskId))
    return getAiTask(user.uid, taskId)
  }
  const parameters: Record<string, unknown> = {
    ...currentParameters,
    customTemplateId: templateInput.id,
    customTemplateName: templateInput.originalFileName,
    _templatePreparationPending: false,
  }
  const resolved = await resolveAiCustomTemplateForTask({
    userId: user.uid,
    projectId: task.projectId,
    conversationId: task.conversationId ?? undefined,
    templateId: templateInput.id,
    taskType: 'investment_recommendation_ppt',
  })
  const expectedOutputFormat = resolved.template.outputFormat.toUpperCase()
  if (parameters.outputFormat !== expectedOutputFormat) {
    throw Object.assign(new Error(`上传模板输出格式应为 ${expectedOutputFormat}`), {
      status: 409,
      code: 'CUSTOM_TEMPLATE_FORMAT_MISMATCH',
    })
  }
  await prepareInvestmentRecommendationPptWorkflow(resolved.template)
  const now = new Date()
  await db.update(aiTasks).set({
    parameters,
    templateVersion: resolved.template.templateVersion,
    status: 'pending',
    stage: '模板分析完成，等待生成',
    progress: 10,
    errorId: null,
    errorMessage: null,
    completedAt: null,
    updatedAt: now,
  }).where(and(eq(aiTasks.id, taskId), eq(aiTasks.userId, user.uid)))
  await writeTaskAudit(user, '完成 AI 任务模板准备', taskId)
  scheduleTask(taskId)
  return getAiTask(user.uid, taskId)
}

export async function createAiTask(user: AiTaskUser, input: CreateAiTaskInput) {
  const project = await assertTaskProjectAndConversationAccess(
    user,
    input.projectId,
    input.conversationId,
  )
  const resolvedCustomTemplate = (
    input.type === 'custom_template_document'
  )
    ? await resolveAiCustomTemplateForTask({
        userId: user.uid,
        projectId: input.projectId,
        conversationId: input.conversationId,
        templateId: String(input.parameters.customTemplateId || ''),
        taskType: input.type,
      })
    : undefined
  const template = resolvedCustomTemplate?.template ?? AI_TEMPLATE_CATALOG[input.type as AiBusinessTaskType]
  if (!template) throw Object.assign(new Error('AI 任务模板不存在'), { status: 400, code: 'INVALID_TASK_TYPE' })
  if (resolvedCustomTemplate) {
    const expectedOutputFormat = template.outputFormat.toUpperCase()
    if (input.parameters.outputFormat !== expectedOutputFormat) {
      throw Object.assign(new Error(`上传模板输出格式应为 ${expectedOutputFormat}`), {
        status: 409,
        code: 'CUSTOM_TEMPLATE_FORMAT_MISMATCH',
      })
    }
  } else {
    if (input.type !== 'investment_recommendation_ppt') {
      assertAiTemplateReferences(template)
    }
    await loadAiSkill(AI_TEMPLATE_CATALOG[input.type as AiBusinessTaskType].skillName)
  }
  if (input.type === 'investment_recommendation_ppt') {
    await prepareInvestmentRecommendationPptWorkflow(template)
  }
  const hash = createRequestHash(input)
  const [existing] = await db.select().from(aiTasks)
    .where(and(eq(aiTasks.userId, user.uid), eq(aiTasks.idempotencyKey, input.idempotencyKey)))
    .limit(1)
  if (existing) {
    if (existing.requestHash && existing.requestHash !== hash) {
      throw Object.assign(new Error('该幂等键已用于不同的任务参数'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' })
    }
    return getAiTask(user.uid, existing.id)
  }
  try {
    const resumeProgressFloor = Math.max(
      0,
      Math.min(99, Number(input.parameters._resumeProgressFloor ?? 0) || 0),
    )
    const [task] = await db.insert(aiTasks).values({
      userId: user.uid,
      projectId: input.projectId,
      conversationId: input.conversationId,
      type: input.type,
      parameters: input.parameters,
      templateVersion: template.templateVersion,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      retryOfTaskId: input.retryOfTaskId,
      ...(resumeProgressFloor > 0
        ? {
            stage: '等待断点续跑',
            progress: resumeProgressFloor,
          }
        : {}),
    }).returning()
    await writeTaskAudit(user, '创建 AI 任务', `${template.label}：${project.name}`)
    scheduleTask(task.id)
    return getAiTask(user.uid, task.id)
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const [raceWinner] = await db.select().from(aiTasks)
        .where(and(eq(aiTasks.userId, user.uid), eq(aiTasks.idempotencyKey, input.idempotencyKey))).limit(1)
      if (raceWinner) return getAiTask(user.uid, raceWinner.id)
    }
    throw error
  }
}

export async function getAiTask(userId: string, taskId: string) {
  let task = await getTaskRow(userId, taskId)
  if (!task) return undefined
  const artifacts = await db.select().from(aiArtifacts).where(eq(aiArtifacts.taskId, task.id)).orderBy(desc(aiArtifacts.createdAt))
  if (task.type === 'investment_recommendation_ppt' && task.status === 'succeeded') {
    const hasImageDeck = artifacts.some((artifact) => (
      artifact.qualityStatus === 'passed'
      && (artifact.metadata?.artifactStage === 'image-deck' || artifact.editableLevel === 'image')
    ))
    const hasEditableDeck = artifacts.some((artifact) => (
      artifact.format === 'pptx'
      && artifact.qualityStatus === 'passed'
      && artifact.editableLevel !== 'image'
      && (
        artifact.metadata?.artifactStage === 'editable'
        || ['all', 'text-and-structure'].includes(artifact.editableLevel)
      )
    ))
    // 兼容修复旧任务：图片版属于中间交付物，不能单独把整项任务标记为成功。
    if (hasImageDeck && !hasEditableDeck) {
      const [reconciled] = await db.update(aiTasks).set({
        status: 'failed',
        stage: '元素级可编辑版未完成',
        progress: 78,
        errorMessage: '图片高保真版已完成，但元素级可编辑版尚未成功生成。系统已保留检查点，可点击“继续生成”。',
        updatedAt: new Date(),
      }).where(eq(aiTasks.id, task.id)).returning()
      task = reconciled ?? task
    }
  }
  const sources = await db.select().from(aiTaskSources).where(eq(aiTaskSources.taskId, task.id)).orderBy(asc(aiTaskSources.createdAt))
  const deliverables = task.type === 'investment_proposal'
    ? artifacts.filter((artifact) => artifact.format === 'docx')
    : artifacts
  return { ...task, artifacts: deliverables.map(publicArtifact), sources }
}

export async function listAiTasks(userId: string, options: { projectId?: string; conversationId?: string; limit?: number } = {}) {
  const conditions = [eq(aiTasks.userId, userId)]
  if (options.projectId) conditions.push(eq(aiTasks.projectId, options.projectId))
  if (options.conversationId) conditions.push(eq(aiTasks.conversationId, options.conversationId))
  const rows = await db.select().from(aiTasks).where(and(...conditions)).orderBy(desc(aiTasks.createdAt)).limit(options.limit ?? 50)
  return Promise.all(rows.map((row) => getAiTask(userId, row.id)))
}

export async function cancelAiTask(user: AiTaskUser, taskId: string) {
  const task = await getTaskRow(user.uid, taskId)
  if (!task) return undefined
  if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return getAiTask(user.uid, taskId)
  const templatePreparation = isTemplatePreparationPending(
    task.parameters as Record<string, unknown>,
  )
  await db.update(aiTasks).set({
    cancellationRequested: true,
    ...(task.status === 'pending' || templatePreparation
      ? { status: 'cancelled', stage: '已取消', completedAt: new Date() }
      : {}),
    updatedAt: new Date(),
  }).where(eq(aiTasks.id, taskId))
  await writeTaskAudit(user, '取消 AI 任务', taskId)
  return getAiTask(user.uid, taskId)
}

export async function retryAiTask(user: AiTaskUser, taskId: string, idempotencyKey: string) {
  const task = await getTaskRow(user.uid, taskId)
  if (!task) return undefined
  if (!isAiExecutableTaskType(task.type)) throw new Error('不支持重试的任务类型')
  if (task.status !== 'failed') {
    throw Object.assign(new Error('只有失败任务可以重试'), { status: 409, code: 'TASK_NOT_RETRYABLE' })
  }
  if (isTemplatePreparationPending(task.parameters as Record<string, unknown>)) {
    throw Object.assign(new Error('模板分析尚未完成，请重新上传模板'), {
      status: 409,
      code: 'TEMPLATE_REUPLOAD_REQUIRED',
    })
  }
  const retryParameters: Record<string, unknown> = {
    ...(task.parameters as Record<string, unknown>),
    _resumeProgressFloor: Math.max(0, Math.min(99, Number(task.progress ?? 0))),
  }
  // 手动“继续生成”是一轮新的恢复流程，不能继承上一任务已经耗尽的自动恢复次数。
  delete retryParameters._systemDocumentRecoveryAttempt
  return createAiTask(user, {
    type: task.type,
    projectId: task.projectId,
    conversationId: task.conversationId ?? undefined,
    parameters: retryParameters,
    idempotencyKey,
    retryOfTaskId: task.id,
  })
}

export async function listAiArtifacts(userId: string, projectId?: string) {
  const conditions = [eq(aiArtifacts.userId, userId), eq(aiArtifacts.archived, false)]
  if (projectId) conditions.push(eq(aiArtifacts.projectId, projectId))
  const rows = await db.select({
    artifact: aiArtifacts,
    taskType: aiTasks.type,
  })
    .from(aiArtifacts)
    .innerJoin(aiTasks, eq(aiArtifacts.taskId, aiTasks.id))
    .where(and(...conditions))
    .orderBy(desc(aiArtifacts.createdAt))
    .limit(100)
  return rows
    .filter(({ artifact, taskType }) =>
      taskType !== 'investment_proposal' || artifact.format === 'docx')
    .map(({ artifact }) => publicArtifact(artifact))
}

export async function getArtifactDownload(userId: string, artifactId: string) {
  const [row] = await db.select({
    artifact: aiArtifacts,
    taskType: aiTasks.type,
  })
    .from(aiArtifacts)
    .innerJoin(aiTasks, eq(aiArtifacts.taskId, aiTasks.id))
    .where(and(eq(aiArtifacts.id, artifactId), eq(aiArtifacts.userId, userId), eq(aiArtifacts.archived, false)))
    .limit(1)
  const artifact = row?.artifact
  if (!artifact || artifact.qualityStatus !== 'passed') return undefined
  if (row.taskType === 'investment_proposal' && artifact.format !== 'docx') return undefined
  const resolved = path.resolve(artifact.storagePath)
  if (!resolved.startsWith(ARTIFACT_ROOT + path.sep)) return undefined
  const fileStat = await stat(resolved).catch(() => null)
  if (!fileStat?.isFile()) return undefined
  return { artifact, stream: createReadStream(resolved), size: fileStat.size }
}

export async function getArtifactPreview(userId: string, artifactId: string) {
  const [artifact] = await db.select().from(aiArtifacts)
    .where(and(eq(aiArtifacts.id, artifactId), eq(aiArtifacts.userId, userId), eq(aiArtifacts.archived, false)))
    .limit(1)
  if (!artifact || artifact.qualityStatus !== 'passed' || artifact.format !== 'md') return undefined
  const resolved = path.resolve(artifact.storagePath)
  if (!resolved.startsWith(ARTIFACT_ROOT + path.sep)) return undefined
  const fileStat = await stat(resolved).catch(() => null)
  if (!fileStat?.isFile() || fileStat.size > 2 * 1024 * 1024) return undefined
  return { artifact, content: await readFile(resolved, 'utf8') }
}

export async function recoverAiTasks() {
  const recoverable = await db.select({
    id: aiTasks.id,
    parameters: aiTasks.parameters,
  }).from(aiTasks)
    .where(inArray(aiTasks.status, ['pending', 'running']))
    .orderBy(asc(aiTasks.createdAt))
    .limit(100)
  for (const task of recoverable) {
    if (isTemplatePreparationPending(task.parameters)) {
      await db.update(aiTasks).set({
        status: 'failed',
        stage: '模板分析中断',
        errorMessage: '服务重启导致模板分析中断，请重新上传模板。',
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(aiTasks.id, task.id))
      continue
    }
    await db.update(aiTasks).set({ status: 'pending', stage: '等待恢复', updatedAt: new Date() }).where(eq(aiTasks.id, task.id))
    scheduleTask(task.id)
  }
}
