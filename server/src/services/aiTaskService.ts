import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import JSZip from 'jszip'
import { db } from '../db/client.js'
import { aiArtifacts, aiTaskSources, aiTasks, auditLogs, chatConversations, knowledgeChunks, projects, users } from '../db/schema.js'
import { composeBusinessContent, type EvidenceSource } from './aiBusinessContentService.js'
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
import { cleanCorruptedText } from './textQualityService.js'

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

async function sourcesForProject(projectId: string, sourceCutoffDate: string): Promise<EvidenceSource[]> {
  const cutoff = new Date(`${sourceCutoffDate}T23:59:59.999Z`)
  const rows = await db.select().from(knowledgeChunks)
    .where(and(
      eq(knowledgeChunks.scope, 'project'),
      eq(knowledgeChunks.refId, projectId),
      lte(knowledgeChunks.createdAt, cutoff),
    ))
    .orderBy(asc(knowledgeChunks.sourceName), asc(knowledgeChunks.chunkIndex))
    .limit(40)
  return rows.map((row) => ({
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceName: row.sourceName || '项目资料',
    chunkIndex: row.chunkIndex,
    content: row.content,
  }))
}

export function screenEvidenceSources(sources: EvidenceSource[]) {
  const rejected: Array<{ sourceName: string; chunkIndex?: number; reason: string }> = []
  const usable = sources.flatMap((source) => {
    const quality = cleanCorruptedText(source.content)
    if (!quality.corrupted) return [{ ...source, content: quality.cleaned }]
    if (quality.usable && quality.cleaned) {
      rejected.push({
        sourceName: source.sourceName,
        chunkIndex: source.chunkIndex,
        reason: '片段含损坏字符，已删除损坏片段后使用剩余可读内容',
      })
      return [{ ...source, content: quality.cleaned }]
    }
    rejected.push({
      sourceName: source.sourceName,
      chunkIndex: source.chunkIndex,
      reason: '片段编码异常，已从本次生成中排除',
    })
    return []
  })
  return { usable, rejected }
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

async function inspectGeneratedArtifact(filePath: string, format: 'docx' | 'pptx') {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile() || fileStat.size < 1000) throw new Error('生成文件为空或不完整')
  const zip = await JSZip.loadAsync(await import('node:fs/promises').then((fs) => fs.readFile(filePath)))
  if (format === 'docx') {
    if (!zip.file('word/document.xml')) throw new Error('DOCX 缺少 document.xml')
    const documentXml = await zip.file('word/document.xml')!.async('string')
    if (!documentXml.includes('<w:t')) throw new Error('DOCX 没有可编辑文本')
    if (documentXml.includes('\uFFFD')) throw new Error('DOCX 正文包含损坏的 Unicode 字符')
    if (/w:eastAsia="Arial Unicode MS"/.test(documentXml)) throw new Error('DOCX 使用了不兼容的中文字体')
    return {
      qualityStatus: 'passed',
      metadata: { bytes: fileStat.size, editableText: true, encodingClean: true, cjkFontValidated: true },
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
    const knowledgeSources = await sourcesForProject(project.id, sourceCutoffDate)
    const rawSources: EvidenceSource[] = [
      ...(project.updatedAt.toISOString().slice(0, 10) <= sourceCutoffDate ? [{
        sourceType: 'project_record',
        sourceId: project.id,
        sourceName: '项目档案',
        chunkIndex: 0,
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
    const evidenceScreening = screenEvidenceSources(rawSources)
    const sources = evidenceScreening.usable
    if (await cancelIfRequested(taskId)) return

    await updateStage(taskId, '生成结构化内容', 35)
    const content = await composeBusinessContent({
      type: task.type,
      template,
      skill,
      project,
      sources,
      sourceCutoffDate,
      parameters,
    })
    if (evidenceScreening.rejected.length) {
      const affectedFiles = [...new Set(evidenceScreening.rejected.map((item) => item.sourceName))]
      content.missing = [
        ...content.missing,
        `有 ${evidenceScreening.rejected.length} 个知识片段存在编码异常，已自动排除损坏内容；请重新上传原文件：${affectedFiles.slice(0, 5).join('、')}`,
      ]
    }
    if (await cancelIfRequested(taskId)) return

    await updateStage(taskId, template.outputFormat === 'pptx' ? '生成可编辑 PPTX' : '生成 DOCX', 68)
    const taskDir = path.join(ARTIFACT_ROOT, task.userId, task.projectId, task.id)
    await mkdir(taskDir, { recursive: true })
    const fileName = makeArtifactFileName(project.name, template)
    const outputPath = path.join(taskDir, fileName)
    let previewPath: string | undefined
    let previewMetadata: Record<string, unknown> | undefined
    const generationMetadata = template.outputFormat === 'pptx'
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
      })
    if (await cancelIfRequested(taskId)) return

    await updateStage(taskId, '执行文件质量检查', 88)
    const quality = await inspectGeneratedArtifact(outputPath, template.outputFormat)
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
        referenceTemplate: path.basename(template.referencePath),
        skillName: skill.name,
        skillVersion: skill.version,
        skillSha256: skill.sha256,
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
          referenceTemplate: path.basename(template.referencePath),
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
      if (markdownStat.size < 200 || !markdown.includes(template.disclaimer)) throw new Error('合规说明 Markdown 预览不完整')
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
          skillName: skill.name,
          skillVersion: skill.version,
          skillSha256: skill.sha256,
        },
      })
    }
    if (sources.length) {
      await db.insert(aiTaskSources).values(sources.map((source, index) => ({
        taskId: task.id,
        artifactId: artifact.id,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceName: source.sourceName,
        locator: `知识片段 ${source.chunkIndex ?? index}`,
        verificationStatus: '资料记载',
      })))
    }
    await db.update(aiTasks).set({
      status: 'succeeded',
      stage: '生成完成',
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
