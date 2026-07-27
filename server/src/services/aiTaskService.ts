import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import JSZip from 'jszip'
import { db } from '../db/client.js'
import { aiArtifacts, aiTaskSources, aiTasks, auditLogs, chatConversations, knowledgeChunks, projects, users } from '../db/schema.js'
import {
  composeBusinessContent,
  usedBusinessSourceIndexes,
  type BusinessContent,
  type EvidenceSource,
} from './aiBusinessContentService.js'
import {
  generateBusinessDocx,
  generateBusinessPptx,
  generateBusinessPptxPreview,
  makeArtifactFileName,
  renderBusinessMarkdown,
} from './aiBusinessDocumentService.js'
import {
  AI_TEMPLATE_CATALOG,
  assertAiTemplateReferences,
  isAiBusinessTaskType,
  type AiBusinessTaskType,
} from './aiTemplateCatalog.js'
import { loadAiSkill } from './aiSkillService.js'
import {
  curateEvidenceSources,
  dedupeTextList,
} from './aiEvidenceQualityService.js'
import {
  complianceBlueprintMetadata,
  parseComplianceDocumentBlueprint,
  type ComplianceDocumentBlueprint,
} from './aiComplianceBlueprintService.js'
import {
  composeComplianceStatement,
  type ComplianceWorkflowResult,
} from './aiComplianceWorkflowService.js'
import {
  convertComplianceDocxToPdf,
  reviewCompliancePdfAgainstDocx,
  reviewGeneratedComplianceDocx,
  type ComplianceOutputReview,
} from './aiComplianceOutputService.js'
import {
  convertProjectQaDocxToPdf,
  generateProjectQaDocx,
  inspectProjectQaDocx,
  makeProjectQaFileNames,
} from './aiQaDocumentService.js'
import {
  buildProjectQaDocumentContent,
  generateProjectQaAnswers,
  generateProjectQaQuestions,
  reviewProjectQaAnswers,
  usedProjectQaSourceIndexes,
  type ProjectQaDepth,
  type ProjectQaMode,
} from './aiQaPipelineService.js'
import {
  parseQaTemplateCorpus,
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
import {
  exportAndReviewInvestmentProposalPdf,
  type InvestmentProposalPdfReview,
} from './aiInvestmentProposalPdfService.js'

export type AiTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type AiTaskUser = {
  uid: string
  name: string
  role: string
}

export type CreateAiTaskInput = {
  type: AiBusinessTaskType
  projectId: string
  conversationId?: string
  parameters: Record<string, unknown>
  idempotencyKey: string
  retryOfTaskId?: string
}

const ARTIFACT_ROOT = path.resolve(process.env.AI_ARTIFACT_ROOT || path.join(process.cwd(), 'server', 'ai-artifacts'))
const running = new Set<string>()

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
  const rows = await db.select().from(knowledgeChunks)
    .where(and(
      eq(knowledgeChunks.scope, 'project'),
      eq(knowledgeChunks.refId, projectId),
      lte(knowledgeChunks.createdAt, cutoff),
    ))
    .orderBy(asc(knowledgeChunks.sourceName), asc(knowledgeChunks.chunkIndex))
    .limit(limit)
  return rows.map((row) => ({
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceName: row.sourceName || '项目资料',
    chunkIndex: row.chunkIndex,
    versionOrDate: row.createdAt.toISOString().slice(0, 10),
    content: row.content,
  }))
}

export function screenEvidenceSources(sources: EvidenceSource[], type?: AiBusinessTaskType) {
  if (type === 'investment_proposal') {
    return curateEvidenceSources(sources, { maxTotal: 72, maxPerDocument: 10 })
  }
  if (type === 'compliance_statement') {
    // 合规性说明随后会按章节再次检索和裁剪；这里保留更宽的当前项目候选集，
    // 避免全局前18个片段把合同、基金台账或法律资料提前截掉。
    return curateEvidenceSources(sources, { maxTotal: 96, maxPerDocument: 12 })
  }
  return curateEvidenceSources(
    sources,
    type === 'project_qa'
      ? { maxTotal: 32, maxPerDocument: 6 }
      : { maxTotal: 18, maxPerDocument: 3 },
  )
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
  await db.update(aiTasks).set({ stage, progress, updatedAt: new Date() }).where(eq(aiTasks.id, taskId))
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
  options: { requireEndReferences?: boolean } = {},
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
    return {
      qualityStatus: 'passed',
      metadata: {
        bytes: fileStat.size,
        editableText: true,
        encodingClean: true,
        cjkFontValidated: true,
        endReferencesValidated: requireEndReferences,
      },
    }
  }
  if (!zip.file('ppt/presentation.xml')) throw new Error('PPTX 缺少 presentation.xml')
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  let editableTextElements = 0
  for (const name of slides) {
    const xml = await zip.file(name)!.async('string')
    if (xml.includes('\uFFFD')) throw new Error(`PPTX ${name} 包含损坏的 Unicode 字符`)
    if (/[\u3400-\u9FFF]/.test(xml) && xml.includes('lang="en-US"')) {
      throw new Error(`PPTX ${name} 的中文文本语言标记错误`)
    }
    editableTextElements += (xml.match(/<a:t>/g) || []).length
  }
  const finalSlideXml = await zip.file(`ppt/slides/slide${slides.length}.xml`)?.async('string') || ''
  if (!finalSlideXml.includes('引用资料与责任声明')) throw new Error('PPTX 最后一页缺少引用资料与责任声明')
  const themeXml = await zip.file('ppt/theme/theme1.xml')?.async('string')
  if (!themeXml || !/<a:ea[^>]+typeface="[^"]+"/.test(themeXml)) throw new Error('PPTX 缺少东亚主题字体')
  if (slides.length < 3 || editableTextElements < slides.length * 2) throw new Error('PPTX 可编辑文本元素不足')
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

async function executeTask(taskId: string) {
  if (running.has(taskId)) return
  running.add(taskId)
  try {
    const [task] = await db.select().from(aiTasks).where(eq(aiTasks.id, taskId)).limit(1)
    if (!task || !isAiBusinessTaskType(task.type) || ['succeeded', 'cancelled'].includes(task.status)) return
    const template = AI_TEMPLATE_CATALOG[task.type]
    assertAiTemplateReferences(template)
    const skill = await loadAiSkill(template.skillName)
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
      await updateStage(taskId, '解析 Q&A 模板并建立模板画像', 6)
      qaTemplateProfile = await parseQaTemplateCorpus(
        template.referencePaths ?? [template.referencePath],
      )
    }
    const [claimed] = await db.update(aiTasks).set({
      status: 'running',
      stage: '读取项目资料',
      progress: 10,
      startedAt: task.startedAt ?? new Date(),
      errorId: null,
      errorMessage: null,
      updatedAt: new Date(),
    }).where(and(eq(aiTasks.id, taskId), eq(aiTasks.status, 'pending'))).returning()
    if (!claimed || await cancelIfRequested(taskId)) return

    const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1)
    if (!project) throw new Error('项目不存在或已删除')
    const parameters = (task.parameters ?? {}) as Record<string, unknown>
    const sourceCutoffDate = String(parameters.sourceCutoffDate || new Date().toISOString().slice(0, 10))
    const knowledgeSources = await sourcesForProject(
      project.id,
      sourceCutoffDate,
      task.type === 'investment_proposal'
        ? 240
        : task.type === 'compliance_statement'
          ? 500
          : 40,
    )
    const userInstructions = typeof parameters.userInstructions === 'string'
      ? parameters.userInstructions.trim()
      : ''
    const rawSources: EvidenceSource[] = [
      ...(task.type === 'investment_proposal' && userInstructions ? [{
        sourceType: 'user_input',
        sourceId: `${task.id}:user-input`,
        sourceName: '用户补充输入',
        chunkIndex: 0,
        versionOrDate: new Date().toISOString().slice(0, 10),
        content: `用户本次明确提供的项目数据和要求：\n${userInstructions}`,
      }] : []),
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
          `阶段：${project.stage || '待核验'}`,
          `融资计划：${project.financing || '待核验'}`,
          `估值：${project.valuation || '待核验'}`,
          `项目概述：${project.summary || '待核验'}`,
          `商业模式：${project.businessModel || '待核验'}`,
          `市场：${project.market || '待核验'}`,
          `团队：${project.team || '待核验'}`,
        ].join('\n'),
      }] : []),
      ...knowledgeSources,
    ]
    const evidenceScreening = screenEvidenceSources(rawSources, task.type)
    const sources = evidenceScreening.usable
    if (await cancelIfRequested(taskId)) return

    if (task.type === 'project_qa') {
      if (!qaTemplateProfile) throw new Error('Q&A 模板画像未生成')
      const qaMode: ProjectQaMode = parameters.qaMode === '尽调 Q&A'
        ? '尽调 Q&A'
        : '投资委员会 Q&A'
      const questionDepth: ProjectQaDepth = parameters.questionDepth === '深度版'
        ? '深度版'
        : '标准版'

      await updateStage(taskId, 'Question Generator 生成专业问题', 28)
      const duplicateCheck = await generateProjectQaQuestions({
        project,
        mode: qaMode,
        depth: questionDepth,
        sources,
        skill,
      })
      if (duplicateCheck.questions.length === 0) {
        throw new Error('Question Generator 未生成有效问题')
      }
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, 'Duplicate Checker 去重', 40)
      await updateStage(taskId, '基于当前项目资料生成回答', 52)
      const draftAnswers = await generateProjectQaAnswers({
        project,
        mode: qaMode,
        questions: duplicateCheck.questions,
        sources,
        skill,
      })
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, 'Reviewer 检查完整性、幻觉与引用', 66)
      const reviewed = await reviewProjectQaAnswers({
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

      await updateStage(taskId, 'Formatter 生成 Word 与 PDF', 80)
      const taskDir = path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.id)
      await mkdir(taskDir, { recursive: true })
      const names = makeProjectQaFileNames(project.name, qaMode)
      const docxPath = path.join(taskDir, names.docx)
      const pdfPath = path.join(taskDir, names.pdf)
      const docxGeneration = await generateProjectQaDocx({
        outputPath: docxPath,
        project,
        content: qaContent,
        sources,
        sourceCutoffDate,
        templateProfile: qaTemplateProfile,
        disclaimer: template.disclaimer,
      })
      const docxQuality = await inspectProjectQaDocx(docxPath, {
        questionCount: qaContent.questions.length,
        categoryCount: template.sections.length,
      })
      const pdfQuality = await convertProjectQaDocxToPdf({
        docxPath,
        pdfPath,
      })
      if (await cancelIfRequested(taskId)) return

      await updateStage(taskId, '执行 Word/PDF 质量检查', 92)
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
      }
      const [docxArtifact] = await db.insert(aiArtifacts).values({
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: names.docx,
        format: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        version,
        storagePath: docxPath,
        editableLevel: template.editableLevel,
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: docxQuality.qualityStatus,
        metadata: {
          ...docxQuality.metadata,
          ...docxGeneration,
          ...sharedMetadata,
        },
      }).returning()
      await db.insert(aiArtifacts).values({
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: names.pdf,
        format: 'pdf',
        mimeType: 'application/pdf',
        version,
        storagePath: pdfPath,
        editableLevel: 'fixed-layout',
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: pdfQuality.qualityStatus,
        metadata: {
          ...pdfQuality.metadata,
          sourceDocxArtifactId: docxArtifact.id,
          ...sharedMetadata,
        },
      })
      const usedSourceIndexes = usedProjectQaSourceIndexes(reviewed.answers, sources.length)
      if (usedSourceIndexes.length) {
        await db.insert(aiTaskSources).values(usedSourceIndexes.map((index) => {
          const source = sources[index]
          return {
            taskId: task.id,
            artifactId: docxArtifact.id,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            sourceName: source.sourceName,
            locator: `知识片段 ${source.chunkIndex ?? index}`,
            verificationStatus: '资料记载',
          }
        }))
      }
      await db.update(aiTasks).set({
        status: 'succeeded',
        stage: 'Word/PDF 已生成并通过 Reviewer',
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
        )
      }
      return
    }

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
      })
      content = complianceWorkflow.content
    } else {
    await updateStage(
      taskId,
      task.type === 'investment_proposal'
        ? '建立章节级 Evidence 并逐章节生成、执行 Reviewer'
        : '生成结构化内容',
      35,
    )
      content = await composeBusinessContent({
        type: task.type,
        template,
        skill,
        project,
        sources,
        sourceCutoffDate,
        parameters,
      })
    }
    if (evidenceScreening.rejected.length) {
      const affectedFiles = [...new Set(evidenceScreening.rejected.map((item) => item.sourceName))]
      content.missing = dedupeTextList([
        ...content.missing,
        `有 ${evidenceScreening.rejected.length} 个重复、测试、占位或损坏的知识片段未用于正文；如其中包含有效资料，请重新上传原文件：${affectedFiles.slice(0, 5).join('、')}`,
      ], { limit: 8 })
    }
    if (await cancelIfRequested(taskId)) return

    await updateStage(
      taskId,
      template.outputFormat === 'pptx'
        ? '生成可编辑 PPTX'
        : task.type === 'compliance_statement'
          ? 'Formatter 生成 Word'
          : task.type === 'investment_proposal'
            ? 'Formatter 按 Document Blueprint 生成 Word'
          : '生成 DOCX',
      68,
    )
    const taskDir = path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.id)
    await mkdir(taskDir, { recursive: true })
    const fileName = makeArtifactFileName(project.name, template)
    const outputPath = path.join(taskDir, fileName)
    let previewPath: string | undefined
    let previewMetadata: Record<string, unknown> | undefined
    let pdfPath: string | undefined
    let complianceDocxReview: ComplianceOutputReview | undefined
    let compliancePdfReview: ComplianceOutputReview | undefined
    let pdfConversionMetadata: Record<string, unknown> | undefined
    let proposalDocxReview: InvestmentProposalOutputReview | undefined
    let proposalPdfReview: InvestmentProposalPdfReview | undefined
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
        })
        previewPath = outputPath.replace(/\.pptx$/i, '.preview.png')
        previewMetadata = await generateBusinessPptxPreview({
          outputPath: previewPath,
          template,
          project,
          content,
          sourceCutoffDate,
        })
        return result
      })()
      : await generateBusinessDocx({
        outputPath,
        template,
        project,
        content,
        sourceCutoffDate,
        sources,
        blueprint: complianceBlueprint,
      })
    if (await cancelIfRequested(taskId)) return

    if (task.type === 'investment_proposal') {
      if (!proposalBlueprint) throw new Error('投资提案缺少 Document Blueprint')
      await updateStage(taskId, 'Reviewer 检查 Word 章节、固定内容、引用及格式', 76)
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
      if (!proposalDocxReview?.passed) {
        throw new Error(`投资提案 Word Reviewer 未通过：${proposalDocxReview?.issues
          .map((issue) => `${issue.code}:${issue.message}`)
          .join('；')}`)
      }
      await updateStage(taskId, '由最终 Word 同源生成 PDF 并复核', 82)
      pdfPath = outputPath.replace(/\.docx$/i, '.pdf')
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        proposalPdfReview = await exportAndReviewInvestmentProposalPdf({
          docxPath: outputPath,
          pdfPath,
          template,
          blueprint: proposalBlueprint,
          content,
        })
        if (proposalPdfReview.passed) break
      }
      if (!proposalPdfReview?.passed) {
        throw new Error(`投资提案 PDF Reviewer 未通过：${proposalPdfReview?.issues
          .map((issue) => `${issue.code}:${issue.message}`)
          .join('；')}`)
      }
    }

    if (task.type === 'compliance_statement') {
      if (!complianceBlueprint) throw new Error('合规性说明缺少Document Blueprint')
      await updateStage(taskId, 'Reviewer 检查 Word 结构与格式', 76)
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
      if (!complianceDocxReview?.passed) {
        throw new Error(`合规性说明Word Reviewer未通过：${complianceDocxReview?.issues
          .map((issue) => `${issue.code}:${issue.message}`)
          .join('；')}`)
      }
      await updateStage(taskId, '由 Word 生成 PDF', 82)
      pdfPath = outputPath.replace(/\.docx$/i, '.pdf')
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const conversion = await convertComplianceDocxToPdf({
          docxPath: outputPath,
          pdfPath,
          // 合规模板使用宋体/黑体；在无 Office 字体的服务端始终对临时转换副本
          // 做可审计的 CJK 字体映射，原始可编辑 Word 不作字体替换。
          fontFallback: true,
        })
        pdfConversionMetadata = conversion
        compliancePdfReview = await reviewCompliancePdfAgainstDocx({
          docxPath: outputPath,
          pdfPath,
          template,
          blueprint: complianceBlueprint,
          content,
        })
        if (compliancePdfReview.passed) break
      }
      if (!compliancePdfReview?.passed) {
        throw new Error(`合规性说明PDF Reviewer未通过：${compliancePdfReview?.issues
          .map((issue) => `${issue.code}:${issue.message}`)
          .join('；')}`)
      }
    }
    await updateStage(taskId, '执行文件质量检查', 88)
    const quality = await inspectGeneratedArtifact(outputPath, template.outputFormat, {
      // 合规性说明核心规范禁止“引用资料”等模板外正文板块；来源只保留在
      // ai_task_sources 与产物元数据中。其他业务文档继续执行文尾来源门禁。
      requireEndReferences: task.type !== 'compliance_statement',
    })
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(aiArtifacts)
      .where(and(eq(aiArtifacts.userId, task.userId), eq(aiArtifacts.projectId, task.projectId), eq(aiArtifacts.format, template.outputFormat)))
    const version = Number(count ?? 0) + 1
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
      editableLevel: template.editableLevel,
      sourceCutoffDate,
      templateVersion: template.templateVersion,
      qualityStatus: quality.qualityStatus,
      metadata: {
        ...quality.metadata,
        ...generationMetadata,
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
            }
          : {}),
        ...(proposalDocxReview
          ? {
              wordReviewerPassed: proposalDocxReview.passed,
              wordReview: proposalDocxReview.metadata,
            }
          : {}),
        referenceTemplate: path.basename(template.referencePath),
        referenceTemplates: (template.referencePaths?.length
          ? template.referencePaths
          : [template.referencePath]).map((referencePath) => path.basename(referencePath)),
        skillName: skill.name,
        skillVersion: skill.version,
        skillSha256: skill.sha256,
        rejectedEvidenceChunks: evidenceScreening.rejected.length,
      },
    }).returning()
    let proposalPdfArtifactId: string | undefined
    if (pdfPath && compliancePdfReview?.passed) {
      const pdfStat = await stat(pdfPath)
      if (!pdfStat.isFile() || pdfStat.size < 1000) throw new Error('合规性说明PDF为空或不完整')
      await db.insert(aiArtifacts).values({
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: fileName.replace(/\.docx$/i, '.pdf'),
        format: 'pdf',
        mimeType: 'application/pdf',
        version,
        storagePath: pdfPath,
        editableLevel: 'fixed-layout',
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: 'passed',
        metadata: {
          bytes: pdfStat.size,
          ...compliancePdfReview.metadata,
          ...pdfConversionMetadata,
          derivedFromArtifactId: artifact.id,
          ...(complianceBlueprint
            ? complianceBlueprintMetadata(complianceBlueprint)
            : {}),
          referenceTemplate: path.basename(template.referencePath),
          referenceTemplates: (template.referencePaths?.length
            ? template.referencePaths
            : [template.referencePath]).map((referencePath) => path.basename(referencePath)),
          skillName: skill.name,
          skillVersion: skill.version,
          skillSha256: skill.sha256,
          pdfReviewerPassed: true,
        },
      })
    }
    if (pdfPath && proposalPdfReview?.passed && proposalBlueprint) {
      const pdfStat = await stat(pdfPath)
      if (!pdfStat.isFile() || pdfStat.size < 1000) throw new Error('投资提案 PDF 为空或不完整')
      const [pdfArtifact] = await db.insert(aiArtifacts).values({
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: fileName.replace(/\.docx$/i, '.pdf'),
        format: 'pdf',
        mimeType: 'application/pdf',
        version,
        storagePath: pdfPath,
        editableLevel: 'fixed-layout',
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: 'passed',
        metadata: {
          ...proposalPdfReview.metadata,
          derivedFromArtifactId: artifact.id,
          blueprintVersion: proposalBlueprint.version,
          coreStandardSha256: proposalBlueprint.coreStandardSha256,
          templateCorpusSha256: proposalBlueprint.corpusSha256,
          parsedTemplateCount: proposalBlueprint.templates.length,
          blueprintSectionCount: proposalBlueprint.sections.length,
          referenceTemplate: path.basename(template.referencePath),
          referenceTemplates: (template.referencePaths?.length
            ? template.referencePaths
            : [template.referencePath]).map((referencePath) => path.basename(referencePath)),
          skillName: skill.name,
          skillVersion: skill.version,
          skillSha256: skill.sha256,
          pdfReviewerPassed: true,
        },
      }).returning()
      proposalPdfArtifactId = pdfArtifact.id
    }
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
          referenceTemplate: path.basename(template.referencePath),
          referenceTemplates: (template.referencePaths?.length
            ? template.referencePaths
            : [template.referencePath]).map((referencePath) => path.basename(referencePath)),
          skillName: skill.name,
          skillVersion: skill.version,
          skillSha256: skill.sha256,
        },
      })
    }
    if (task.type === 'compliance_statement') {
      const markdownFileName = fileName.replace(/\.docx$/i, '.md')
      const markdownPath = path.join(taskDir, markdownFileName)
      const markdown = renderBusinessMarkdown({ template, project, content, sources, sourceCutoffDate })
      await writeFile(markdownPath, markdown, 'utf8')
      const markdownStat = await stat(markdownPath)
      const requiredMarkdownSections = ['一、公司情况介绍', '二、投资理由', '三、投资计划', '四、投资情形分析']
      const forbiddenMarkdownSections = ['## 摘要', '## 已核验事实', '## 风险提示', '## 待核验事项', '## 资料缺口', '## 免责声明', '## 引用资料']
      if (
        markdownStat.size < 200
        || requiredMarkdownSections.some((sectionTitle) => !markdown.includes(sectionTitle))
        || forbiddenMarkdownSections.some((sectionTitle) => markdown.includes(sectionTitle))
      ) {
        throw new Error('合规说明 Markdown 预览不符合核心规范')
      }
      await db.insert(aiArtifacts).values({
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        conversationId: task.conversationId,
        fileName: markdownFileName,
        format: 'md',
        mimeType: 'text/markdown; charset=utf-8',
        version,
        storagePath: markdownPath,
        editableLevel: 'text-and-structure',
        sourceCutoffDate,
        templateVersion: template.templateVersion,
        qualityStatus: 'passed',
        metadata: {
          bytes: markdownStat.size,
          pagePreview: true,
          referenceTemplate: path.basename(template.referencePath),
          referenceTemplates: (template.referencePaths?.length
            ? template.referencePaths
            : [template.referencePath]).map((referencePath) => path.basename(referencePath)),
          skillName: skill.name,
          skillVersion: skill.version,
          skillSha256: skill.sha256,
        },
      })
    }
    const usedSourceIndexes = usedBusinessSourceIndexes(content, sources.length)
    if (usedSourceIndexes.length) {
      const sourceArtifactIds = [
        artifact.id,
        proposalPdfArtifactId,
      ].filter((id): id is string => Boolean(id))
      await db.insert(aiTaskSources).values(sourceArtifactIds.flatMap((artifactId) =>
        usedSourceIndexes.map((index) => {
          const source = sources[index]
          return {
            taskId: task.id,
            artifactId,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            sourceName: source.sourceName,
            locator: `知识片段 ${source.chunkIndex ?? index}`,
            verificationStatus: '资料记载',
          }
        })))
    }
    await db.update(aiTasks).set({
      status: 'succeeded',
      stage: task.type === 'investment_proposal'
        ? 'Word/PDF 已生成并通过 Reviewer'
        : '生成完成',
      progress: 100,
      resultSummary: content.executiveSummary,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(aiTasks.id, taskId))
    const [userRow] = await db.select().from(users).where(eq(users.id, task.userId)).limit(1)
    if (userRow) await writeTaskAudit({ uid: userRow.id, name: userRow.name, role: userRow.role }, '生成业务材料', `${template.label}：${project.name}`)
  } catch (error) {
    const errorId = `AI-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8)}`
    const internalMessage = (error as Error).message
    const [context] = await db.select({
      userId: aiTasks.userId,
      projectId: aiTasks.projectId,
      type: aiTasks.type,
      stage: aiTasks.stage,
    }).from(aiTasks).where(eq(aiTasks.id, taskId)).limit(1).catch(() => [])
    console.error(
      `[${errorId}] AI 任务失败 task=${taskId} user=${context?.userId ?? 'unknown'} project=${context?.projectId ?? 'unknown'} type=${context?.type ?? 'unknown'} stage=${context?.stage ?? 'unknown'}:`,
      internalMessage,
    )
    await db.update(aiTasks).set({
      status: 'failed',
      stage: '生成失败',
      errorId,
      errorMessage: '任务生成失败，请重试；如问题持续，请凭错误编号联系管理员。',
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(aiTasks.id, taskId)).catch(() => {})
  } finally {
    running.delete(taskId)
  }
}

function scheduleTask(taskId: string) {
  setImmediate(() => { void executeTask(taskId) })
}

export async function createAiTask(user: AiTaskUser, input: CreateAiTaskInput) {
  const access = await userCanAccessProject(user, input.projectId)
  if (!access.allowed || !access.project) throw Object.assign(new Error(access.reason), { status: access.project ? 403 : 404, code: access.project ? 'FORBIDDEN' : 'NOT_FOUND' })
  if (input.conversationId) {
    const [conversation] = await db.select().from(chatConversations)
      .where(and(eq(chatConversations.id, input.conversationId), eq(chatConversations.userId, user.uid)))
      .limit(1)
    if (!conversation) throw Object.assign(new Error('会话不存在或不属于当前用户'), { status: 404, code: 'CONVERSATION_NOT_FOUND' })
    if (conversation.projectId && conversation.projectId !== input.projectId) {
      throw Object.assign(new Error('会话所属项目与任务项目不一致'), { status: 409, code: 'CONVERSATION_PROJECT_MISMATCH' })
    }
  }
  const template = AI_TEMPLATE_CATALOG[input.type]
  assertAiTemplateReferences(template)
  await loadAiSkill(template.skillName)
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
    }).returning()
    await writeTaskAudit(user, '创建 AI 任务', `${template.label}：${access.project.name}`)
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
  const task = await getTaskRow(userId, taskId)
  if (!task) return undefined
  const artifacts = await db.select().from(aiArtifacts).where(eq(aiArtifacts.taskId, task.id)).orderBy(desc(aiArtifacts.createdAt))
  const sources = await db.select().from(aiTaskSources).where(eq(aiTaskSources.taskId, task.id)).orderBy(asc(aiTaskSources.createdAt))
  return { ...task, artifacts: artifacts.map(publicArtifact), sources }
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
  await db.update(aiTasks).set({
    cancellationRequested: true,
    ...(task.status === 'pending' ? { status: 'cancelled', stage: '已取消', completedAt: new Date() } : {}),
    updatedAt: new Date(),
  }).where(eq(aiTasks.id, taskId))
  await writeTaskAudit(user, '取消 AI 任务', taskId)
  return getAiTask(user.uid, taskId)
}

export async function retryAiTask(user: AiTaskUser, taskId: string, idempotencyKey: string) {
  const task = await getTaskRow(user.uid, taskId)
  if (!task) return undefined
  if (!isAiBusinessTaskType(task.type)) throw new Error('不支持重试的任务类型')
  if (task.status !== 'failed') {
    throw Object.assign(new Error('只有失败任务可以重试'), { status: 409, code: 'TASK_NOT_RETRYABLE' })
  }
  return createAiTask(user, {
    type: task.type,
    projectId: task.projectId,
    conversationId: task.conversationId ?? undefined,
    parameters: task.parameters as Record<string, unknown>,
    idempotencyKey,
    retryOfTaskId: task.id,
  })
}

export async function listAiArtifacts(userId: string, projectId?: string) {
  const conditions = [eq(aiArtifacts.userId, userId), eq(aiArtifacts.archived, false)]
  if (projectId) conditions.push(eq(aiArtifacts.projectId, projectId))
  const rows = await db.select().from(aiArtifacts).where(and(...conditions)).orderBy(desc(aiArtifacts.createdAt)).limit(100)
  return rows.map(publicArtifact)
}

export async function getArtifactDownload(userId: string, artifactId: string) {
  const [artifact] = await db.select().from(aiArtifacts)
    .where(and(eq(aiArtifacts.id, artifactId), eq(aiArtifacts.userId, userId), eq(aiArtifacts.archived, false)))
    .limit(1)
  if (!artifact || artifact.qualityStatus !== 'passed') return undefined
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
  const recoverable = await db.select({ id: aiTasks.id }).from(aiTasks)
    .where(inArray(aiTasks.status, ['pending', 'running']))
    .orderBy(asc(aiTasks.createdAt))
    .limit(100)
  for (const task of recoverable) {
    await db.update(aiTasks).set({ status: 'pending', stage: '等待恢复', updatedAt: new Date() }).where(eq(aiTasks.id, task.id))
    scheduleTask(task.id)
  }
}
