import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { AlignmentType, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../db/client.js'
import { auditLogs, companyKnowledge, digitalTwinAssetArchives, digitalTwinConversations, digitalTwinInvocationLogs, digitalTwinLearningCandidates, digitalTwinPublications, digitalTwinSkills, digitalTwinSkillVersions, digitalTwinUpdateCandidates, digitalTwins, digitalTwinVersions, dueDiligenceInterviewArtifacts, dueDiligenceInterviewPrompts, dueDiligenceInterviewTranscripts, dueDiligenceInterviews, dueDiligenceQuestionEvidence, dueDiligenceQuestionPacks, dueDiligenceQuestions, personalNotes, projectFiles, projectMembers, projects, risks, users } from '../db/schema.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireAccessibleProject } from '../services/projectAccessService.js'
import { parseShanghaiDateTime } from '../utils/shanghaiTime.js'
import { createConversation } from '../services/conversationService.js'
import { fetchAiGatewayChatCompatible } from '../services/aiGatewayService.js'

export const dueDiligenceRouter = Router()
const routeId = (value: string | string[]) => z.string().uuid().parse(value)
const actor = (req: AuthedRequest) => ({ userId: req.user!.uid, userName: req.user!.name })

async function audit(req: AuthedRequest, action: string, target: string) {
  const current = actor(req)
  await db.insert(auditLogs).values({ userId: current.userId, userName: current.userName, module: '尽调工作台', action, target })
}

async function validateProjectLinks(projectId: string, riskId?: string | null, fileId?: string | null) {
  if (riskId) {
    const [risk] = await db.select({ id: risks.id }).from(risks).where(and(eq(risks.id, riskId), eq(risks.projectId, projectId))).limit(1)
    if (!risk) throw Object.assign(new Error('关联风险不存在或不属于当前项目'), { status: 400, code: 'INVALID_RISK_LINK' })
  }
  if (fileId) {
    const [file] = await db.select({ id: projectFiles.id }).from(projectFiles).where(and(eq(projectFiles.id, fileId), eq(projectFiles.projectId, projectId))).limit(1)
    if (!file) throw Object.assign(new Error('关联材料不存在或不属于当前项目'), { status: 400, code: 'INVALID_FILE_LINK' })
  }
}

async function projectMember(projectId: string, userId?: string | null) {
  if (!userId) return null
  const [member] = await db.select({ id: users.id, name: users.name }).from(projectMembers).innerJoin(users, eq(users.id, projectMembers.userId))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId), eq(users.status, '启用'))).limit(1)
  if (!member) throw Object.assign(new Error('负责人必须是当前项目的启用成员'), { status: 400, code: 'INVALID_ASSIGNEE' })
  return member
}

const QuestionSchema = z.object({
  title: z.string().trim().min(1).max(255), category: z.string().trim().min(1).max(32).default('业务'),
  priority: z.enum(['高', '中', '低']).default('中'), status: z.enum(['待核查', '已完成']).default('待核查'),
  evidenceRequirement: z.string().trim().max(4000).optional().default(''), assigneeName: z.string().trim().max(64).optional().default(''), assigneeUserId: z.string().uuid().nullable().optional(),
  riskId: z.string().uuid().nullable().optional(), fileId: z.string().uuid().nullable().optional(), fileIds: z.array(z.string().uuid()).max(20).optional().default([]), source: z.string().trim().max(32).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), conclusion: z.string().trim().max(8000).optional().default(''), followUpNote: z.string().trim().max(8000).optional().default(''),
})
const QuestionPatchSchema = QuestionSchema.partial().extend({ expectedVersion: z.number().int().positive() }).strict()
const InterviewSchema = z.object({
  title: z.string().trim().min(1).max(255), mode: z.enum(['现场', '远程']).default('现场'), status: z.enum(['筹备中', '进行中', '已结束']).default('筹备中'),
  scheduledAt: z.string().min(1).nullable().optional(), agenda: z.string().trim().max(8000).optional().default(''), notes: z.string().max(30000).optional().default(''), summary: z.string().max(12000).optional().default(''),
  counterparty: z.string().trim().max(255).optional().default(''), location: z.string().trim().max(512).optional().default(''), participantNames: z.array(z.string().trim().min(1).max(64)).max(30).optional().default([]),
})
const InterviewPatchSchema = InterviewSchema.partial().extend({ expectedVersion: z.number().int().positive() }).strict()

dueDiligenceRouter.get('/projects/:projectId/members', async (req: AuthedRequest, res, next) => {
  try { const projectId = routeId(req.params.projectId); await requireAccessibleProject(req.user!.uid, projectId); res.json({ list: await db.select({ id: users.id, name: users.name, role: projectMembers.memberRole }).from(projectMembers).innerJoin(users, eq(users.id, projectMembers.userId)).where(and(eq(projectMembers.projectId, projectId), eq(users.status, '启用'))).orderBy(users.name) }) } catch (error) { next(error) }
})

dueDiligenceRouter.get('/projects/:projectId/questions', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); await requireAccessibleProject(req.user!.uid, projectId)
    const list = await db.select().from(dueDiligenceQuestions).where(eq(dueDiligenceQuestions.projectId, projectId)).orderBy(asc(dueDiligenceQuestions.sortOrder), desc(dueDiligenceQuestions.createdAt))
    const evidence = list.length ? await db.select().from(dueDiligenceQuestionEvidence).where(inArray(dueDiligenceQuestionEvidence.questionId, list.map(item => item.id))) : []
    res.json({ list: list.map(item => ({ ...item, status: item.status === '已完成' ? '已完成' : '待核查', fileIds: evidence.filter(link => link.questionId === item.id).map(link => link.fileId) })) })
  } catch (error) { next(error) }
})

dueDiligenceRouter.post('/projects/:projectId/questions', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); await requireAccessibleProject(req.user!.uid, projectId)
    const body = QuestionSchema.parse(req.body); const current = actor(req); await validateProjectLinks(projectId, body.riskId, body.fileId)
    for (const fileId of body.fileIds) await validateProjectLinks(projectId, null, fileId)
    const assignee = await projectMember(projectId, body.assigneeUserId)
    const { fileIds, assigneeUserId, ...question } = body
    const id = await db.transaction(async tx => { const [inserted] = await tx.insert(dueDiligenceQuestions).values({ ...question, projectId, createdBy: current.userId, assigneeUserId: assignee?.id ?? null, assigneeName: assignee?.name ?? (question.assigneeName || null), riskId: body.riskId ?? null, fileId: body.fileId ?? null }).$returningId(); if (fileIds.length) await tx.insert(dueDiligenceQuestionEvidence).values(fileIds.map(fileId => ({ id: randomUUID(), questionId: inserted.id, fileId }))); return inserted.id })
    const [row] = await db.select().from(dueDiligenceQuestions).where(eq(dueDiligenceQuestions.id, id)).limit(1)
    await audit(req, '创建核查问题', body.title); res.status(201).json(row)
  } catch (error) { next(error) }
})

dueDiligenceRouter.patch('/projects/:projectId/questions/:id', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const id = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId)
    const { expectedVersion, fileIds, assigneeUserId, ...body } = QuestionPatchSchema.parse(req.body); await validateProjectLinks(projectId, body.riskId, body.fileId)
    if (fileIds) for (const fileId of fileIds) await validateProjectLinks(projectId, null, fileId)
    const assignee = await projectMember(projectId, assigneeUserId)
    const patch = { ...body, ...(assigneeUserId !== undefined ? { assigneeUserId: assignee?.id ?? null, assigneeName: assignee?.name ?? body.assigneeName ?? null } : {}), version: sql`${dueDiligenceQuestions.version} + 1`, updatedAt: new Date() }
    const [result] = await db.update(dueDiligenceQuestions).set(patch).where(and(eq(dueDiligenceQuestions.id, id), eq(dueDiligenceQuestions.projectId, projectId), eq(dueDiligenceQuestions.version, expectedVersion)))
    if (result.affectedRows !== 1) throw Object.assign(new Error('核查问题已被更新，请刷新后重试'), { status: 409, code: 'VERSION_CONFLICT' })
    if (fileIds) { await db.delete(dueDiligenceQuestionEvidence).where(eq(dueDiligenceQuestionEvidence.questionId, id)); if (fileIds.length) await db.insert(dueDiligenceQuestionEvidence).values(fileIds.map(fileId => ({ id: randomUUID(), questionId: id, fileId }))) }
    const [row] = await db.select().from(dueDiligenceQuestions).where(eq(dueDiligenceQuestions.id, id)).limit(1)
    if (row.status === '已完成') await createCurrentUserExperienceCandidate(req.user!.uid, { projectId, sourceHash: `${id}:v${row.version}`, sourceName: `核查结论：${row.title}`, sourceType: '已完成核查', sourceKey: `question:${id}:v${row.version}`, topic: row.category || '尽调核验', confidence: 78, excerpt: `${row.title}\n结论：${row.conclusion || ''}\n备注：${row.followUpNote || ''}` })
    await audit(req, '更新核查问题', id); res.json(row)
  } catch (error) { next(error) }
})
dueDiligenceRouter.delete('/projects/:projectId/questions/:id', async (req: AuthedRequest, res, next) => {
  try { const projectId = routeId(req.params.projectId); const id = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId); const [result] = await db.delete(dueDiligenceQuestions).where(and(eq(dueDiligenceQuestions.id, id), eq(dueDiligenceQuestions.projectId, projectId))); if (result.affectedRows !== 1) throw Object.assign(new Error('核查问题不存在或已删除'), { status: 404, code: 'NOT_FOUND' }); await audit(req, '删除核查问题', id); res.status(204).end() } catch (error) { next(error) }
})
dueDiligenceRouter.post('/projects/:projectId/questions/reorder', async (req: AuthedRequest, res, next) => {
  try { const projectId = routeId(req.params.projectId); await requireAccessibleProject(req.user!.uid, projectId); const ids = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).parse(req.body).ids; const rows = await db.select({ id: dueDiligenceQuestions.id }).from(dueDiligenceQuestions).where(eq(dueDiligenceQuestions.projectId, projectId)); if (rows.length !== ids.length || rows.some(row => !ids.includes(row.id))) throw Object.assign(new Error('排序清单与当前项目问题不一致，请刷新后重试'), { status: 409, code: 'QUESTION_LIST_CONFLICT' }); await db.transaction(async tx => { for (const [index, id] of ids.entries()) await tx.update(dueDiligenceQuestions).set({ sortOrder: index + 1, updatedAt: new Date() }).where(eq(dueDiligenceQuestions.id, id)) }); await audit(req, '调整核查问题顺序', projectId); res.json({ ok: true }) } catch (error) { next(error) }
})

const GeneratedQuestionSchema = z.object({
  title: z.string().trim().min(1).max(255), category: z.enum(['业务', '财务', '法务', '团队', '技术', '合规']).default('业务'), priority: z.enum(['高', '中', '低']).default('中'),
  evidenceRequirement: z.string().trim().min(1).max(4000), rationale: z.string().trim().min(1).max(2000), sourceNames: z.array(z.string().trim().min(1).max(255)).max(8).default([]), publicationIds: z.array(z.string().uuid()).max(5).default([]),
})
const QuestionPackGenerateSchema = z.object({ fileIds: z.array(z.string().uuid()).max(30).optional().default([]), publicationIds: z.array(z.string().uuid()).max(5).optional().default([]), title: z.string().trim().max(255).optional() })

async function generateQuestionPack(projectId: string, userId: string, body: z.infer<typeof QuestionPackGenerateSchema>) {
  const [project] = await db.select({ name: projects.name, companyName: projects.companyName, industry: projects.industry, summary: projects.summary }).from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw Object.assign(new Error('项目不存在'), { status: 404, code: 'NOT_FOUND' })
  const files = await db.select({ id: projectFiles.id, name: projectFiles.name, contentText: projectFiles.contentText, parseStatus: projectFiles.parseStatus }).from(projectFiles).where(eq(projectFiles.projectId, projectId))
  const selected = (body.fileIds.length ? files.filter(file => body.fileIds.includes(file.id)) : files).filter(file => file.parseStatus === '成功' && file.contentText?.trim())
  if (!selected.length) throw Object.assign(new Error('请选择至少一份已解析成功的项目材料后再生成'), { status: 400, code: 'NO_PARSED_MATERIAL' })
  const sourceText = selected.map(file => `【${file.name}】\n${file.contentText?.slice(0, 18000)}`).join('\n\n').slice(0, 120000)
  const publications = body.publicationIds.length ? await db.select({ id: digitalTwinPublications.id, ownerName: users.name, version: digitalTwinPublications.publishedVersion, introduction: digitalTwinPublications.introduction, rules: digitalTwinPublications.publicRules, cases: digitalTwinPublications.publicCases, industryTags: digitalTwinPublications.industryTags, capabilityTags: digitalTwinPublications.capabilityTags }).from(digitalTwinPublications).innerJoin(users, eq(users.id, digitalTwinPublications.ownerUserId)).where(and(inArray(digitalTwinPublications.id, body.publicationIds), eq(digitalTwinPublications.status, '已发布'))) : []
  if (publications.length !== body.publicationIds.length) throw Object.assign(new Error('所选公司分身已撤回或不存在，请刷新后重试'), { status: 409, code: 'TWIN_PUBLICATION_UNAVAILABLE' })
  const twinContext = publications.length ? `\n【已选择的公司分身公开建议】\n${publications.map(item => `- ${item.ownerName}分身 v${item.version}（ID:${item.id}）：${item.introduction}\n关注规则：${item.rules}\n适用边界：${item.cases}\n标签：${[...item.industryTags, ...item.capabilityTags].join('、')}`).join('\n')}` : ''
  let response: Response
  try { response = await fetchAiGatewayChatCompatible((process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, ''), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY || process.env.LLM_API_KEY}` } : {}) },
    body: JSON.stringify({ model: process.env.LLM_MODEL || 'claude-sonnet-4-6', response_format: { type: 'json_object' }, max_tokens: 12000, messages: [
      { role: 'system', content: '你是股权投资商业尽调负责人。仅依据提供材料和公司分身的公开建议生成专业尽调问题清单；不得编造事实。覆盖业务、财务、法务、团队、技术、合规六类，优先识别证据缺口、矛盾与投资风险。每题必须明确核查目标与所需证据。若某题对应某个公开分身的关注点，填其 publicationIds；否则为空。只返回 JSON：{"title":"","questions":[{"title":"","category":"业务|财务|法务|团队|技术|合规","priority":"高|中|低","evidenceRequirement":"","rationale":"","sourceNames":[""],"publicationIds":[""]}]}' },
      { role: 'user', content: `项目：${JSON.stringify(project)}\n材料：\n${sourceText}${twinContext}` },
    ] }), signal: AbortSignal.timeout(180_000),
  }, fetch, 180_000) } catch (error) {
    throw Object.assign(new Error('本地 AI 模型网关未启动或无法连接。请启动已配置的模型服务后重试。'), { status: 503, code: 'AI_GATEWAY_UNAVAILABLE', cause: error })
  }
  if (!response.ok) throw Object.assign(new Error(`模型生成失败（HTTP ${response.status}）`), { status: 502, code: 'MODEL_UNAVAILABLE' })
  const raw = ((await response.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content?.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '')
  let payload: unknown; try { payload = JSON.parse(raw || '') } catch { throw Object.assign(new Error('模型未返回可用的尽调清单结构'), { status: 502, code: 'MODEL_INVALID_OUTPUT' }) }
  const output = z.object({ title: z.string().trim().min(1).max(255).default(`${project.name}尽调问题清单`), questions: z.array(GeneratedQuestionSchema).min(1).max(120) }).parse(payload)
  const id = randomUUID(); const priorityRank = { 高: 0, 中: 1, 低: 2 }; const publicationMap = new Map(publications.map(item => [item.id, `${item.ownerName}分身 v${item.version} 关注：${item.introduction}`])); const ordered = [...output.questions].map(question => ({ ...question, publicationIds: question.publicationIds.filter(value => publicationMap.has(value)), attentionSource: question.publicationIds.filter(value => publicationMap.has(value)).map(value => publicationMap.get(value)).join('；') || '项目材料分析' })).sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority])
  await db.transaction(async tx => { await tx.insert(dueDiligenceQuestionPacks).values({ id, projectId, createdBy: userId, title: body.title || output.title, sourceFileIds: selected.map(file => file.id), questions: ordered }); const existing = await tx.select({ count: sql<number>`count(*)` }).from(dueDiligenceQuestions).where(eq(dueDiligenceQuestions.projectId, projectId)); const start = Number(existing[0]?.count ?? 0); await tx.insert(dueDiligenceQuestions).values(ordered.map((question, index) => ({ id: randomUUID(), projectId, title: question.title, category: question.category, priority: question.priority, evidenceRequirement: question.evidenceRequirement, attentionSource: question.attentionSource, source: 'AI生成', sortOrder: start + index + 1, createdBy: userId, fileId: selected[0]?.id ?? null }))); if (publications.length) await tx.insert(digitalTwinInvocationLogs).values(publications.map(item => ({ id: randomUUID(), publicationId: item.id, callerUserId: userId, projectId, usage: '问题清单生成', inputSummary: `项目：${project.name}；材料：${selected.map(file => file.name).join('、').slice(0, 1000)}`, outputSummary: `生成 ${ordered.length} 条问题` }))) })
  return { id, projectId, title: body.title || output.title, sourceFileIds: selected.map(file => file.id), questions: ordered, created: ordered.length }
}

dueDiligenceRouter.post('/projects/:projectId/question-packs/generate', async (req: AuthedRequest, res, next) => {
  try { const projectId = routeId(req.params.projectId); await requireAccessibleProject(req.user!.uid, projectId); const pack = await generateQuestionPack(projectId, req.user!.uid, QuestionPackGenerateSchema.parse(req.body)); await audit(req, 'AI生成尽调问题清单', pack.title); res.status(201).json(pack) } catch (error) { next(error) }
})
dueDiligenceRouter.post('/projects/:projectId/question-packs/:id/apply', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const id = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId)
    const [pack] = await db.select().from(dueDiligenceQuestionPacks).where(and(eq(dueDiligenceQuestionPacks.id, id), eq(dueDiligenceQuestionPacks.projectId, projectId))).limit(1)
    if (!pack) throw Object.assign(new Error('尽调问题清单不存在'), { status: 404, code: 'NOT_FOUND' })
    await db.transaction(async tx => { await tx.insert(dueDiligenceQuestions).values(pack.questions.map(question => ({ id: randomUUID(), projectId, title: question.title, category: question.category, priority: question.priority, evidenceRequirement: question.evidenceRequirement, source: 'AI生成', createdBy: req.user!.uid, fileId: pack.sourceFileIds[0] ?? null }))) })
    await audit(req, '批量写入AI尽调问题', pack.title); res.json({ created: pack.questions.length })
  } catch (error) { next(error) }
})
dueDiligenceRouter.get('/projects/:projectId/question-packs/:id/docx', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const id = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId)
    const [pack] = await db.select().from(dueDiligenceQuestionPacks).where(and(eq(dueDiligenceQuestionPacks.id, id), eq(dueDiligenceQuestionPacks.projectId, projectId))).limit(1)
    const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1); if (!pack || !project) throw Object.assign(new Error('尽调问题清单不存在'), { status: 404, code: 'NOT_FOUND' })
    const rows = [new TableRow({ children: ['序号', '核查问题', '类别', '优先级', '关注来源', '核查目标与所需证据'].map(text => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })] })) }), ...pack.questions.map((question, index) => new TableRow({ children: [String(index + 1), question.title, question.category, question.priority, question.attentionSource || '项目材料分析', `${question.rationale}\n证据：${question.evidenceRequirement}`].map(text => new TableCell({ children: [new Paragraph(text)] })) }))]
    const references = [...new Set(pack.questions.flatMap(question => question.attentionSource && question.attentionSource !== '项目材料分析' ? [question.attentionSource] : []))]
    const doc = new Document({ sections: [{ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: pack.title, bold: true, size: 32, font: '黑体' })] }), new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(`项目：${project.name}    生成日期：${new Date().toLocaleDateString('zh-CN')}`)] }), new Paragraph({ text: `本清单由平台模型基于所选项目材料生成。参考公开分身：${references.join('；') || '无'}。分身建议仅供辅助判断，请人工复核。` }), new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows })] }] })
    const buffer = await Packer.toBuffer(doc); await audit(req, '导出AI尽调问题Word', pack.title); res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${pack.title}.docx`)}`); res.send(buffer)
  } catch (error) { next(error) }
})

dueDiligenceRouter.get('/projects/:projectId/interviews', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); await requireAccessibleProject(req.user!.uid, projectId)
    const list = await db.select().from(dueDiligenceInterviews).where(eq(dueDiligenceInterviews.projectId, projectId)).orderBy(asc(dueDiligenceInterviews.sortOrder), desc(dueDiligenceInterviews.createdAt))
    const prompts = await Promise.all(list.map(async interview => ({ interviewId: interview.id, list: await db.select().from(dueDiligenceInterviewPrompts).where(eq(dueDiligenceInterviewPrompts.interviewId, interview.id)).orderBy(desc(dueDiligenceInterviewPrompts.createdAt)) })))
    const artifacts = await Promise.all(list.map(async interview => ({ interviewId: interview.id, list: await db.select({ id: dueDiligenceInterviewArtifacts.id, interviewId: dueDiligenceInterviewArtifacts.interviewId, fileId: dueDiligenceInterviewArtifacts.fileId, kind: dueDiligenceInterviewArtifacts.kind, source: dueDiligenceInterviewArtifacts.source, durationSeconds: dueDiligenceInterviewArtifacts.durationSeconds, name: projectFiles.name, createdAt: dueDiligenceInterviewArtifacts.createdAt }).from(dueDiligenceInterviewArtifacts).innerJoin(projectFiles, eq(projectFiles.id, dueDiligenceInterviewArtifacts.fileId)).where(eq(dueDiligenceInterviewArtifacts.interviewId, interview.id)).orderBy(desc(dueDiligenceInterviewArtifacts.createdAt)) })))
    const transcriptRows = list.length ? await db.select().from(dueDiligenceInterviewTranscripts).where(inArray(dueDiligenceInterviewTranscripts.interviewId, list.map(item => item.id))) : []
    res.json({ list, prompts, artifacts, transcripts: transcriptRows })
  } catch (error) { next(error) }
})

dueDiligenceRouter.post('/projects/:projectId/interviews', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); await requireAccessibleProject(req.user!.uid, projectId)
    const body = InterviewSchema.parse(req.body); const scheduledAt = body.scheduledAt ? parseShanghaiDateTime(body.scheduledAt) : null
    const [last] = await db.select({ sortOrder: dueDiligenceInterviews.sortOrder }).from(dueDiligenceInterviews).where(eq(dueDiligenceInterviews.projectId, projectId)).orderBy(desc(dueDiligenceInterviews.sortOrder)).limit(1)
    const [inserted] = await db.insert(dueDiligenceInterviews).values({ ...body, scheduledAt, sortOrder: (last?.sortOrder ?? 0) + 1, projectId, createdBy: req.user!.uid }).$returningId()
    const importedFiles = await db.select({ id: projectFiles.id }).from(projectFiles).where(eq(projectFiles.projectId, projectId))
    if (importedFiles.length) await db.insert(dueDiligenceInterviewArtifacts).values(importedFiles.map(file => ({ id: randomUUID(), interviewId: inserted.id, fileId: file.id, kind: '项目材料', source: 'manual', createdBy: req.user!.uid })))
    const [row] = await db.select().from(dueDiligenceInterviews).where(eq(dueDiligenceInterviews.id, inserted.id)).limit(1)
    await audit(req, '创建现场访谈', body.title); res.status(201).json(row)
  } catch (error) { next(error) }
})

dueDiligenceRouter.patch('/projects/:projectId/interviews/:id', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const id = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId)
    const { expectedVersion, scheduledAt, ...body } = InterviewPatchSchema.parse(req.body)
    const patch = { ...body, ...(scheduledAt !== undefined ? { scheduledAt: scheduledAt ? parseShanghaiDateTime(scheduledAt) : null } : {}), version: sql`${dueDiligenceInterviews.version} + 1`, updatedAt: new Date() }
    const [result] = await db.update(dueDiligenceInterviews).set(patch).where(and(eq(dueDiligenceInterviews.id, id), eq(dueDiligenceInterviews.projectId, projectId), eq(dueDiligenceInterviews.version, expectedVersion)))
    if (result.affectedRows !== 1) throw Object.assign(new Error('访谈记录已被更新，请刷新后重试'), { status: 409, code: 'VERSION_CONFLICT' })
    const [row] = await db.select().from(dueDiligenceInterviews).where(eq(dueDiligenceInterviews.id, id)).limit(1)
    if (row.status === '已结束' && row.summary?.trim()) await createCurrentUserExperienceCandidate(req.user!.uid, { projectId, sourceHash: `${id}:v${row.version}`, sourceName: `访谈纪要：${row.title}`, sourceType: '已确认访谈纪要', sourceKey: `interview:${id}:v${row.version}`, topic: '现场访谈判断', confidence: 82, excerpt: row.summary })
    await audit(req, '更新访谈记录', id); res.json(row)
  } catch (error) { next(error) }
})

dueDiligenceRouter.post('/projects/:projectId/interviews/reorder', async (req: AuthedRequest, res, next) => {
  try { const projectId = routeId(req.params.projectId); await requireAccessibleProject(req.user!.uid, projectId); const ids = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body).ids; const rows = await db.select({ id: dueDiligenceInterviews.id }).from(dueDiligenceInterviews).where(eq(dueDiligenceInterviews.projectId, projectId)); if (rows.length !== ids.length || rows.some(row => !ids.includes(row.id))) throw Object.assign(new Error('访谈排序已变化，请刷新后重试'), { status: 409, code: 'INTERVIEW_LIST_CONFLICT' }); await db.transaction(async tx => { for (const [index, id] of ids.entries()) await tx.update(dueDiligenceInterviews).set({ sortOrder: index + 1, updatedAt: new Date() }).where(eq(dueDiligenceInterviews.id, id)) }); await audit(req, '调整访谈顺序', projectId); res.json({ ok: true }) } catch (error) { next(error) }
})
dueDiligenceRouter.delete('/projects/:projectId/interviews/:id', async (req: AuthedRequest, res, next) => {
  try { const projectId = routeId(req.params.projectId); const id = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId); const [result] = await db.delete(dueDiligenceInterviews).where(and(eq(dueDiligenceInterviews.id, id), eq(dueDiligenceInterviews.projectId, projectId))); if (result.affectedRows !== 1) throw Object.assign(new Error('访谈不存在或已删除'), { status: 404, code: 'NOT_FOUND' }); await audit(req, '删除现场访谈', id); res.status(204).end() } catch (error) { next(error) }
})

const InterviewArtifactSchema = z.object({ fileId: z.string().uuid(), kind: z.enum(['项目材料', '录音', '转写', '纪要']), source: z.enum(['browser', 'provider', 'manual']).default('manual'), durationSeconds: z.number().int().min(0).max(86_400).nullable().optional() })
const TranscriptSchema = z.object({ content: z.string().max(200_000), source: z.enum(['browser', 'provider', 'manual']).default('browser'), status: z.enum(['草稿', '已确认']).default('草稿') })

async function requireInterview(projectId: string, interviewId: string) {
  const [interview] = await db.select().from(dueDiligenceInterviews).where(and(eq(dueDiligenceInterviews.id, interviewId), eq(dueDiligenceInterviews.projectId, projectId))).limit(1)
  if (!interview) throw Object.assign(new Error('访谈不存在'), { status: 404, code: 'NOT_FOUND' })
  return interview
}

dueDiligenceRouter.post('/projects/:projectId/interviews/:id/artifacts', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const interviewId = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId); await requireInterview(projectId, interviewId)
    const body = InterviewArtifactSchema.parse(req.body); await validateProjectLinks(projectId, null, body.fileId)
    const [existing] = await db.select({ id: dueDiligenceInterviewArtifacts.id }).from(dueDiligenceInterviewArtifacts).where(and(eq(dueDiligenceInterviewArtifacts.interviewId, interviewId), eq(dueDiligenceInterviewArtifacts.fileId, body.fileId))).limit(1)
    if (existing) { res.json({ id: existing.id, alreadyLinked: true }); return }
    const [inserted] = await db.insert(dueDiligenceInterviewArtifacts).values({ id: randomUUID(), interviewId, ...body, createdBy: req.user!.uid }).$returningId()
    const [row] = await db.select().from(dueDiligenceInterviewArtifacts).where(eq(dueDiligenceInterviewArtifacts.id, inserted.id)).limit(1)
    await audit(req, `归档访谈${body.kind}`, interviewId); res.status(201).json(row)
  } catch (error) { next(error) }
})

dueDiligenceRouter.delete('/projects/:projectId/interviews/:id/artifacts/:artifactId', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const interviewId = routeId(req.params.id); const artifactId = routeId(req.params.artifactId)
    await requireAccessibleProject(req.user!.uid, projectId); await requireInterview(projectId, interviewId)
    const [result] = await db.delete(dueDiligenceInterviewArtifacts).where(and(eq(dueDiligenceInterviewArtifacts.id, artifactId), eq(dueDiligenceInterviewArtifacts.interviewId, interviewId), eq(dueDiligenceInterviewArtifacts.kind, '项目材料')))
    if (result.affectedRows !== 1) throw Object.assign(new Error('访谈材料不存在或已移除'), { status: 404, code: 'NOT_FOUND' })
    await audit(req, '移除访谈项目材料引用', artifactId); res.status(204).end()
  } catch (error) { next(error) }
})

dueDiligenceRouter.put('/projects/:projectId/interviews/:id/transcript', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const interviewId = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId); await requireInterview(projectId, interviewId)
    const body = TranscriptSchema.parse(req.body)
    const [current] = await db.select().from(dueDiligenceInterviewTranscripts).where(eq(dueDiligenceInterviewTranscripts.interviewId, interviewId)).limit(1)
    if (current) {
      await db.update(dueDiligenceInterviewTranscripts).set({ ...body, version: sql`${dueDiligenceInterviewTranscripts.version} + 1`, updatedAt: new Date() }).where(eq(dueDiligenceInterviewTranscripts.id, current.id))
    } else {
      await db.insert(dueDiligenceInterviewTranscripts).values({ id: randomUUID(), interviewId, ...body, createdBy: req.user!.uid })
    }
    const [row] = await db.select().from(dueDiligenceInterviewTranscripts).where(eq(dueDiligenceInterviewTranscripts.interviewId, interviewId)).limit(1)
    await audit(req, '保存访谈转写稿', interviewId); res.json(row)
  } catch (error) { next(error) }
})

dueDiligenceRouter.post('/projects/:projectId/interviews/:id/summary/generate', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const interviewId = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId); const interview = await requireInterview(projectId, interviewId)
    const [transcript] = await db.select().from(dueDiligenceInterviewTranscripts).where(eq(dueDiligenceInterviewTranscripts.interviewId, interviewId)).limit(1)
    if (!transcript?.content.trim()) throw Object.assign(new Error('请先保存至少一段访谈转写'), { status: 400, code: 'EMPTY_TRANSCRIPT' })
    let response: Response
    try { response = await fetchAiGatewayChatCompatible((process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, ''), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY || process.env.LLM_API_KEY}` } : {}) }, body: JSON.stringify({ model: process.env.LLM_MODEL || 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'system', content: '你是股权投资尽调助理。仅根据转写整理简洁访谈纪要，按“确认事实、待核验事项、风险提示”输出；不得编造。' }, { role: 'user', content: `访谈：${interview.title}\n转写：\n${transcript.content.slice(0, 60000)}` }] }), signal: AbortSignal.timeout(120_000) }, fetch, 120_000) } catch (error) { throw Object.assign(new Error('模型服务暂不可用，转写已保留，可稍后再生成纪要。'), { status: 503, code: 'AI_GATEWAY_UNAVAILABLE', cause: error }) }
    if (!response.ok) throw Object.assign(new Error(`纪要生成失败（HTTP ${response.status}）`), { status: 502, code: 'MODEL_UNAVAILABLE' })
    const summary = ((await response.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content?.trim()
    if (!summary) throw Object.assign(new Error('模型未返回可用纪要'), { status: 502, code: 'MODEL_INVALID_OUTPUT' })
    await audit(req, '生成访谈纪要', interview.title); res.json({ summary })
  } catch (error) { next(error) }
})

dueDiligenceRouter.get('/projects/:projectId/interviews/:id/export/:kind', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const interviewId = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId)
    const kind = z.enum(['transcript', 'summary']).parse(req.params.kind); const interview = await requireInterview(projectId, interviewId)
    const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1)
    const [transcript] = await db.select().from(dueDiligenceInterviewTranscripts).where(eq(dueDiligenceInterviewTranscripts.interviewId, interviewId)).limit(1)
    const title = `${interview.title}${kind === 'transcript' ? '－访谈转写稿' : '－访谈纪要'}`
    const content = kind === 'transcript' ? transcript?.content : interview.summary
    if (!content?.trim()) throw Object.assign(new Error(kind === 'transcript' ? '暂无可导出的转写稿' : '暂无可导出的访谈纪要'), { status: 400, code: 'EMPTY_EXPORT' })
    const doc = new Document({ sections: [{ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: title, bold: true, size: 32, font: '黑体' })] }), new Paragraph(`项目：${project?.name ?? ''}`), new Paragraph(`访谈：${interview.title}`), new Paragraph(`导出时间：${new Date().toLocaleString('zh-CN')}`), new Paragraph({ text: content })] }] })
    const buffer = await Packer.toBuffer(doc); await audit(req, kind === 'transcript' ? '导出访谈转写Word' : '导出访谈纪要Word', interviewId)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${title}.docx`)}`); res.send(buffer)
  } catch (error) { next(error) }
})

dueDiligenceRouter.post('/projects/:projectId/interviews/:id/prompts', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const interviewId = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId)
    const body = z.object({ content: z.string().trim().min(1).max(4000), questionId: z.string().uuid().nullable().optional() }).parse(req.body)
    const [interview] = await db.select({ id: dueDiligenceInterviews.id }).from(dueDiligenceInterviews).where(and(eq(dueDiligenceInterviews.id, interviewId), eq(dueDiligenceInterviews.projectId, projectId))).limit(1)
    if (!interview) { res.status(404).json({ code: 'NOT_FOUND', message: '访谈不存在' }); return }
    const [inserted] = await db.insert(dueDiligenceInterviewPrompts).values({ interviewId, content: body.content, questionId: body.questionId ?? null, createdBy: req.user!.uid, createdByName: req.user!.name }).$returningId()
    const [row] = await db.select().from(dueDiligenceInterviewPrompts).where(eq(dueDiligenceInterviewPrompts.id, inserted.id)).limit(1)
    await audit(req, '提交远程插问', body.content); res.status(201).json(row)
  } catch (error) { next(error) }
})
dueDiligenceRouter.get('/projects/:projectId/interviews/:id/prompts', async (req: AuthedRequest, res, next) => {
  try { const projectId = routeId(req.params.projectId); const interviewId = routeId(req.params.id); await requireAccessibleProject(req.user!.uid, projectId); await requireInterview(projectId, interviewId); res.json({ list: await db.select().from(dueDiligenceInterviewPrompts).where(eq(dueDiligenceInterviewPrompts.interviewId, interviewId)).orderBy(desc(dueDiligenceInterviewPrompts.createdAt)) }) } catch (error) { next(error) }
})

dueDiligenceRouter.patch('/projects/:projectId/interviews/:id/prompts/:promptId', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.projectId); const interviewId = routeId(req.params.id); const promptId = routeId(req.params.promptId); await requireAccessibleProject(req.user!.uid, projectId)
    const { status, response } = z.object({ status: z.enum(['待确认', '已确认', '已忽略']), response: z.string().trim().max(4000).optional().default('') }).parse(req.body)
    const [interview] = await db.select({ id: dueDiligenceInterviews.id }).from(dueDiligenceInterviews).where(and(eq(dueDiligenceInterviews.id, interviewId), eq(dueDiligenceInterviews.projectId, projectId))).limit(1)
    if (!interview) { res.status(404).json({ code: 'NOT_FOUND', message: '访谈不存在' }); return }
    await db.update(dueDiligenceInterviewPrompts).set({ status, response, handledBy: req.user!.uid, handledAt: new Date() }).where(and(eq(dueDiligenceInterviewPrompts.id, promptId), eq(dueDiligenceInterviewPrompts.interviewId, interviewId)))
    await audit(req, '确认现场插问', status); res.json({ ok: true })
  } catch (error) { next(error) }
})

const PublicationSchema = z.object({ introduction: z.string().trim().min(1).max(1000), publicRules: z.string().trim().min(1).max(12000), publicCases: z.string().trim().max(12000).default(''), industryTags: z.array(z.string().trim().min(1).max(32)).max(12).default([]), capabilityTags: z.array(z.string().trim().min(1).max(32)).max(12).default([]) })
dueDiligenceRouter.get('/twin-directory', async (req: AuthedRequest, res, next) => {
  try { const list = await db.select({ id: digitalTwinPublications.id, twinId: digitalTwinPublications.twinId, ownerUserId: digitalTwinPublications.ownerUserId, ownerName: users.name, role: users.role, department: users.department, publishedVersion: digitalTwinPublications.publishedVersion, introduction: digitalTwinPublications.introduction, publicRules: digitalTwinPublications.publicRules, publicCases: digitalTwinPublications.publicCases, industryTags: digitalTwinPublications.industryTags, capabilityTags: digitalTwinPublications.capabilityTags, publishedAt: digitalTwinPublications.publishedAt }).from(digitalTwinPublications).innerJoin(users, eq(users.id, digitalTwinPublications.ownerUserId)).where(eq(digitalTwinPublications.status, '已发布')).orderBy(users.name); res.json({ list }) } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twin-directory/:id/invoke', async (req: AuthedRequest, res, next) => {
  try { const id = routeId(req.params.id); const body = z.object({ projectId: z.string().uuid().nullable().optional(), question: z.string().trim().min(1).max(4000) }).parse(req.body); if (body.projectId) await requireAccessibleProject(req.user!.uid, body.projectId); const [publication] = await db.select({ id: digitalTwinPublications.id, ownerName: users.name, version: digitalTwinPublications.publishedVersion, introduction: digitalTwinPublications.introduction, rules: digitalTwinPublications.publicRules, cases: digitalTwinPublications.publicCases }).from(digitalTwinPublications).innerJoin(users, eq(users.id, digitalTwinPublications.ownerUserId)).where(and(eq(digitalTwinPublications.id, id), eq(digitalTwinPublications.status, '已发布'))).limit(1); if (!publication) throw Object.assign(new Error('公司分身已撤回或不存在'), { status: 404, code: 'TWIN_PUBLICATION_UNAVAILABLE' }); const advice = `【${publication.ownerName}分身 v${publication.version}】\n公开关注点：${publication.rules}\n适用边界：${publication.cases || '未设置'}\n\n针对你的问题“${body.question}”，请优先按上述公开关注点核验事实、证据和反证。数字分身建议不替代负责人判断。`; await db.insert(digitalTwinInvocationLogs).values({ id: randomUUID(), publicationId: id, callerUserId: req.user!.uid, projectId: body.projectId ?? null, usage: '直接调用', inputSummary: body.question.slice(0, 1000), outputSummary: advice.slice(0, 2000) }); await audit(req, '调用公司数字分身', publication.ownerName); res.json({ advice, ownerName: publication.ownerName, version: publication.version }) } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/:id/publish', async (req: AuthedRequest, res, next) => {
  try { const id = routeId(req.params.id); const body = PublicationSchema.parse(req.body); const current = actor(req); const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, current.userId))).limit(1); if (!twin) throw Object.assign(new Error('数字分身不存在'), { status: 404, code: 'NOT_FOUND' }); const [existing] = await db.select().from(digitalTwinPublications).where(eq(digitalTwinPublications.twinId, id)).limit(1); if (existing) await db.update(digitalTwinPublications).set({ ...body, publishedVersion: twin.activeVersion, status: '已发布', publishedAt: new Date(), withdrawnAt: null }).where(eq(digitalTwinPublications.id, existing.id)); else await db.insert(digitalTwinPublications).values({ id: randomUUID(), twinId: id, ownerUserId: current.userId, publishedVersion: twin.activeVersion, ...body }); await audit(req, '发布公司数字分身', twin.name); res.json({ ok: true, version: twin.activeVersion }) } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/:id/withdraw-publication', async (req: AuthedRequest, res, next) => {
  try { const id = routeId(req.params.id); const current = actor(req); const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, current.userId))).limit(1); if (!twin) throw Object.assign(new Error('数字分身不存在'), { status: 404, code: 'NOT_FOUND' }); await db.update(digitalTwinPublications).set({ status: '已撤回', withdrawnAt: new Date() }).where(eq(digitalTwinPublications.twinId, id)); await audit(req, '撤回公司数字分身', twin.name); res.json({ ok: true }) } catch (error) { next(error) }
})
const TwinSchema = z.object({ name: z.string().trim().min(1).max(64), role: z.string().trim().min(1).max(64), rules: z.string().trim().max(30000), cases: z.string().trim().max(30000), source: z.enum(['manual', 'voice']).optional().default('manual') })

async function createExperienceCandidate(input: { twinId: string; ownerUserId: string; projectId: string; sourceFileId?: string | null; sourceHash: string; sourceName: string; sourceType: string; sourceKey: string; topic: string; confidence: number; excerpt: string }) {
  const [existing] = await db.select({ id: digitalTwinLearningCandidates.id }).from(digitalTwinLearningCandidates).where(and(eq(digitalTwinLearningCandidates.twinId, input.twinId), eq(digitalTwinLearningCandidates.sourceKey, input.sourceKey), eq(digitalTwinLearningCandidates.sourceHash, input.sourceHash))).limit(1)
  if (existing) return false
  const safeExcerpt = input.excerpt.replace(/\s+/g, ' ').slice(0, 1_200)
  await db.insert(digitalTwinLearningCandidates).values({ id: randomUUID(), twinId: input.twinId, ownerUserId: input.ownerUserId, projectId: input.projectId, sourceFileId: input.sourceFileId ?? null, sourceHash: input.sourceHash.slice(0, 64), sourceName: input.sourceName.slice(0, 255), sourceType: input.sourceType, sourceKey: input.sourceKey.slice(0, 128), topic: input.topic.slice(0, 128), confidence: Math.max(1, Math.min(100, input.confidence)), rules: `围绕“${input.topic}”形成投资判断时，先区分已核验事实、管理层口径与待补证假设；结论必须同时列出关键支持证据与反证。`, cases: `来源摘要：${safeExcerpt}`, boundaries: '仅作为个人私有经验候选；不得把原始材料、客户名称或未核验结论发布到公司分身。', rationale: `系统根据${input.sourceType}自动提炼，需由本人批量筛选确认后才写入分身。` })
  return true
}

async function scanExperienceMaterials(twinId: string, ownerUserId: string) {
  const sources = await db.select({ id: projectFiles.id, projectId: projectFiles.projectId, name: projectFiles.name, hash: projectFiles.sha256, text: projectFiles.contentText, category: projectFiles.category }).from(projectFiles).innerJoin(projectMembers, and(eq(projectMembers.projectId, projectFiles.projectId), eq(projectMembers.userId, ownerUserId))).where(and(eq(projectFiles.uploadedBy, ownerUserId), eq(projectFiles.parseStatus, '成功')))
  const eligible = sources.filter(file => file.hash && file.text?.trim() && /立项|尽调|报告/i.test(`${file.name} ${file.category}`)).slice(0, 30)
  let created = 0
  for (const file of eligible) if (await createExperienceCandidate({ twinId, ownerUserId, projectId: file.projectId, sourceFileId: file.id, sourceHash: file.hash!, sourceName: file.name, sourceType: '正式材料', sourceKey: `file:${file.id}`, topic: /财务|现金|回款/i.test(`${file.name} ${file.category}`) ? '财务核验' : '尽调判断', confidence: 86, excerpt: file.text! })) created += 1
  return { created, scanned: eligible.length }
}

async function createCurrentUserExperienceCandidate(userId: string, input: Omit<Parameters<typeof createExperienceCandidate>[0], 'twinId' | 'ownerUserId'>) {
  const [twin] = await db.select({ id: digitalTwins.id }).from(digitalTwins).where(eq(digitalTwins.ownerUserId, userId)).orderBy(desc(digitalTwins.updatedAt)).limit(1)
  if (!twin) return false
  return createExperienceCandidate({ ...input, twinId: twin.id, ownerUserId: userId })
}

dueDiligenceRouter.get('/twins', async (req: AuthedRequest, res, next) => {
  try { res.json({ list: await db.select().from(digitalTwins).where(and(eq(digitalTwins.ownerUserId, req.user!.uid), isNull(digitalTwins.deletedAt))).orderBy(desc(digitalTwins.updatedAt)) }) } catch (error) { next(error) }
})
dueDiligenceRouter.get('/twins/history', async (req: AuthedRequest, res, next) => {
  try { res.json({ list: await db.select().from(digitalTwinAssetArchives).where(eq(digitalTwinAssetArchives.ownerUserId, req.user!.uid)).orderBy(desc(digitalTwinAssetArchives.deletedAt)) }) } catch (error) { next(error) }
})
dueDiligenceRouter.get('/twins/:id/versions', async (req: AuthedRequest, res, next) => {
  try { const id = routeId(req.params.id); res.json({ list: await db.select().from(digitalTwinVersions).where(and(eq(digitalTwinVersions.twinId, id), eq(digitalTwinVersions.ownerUserId, req.user!.uid))).orderBy(desc(digitalTwinVersions.version)) }) } catch (error) { next(error) }
})

dueDiligenceRouter.post('/twins/:id/learning/scan', async (req: AuthedRequest, res, next) => {
  try {
    const twinId = routeId(req.params.id); const current = actor(req); const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, twinId), eq(digitalTwins.ownerUserId, current.userId))).limit(1); if (!twin) throw Object.assign(new Error('数字分身不存在'), { status: 404, code: 'NOT_FOUND' })
    const result = await scanExperienceMaterials(twinId, current.userId)
    await audit(req, '扫描数字分身学习材料', `${twin.name}：${result.created} 条候选`); res.json(result)
  } catch (error) { next(error) }
})
dueDiligenceRouter.get('/twins/:id/learning-candidates', async (req: AuthedRequest, res, next) => {
  try { const id = routeId(req.params.id); const [twin] = await db.select({ id: digitalTwins.id }).from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, req.user!.uid))).limit(1); if (!twin) throw Object.assign(new Error('数字分身不存在'), { status: 404, code: 'NOT_FOUND' }); await scanExperienceMaterials(id, req.user!.uid); const list = await db.select().from(digitalTwinLearningCandidates).where(and(eq(digitalTwinLearningCandidates.twinId, id), eq(digitalTwinLearningCandidates.ownerUserId, req.user!.uid))).orderBy(desc(digitalTwinLearningCandidates.createdAt)); res.json({ list }) } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/:id/learning-candidates/:candidateId/decision', async (req: AuthedRequest, res, next) => {
  try {
    const twinId = routeId(req.params.id); const candidateId = routeId(req.params.candidateId); const body = z.object({ decision: z.enum(['确认', '拒绝']) }).parse(req.body); const current = actor(req)
    const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, twinId), eq(digitalTwins.ownerUserId, current.userId))).limit(1); const [candidate] = await db.select().from(digitalTwinLearningCandidates).where(and(eq(digitalTwinLearningCandidates.id, candidateId), eq(digitalTwinLearningCandidates.twinId, twinId), eq(digitalTwinLearningCandidates.ownerUserId, current.userId), eq(digitalTwinLearningCandidates.status, '待确认'))).limit(1)
    if (!twin || !candidate) throw Object.assign(new Error('学习候选不存在或已处理'), { status: 404, code: 'NOT_FOUND' })
    if (body.decision === '拒绝') { await db.update(digitalTwinLearningCandidates).set({ status: '已拒绝', decidedAt: new Date() }).where(eq(digitalTwinLearningCandidates.id, candidateId)); await audit(req, '拒绝数字分身学习候选', candidate.sourceName); res.json({ status: '已拒绝' }); return }
    const nextVersion = twin.activeVersion + 1; const rules = `${twin.rules}${twin.rules ? '\n\n' : ''}${candidate.rules}`; const cases = `${twin.cases}${twin.cases ? '\n\n' : ''}${candidate.cases}\n边界：${candidate.boundaries}`
    await db.transaction(async tx => { await tx.update(digitalTwins).set({ rules, cases, activeVersion: nextVersion, updatedAt: new Date() }).where(eq(digitalTwins.id, twinId)); await tx.insert(digitalTwinVersions).values({ id: randomUUID(), twinId, ownerUserId: current.userId, version: nextVersion, rules, cases, source: 'learning' }); await tx.update(digitalTwinLearningCandidates).set({ status: '已采纳', decidedAt: new Date() }).where(eq(digitalTwinLearningCandidates.id, candidateId)); const [skill] = await tx.select().from(digitalTwinSkills).where(eq(digitalTwinSkills.twinId, twinId)).limit(1); const skillId = skill?.id ?? randomUUID(); const skillVersion = (skill?.activeVersion ?? 0) + 1; if (skill) await tx.update(digitalTwinSkills).set({ activeVersion: skillVersion, status: '试用中', updatedAt: new Date() }).where(eq(digitalTwinSkills.id, skillId)); else await tx.insert(digitalTwinSkills).values({ id: skillId, twinId, ownerUserId: current.userId, name: `${twin.name}·尽调判断 Skill`, activeVersion: skillVersion, status: '试用中' }); await tx.insert(digitalTwinSkillVersions).values({ id: randomUUID(), skillId, version: skillVersion, trigger: '尽调问题清单、项目核查与投资判断', instructions: candidate.rules, checklist: ['列明事实来源', '识别证据缺口', '说明反证与不确定性'], outputFormat: '结论、支持证据、反证、待补证事项', boundaries: candidate.boundaries, sourceCandidateId: candidateId, status: '试用中' }) })
    await audit(req, '采纳数字分身学习候选', candidate.sourceName); res.json({ status: '已采纳', twinVersion: nextVersion })
  } catch (error) { next(error) }
})
dueDiligenceRouter.get('/twins/:id/skills', async (req: AuthedRequest, res, next) => {
  try { const id = routeId(req.params.id); const [skill] = await db.select().from(digitalTwinSkills).where(and(eq(digitalTwinSkills.twinId, id), eq(digitalTwinSkills.ownerUserId, req.user!.uid))).limit(1); const versions = skill ? await db.select().from(digitalTwinSkillVersions).where(eq(digitalTwinSkillVersions.skillId, skill.id)).orderBy(desc(digitalTwinSkillVersions.version)) : []; res.json({ skill: skill ?? null, versions }) } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/:id/skills/:version/activate', async (req: AuthedRequest, res, next) => {
  try { const twinId = routeId(req.params.id); const version = z.coerce.number().int().positive().parse(req.params.version); const [skill] = await db.select().from(digitalTwinSkills).where(and(eq(digitalTwinSkills.twinId, twinId), eq(digitalTwinSkills.ownerUserId, req.user!.uid))).limit(1); const [target] = skill ? await db.select().from(digitalTwinSkillVersions).where(and(eq(digitalTwinSkillVersions.skillId, skill.id), eq(digitalTwinSkillVersions.version, version))).limit(1) : []; if (!skill || !target) throw Object.assign(new Error('个人 Skill 版本不存在'), { status: 404, code: 'NOT_FOUND' }); await db.transaction(async tx => { await tx.update(digitalTwinSkills).set({ activeVersion: version, status: '已生效', updatedAt: new Date() }).where(eq(digitalTwinSkills.id, skill.id)); await tx.update(digitalTwinSkillVersions).set({ status: '已生效' }).where(eq(digitalTwinSkillVersions.id, target.id)) }); await audit(req, '启用个人数字分身Skill', `${skill.name} v${version}`); res.json({ ok: true }) } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins', async (req: AuthedRequest, res, next) => {
  try {
    const body = TwinSchema.parse(req.body); const current = actor(req)
    const { source, ...twin } = body
    const id = await db.transaction(async tx => { const [inserted] = await tx.insert(digitalTwins).values({ ...twin, ownerUserId: current.userId, activeVersion: 1 }).$returningId(); await tx.insert(digitalTwinVersions).values({ twinId: inserted.id, ownerUserId: current.userId, version: 1, rules: body.rules, cases: body.cases, source }); return inserted.id })
    const [row] = await db.select().from(digitalTwins).where(eq(digitalTwins.id, id)).limit(1); await audit(req, '创建数字分身', body.name); res.status(201).json(row)
  } catch (error) { next(error) }
})
dueDiligenceRouter.patch('/twins/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = routeId(req.params.id); const body = TwinSchema.parse(req.body); const current = actor(req)
    const [existing] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, current.userId))).limit(1)
    if (!existing) { res.status(404).json({ code: 'NOT_FOUND', message: '数字分身不存在' }); return }
    const nextVersion = existing.activeVersion + 1
    await db.transaction(async tx => { await tx.update(digitalTwins).set({ name: body.name, role: body.role, rules: body.rules, cases: body.cases, activeVersion: nextVersion, updatedAt: new Date() }).where(eq(digitalTwins.id, id)); await tx.insert(digitalTwinVersions).values({ twinId: id, ownerUserId: current.userId, version: nextVersion, rules: body.rules, cases: body.cases, source: body.source }) })
    const [row] = await db.select().from(digitalTwins).where(eq(digitalTwins.id, id)).limit(1); await audit(req, '保存数字分身版本', body.name); res.json(row)
  } catch (error) { next(error) }
})
dueDiligenceRouter.delete('/twins/:id', async (req: AuthedRequest, res, next) => {
  try { const id = routeId(req.params.id); const current = actor(req); const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, current.userId), isNull(digitalTwins.deletedAt))).limit(1); if (!twin) throw Object.assign(new Error('数字分身不存在或已删除'), { status: 404, code: 'NOT_FOUND' }); await db.transaction(async tx => { await tx.update(digitalTwins).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(digitalTwins.id, id)); await tx.update(digitalTwinPublications).set({ status: '已撤回', withdrawnAt: new Date() }).where(eq(digitalTwinPublications.twinId, id)); await tx.insert(digitalTwinAssetArchives).values({ id: randomUUID(), ownerUserId: current.userId, assetType: '数字分身', sourceTwinId: id, name: twin.name, snapshot: { name: twin.name, role: twin.role, rules: twin.rules, cases: twin.cases, version: twin.activeVersion } }) }); await audit(req, '删除数字分身', twin.name); res.status(204).end() } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/history/:id/restore', async (req: AuthedRequest, res, next) => {
  try { const id = routeId(req.params.id); const current = actor(req); const [archive] = await db.select().from(digitalTwinAssetArchives).where(and(eq(digitalTwinAssetArchives.id, id), eq(digitalTwinAssetArchives.ownerUserId, current.userId))).limit(1); if (!archive) throw Object.assign(new Error('历史资产不存在'), { status: 404, code: 'NOT_FOUND' }); const snapshot = archive.snapshot as { name?: string; role?: string; rules?: string; cases?: string }; if (archive.assetType !== '数字分身' || !snapshot.name) throw Object.assign(new Error('当前历史资产不支持恢复'), { status: 400, code: 'UNSUPPORTED_ARCHIVE' }); const newId = randomUUID(); await db.transaction(async tx => { await tx.insert(digitalTwins).values({ id: newId, ownerUserId: current.userId, name: `${snapshot.name}（恢复）`, role: snapshot.role || req.user!.role || '投资经理', rules: snapshot.rules || '', cases: snapshot.cases || '', activeVersion: 1 }); await tx.insert(digitalTwinVersions).values({ id: randomUUID(), twinId: newId, ownerUserId: current.userId, version: 1, rules: snapshot.rules || '', cases: snapshot.cases || '', source: 'restore' }); await tx.update(digitalTwinAssetArchives).set({ restoredAt: new Date() }).where(eq(digitalTwinAssetArchives.id, id)) }); await audit(req, '恢复数字分身历史版本', archive.name); res.status(201).json({ id: newId }) } catch (error) { next(error) }
})

dueDiligenceRouter.get('/twins/:id/candidates', async (req: AuthedRequest, res, next) => {
  try { const id = routeId(req.params.id); res.json({ list: await db.select().from(digitalTwinUpdateCandidates).where(and(eq(digitalTwinUpdateCandidates.twinId, id), eq(digitalTwinUpdateCandidates.ownerUserId, req.user!.uid))).orderBy(desc(digitalTwinUpdateCandidates.createdAt)) }) } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/:id/candidates', async (req: AuthedRequest, res, next) => {
  try {
    const id = routeId(req.params.id); const body = z.object({ rules: z.string().trim().min(1).max(30000), cases: z.string().trim().max(30000).default(''), sourceNote: z.string().trim().min(1).max(8000) }).parse(req.body)
    const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, req.user!.uid))).limit(1); if (!twin) throw Object.assign(new Error('数字分身不存在'), { status: 404, code: 'NOT_FOUND' })
    const [inserted] = await db.insert(digitalTwinUpdateCandidates).values({ id: randomUUID(), twinId: id, ownerUserId: req.user!.uid, ...body }).$returningId(); const [row] = await db.select().from(digitalTwinUpdateCandidates).where(eq(digitalTwinUpdateCandidates.id, inserted.id)).limit(1); await audit(req, '创建数字分身更新候选', twin.name); res.status(201).json(row)
  } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/:id/candidates/:candidateId/accept', async (req: AuthedRequest, res, next) => {
  try {
    const id = routeId(req.params.id); const candidateId = routeId(req.params.candidateId); const current = actor(req)
    const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, current.userId))).limit(1); const [candidate] = await db.select().from(digitalTwinUpdateCandidates).where(and(eq(digitalTwinUpdateCandidates.id, candidateId), eq(digitalTwinUpdateCandidates.twinId, id), eq(digitalTwinUpdateCandidates.ownerUserId, current.userId), eq(digitalTwinUpdateCandidates.status, '待确认'))).limit(1)
    if (!twin || !candidate) throw Object.assign(new Error('候选不存在或已处理'), { status: 404, code: 'NOT_FOUND' }); const version = twin.activeVersion + 1
    await db.transaction(async tx => { await tx.update(digitalTwins).set({ rules: candidate.rules, cases: candidate.cases, activeVersion: version, updatedAt: new Date() }).where(eq(digitalTwins.id, id)); await tx.insert(digitalTwinVersions).values({ id: randomUUID(), twinId: id, ownerUserId: current.userId, version, rules: candidate.rules, cases: candidate.cases, source: 'candidate' }); await tx.update(digitalTwinUpdateCandidates).set({ status: '已采纳', decidedAt: new Date() }).where(eq(digitalTwinUpdateCandidates.id, candidateId)) })
    await audit(req, '采纳数字分身更新候选', twin.name); res.json({ version })
  } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/:id/restore/:version', async (req: AuthedRequest, res, next) => {
  try {
    const id = routeId(req.params.id); const version = z.coerce.number().int().positive().parse(req.params.version); const current = actor(req)
    const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, current.userId))).limit(1); const [source] = await db.select().from(digitalTwinVersions).where(and(eq(digitalTwinVersions.twinId, id), eq(digitalTwinVersions.ownerUserId, current.userId), eq(digitalTwinVersions.version, version))).limit(1)
    if (!twin || !source) throw Object.assign(new Error('分身或版本不存在'), { status: 404, code: 'NOT_FOUND' }); const nextVersion = twin.activeVersion + 1
    await db.transaction(async tx => { await tx.update(digitalTwins).set({ rules: source.rules, cases: source.cases, activeVersion: nextVersion, updatedAt: new Date() }).where(eq(digitalTwins.id, id)); await tx.insert(digitalTwinVersions).values({ id: randomUUID(), twinId: id, ownerUserId: current.userId, version: nextVersion, rules: source.rules, cases: source.cases, source: 'restore' }) })
    await audit(req, '恢复数字分身版本', `${id}:v${version}`); res.json({ version: nextVersion })
  } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/:id/extract-traits', async (req: AuthedRequest, res, next) => {
  try {
    const id = routeId(req.params.id); const body = z.object({ sourceName: z.string().trim().min(1).max(255), text: z.string().trim().min(1).max(60000) }).parse(req.body); const current = actor(req)
    const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, current.userId), isNull(digitalTwins.deletedAt))).limit(1)
    if (!twin) throw Object.assign(new Error('数字分身不存在'), { status: 404, code: 'NOT_FOUND' })
    let response: Response
    try { response = await fetchAiGatewayChatCompatible((process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, ''), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY || process.env.LLM_API_KEY}` } : {}) }, body: JSON.stringify({ model: process.env.LLM_MODEL || 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'system', content: '你是投资团队知识整理助手。仅从材料中提炼可复用的尽调判断偏好、核查习惯与适用边界；不得添加材料没有的事实、姓名或公司信息。使用简洁中文要点。' }, { role: 'user', content: `材料名称：${body.sourceName}\n材料内容：\n${body.text.slice(0, 50000)}` }] }), signal: AbortSignal.timeout(120_000) }, fetch, 120_000) } catch (error) { throw Object.assign(new Error('模型服务暂不可用，材料已保留，可稍后解析。'), { status: 503, code: 'AI_GATEWAY_UNAVAILABLE', cause: error }) }
    if (!response.ok) throw Object.assign(new Error('模型服务暂不可用，材料已保留，可稍后解析。'), { status: 503, code: 'AI_GATEWAY_UNAVAILABLE' })
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }; const traits = payload.choices?.[0]?.message?.content?.trim()
    if (!traits) throw Object.assign(new Error('模型未返回可用的分身特质。'), { status: 502, code: 'AI_EMPTY_RESPONSE' })
    await audit(req, '解析数字分身材料特质', body.sourceName); res.json({ traits })
  } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/:id/conversation-candidates', async (req: AuthedRequest, res, next) => {
  try {
    const id = routeId(req.params.id); const body = z.object({ content: z.string().trim().min(1).max(8000), projectId: z.string().uuid().nullable().optional() }).parse(req.body); const current = actor(req)
    const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, current.userId), isNull(digitalTwins.deletedAt))).limit(1)
    if (!twin) throw Object.assign(new Error('数字分身不存在'), { status: 404, code: 'NOT_FOUND' })
    if (!body.projectId) { res.json({ created: false }); return }
    await requireAccessibleProject(current.userId, body.projectId)
    const sourceHash = Buffer.from(body.content).toString('base64url').slice(0, 64)
    const [existing] = await db.select({ id: digitalTwinLearningCandidates.id }).from(digitalTwinLearningCandidates).where(and(eq(digitalTwinLearningCandidates.twinId, id), eq(digitalTwinLearningCandidates.sourceHash, sourceHash))).limit(1)
    if (!existing) await db.insert(digitalTwinLearningCandidates).values({ id: randomUUID(), twinId: id, ownerUserId: current.userId, projectId: body.projectId, sourceHash, sourceName: '实时分身对话', sourceType: '实时分身对话', sourceKey: `conversation:${sourceHash}`, topic: '对话中的尽调判断', confidence: 60, rules: `在后续相似尽调中，复核这段对话中提出的判断：${body.content.slice(0, 1000)}`, cases: '', boundaries: '该候选只记录对话中出现的偏好或假设，需本人确认后才写入分身。', rationale: '系统根据实时分身对话自动提炼。' })
    await audit(req, '提炼实时分身对话经验', twin.name); res.json({ created: !existing })
  } catch (error) { next(error) }
})
dueDiligenceRouter.get('/twins/importable-sources', async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.uid
    const [notes, files] = await Promise.all([
      db.select({ id: personalNotes.id, name: personalNotes.title, text: personalNotes.plainText, sourceType: sql<string>`'个人笔记'` }).from(personalNotes).where(eq(personalNotes.ownerId, userId)).orderBy(desc(personalNotes.updatedAt)).limit(100),
      db.select({ id: projectFiles.id, name: projectFiles.name, text: projectFiles.contentText, sourceType: sql<string>`'知识库材料'` }).from(projectFiles).innerJoin(projectMembers, and(eq(projectMembers.projectId, projectFiles.projectId), eq(projectMembers.userId, userId))).where(and(eq(projectFiles.parseStatus, '成功'), eq(projectFiles.uploadedBy, userId))).orderBy(desc(projectFiles.uploadedAt)).limit(100),
    ])
    res.json({ list: [...notes, ...files].filter(item => item.text?.trim()).map(item => ({ ...item, text: item.text!.slice(0, 60000) })) })
  } catch (error) { next(error) }
})
dueDiligenceRouter.post('/twins/:id/conversation', async (req: AuthedRequest, res, next) => {
  try {
    const id = routeId(req.params.id); const body = z.object({ projectId: z.string().uuid().nullable().optional() }).parse(req.body ?? {}); const current = actor(req)
    const [twin] = await db.select().from(digitalTwins).where(and(eq(digitalTwins.id, id), eq(digitalTwins.ownerUserId, current.userId))).limit(1); if (!twin) throw Object.assign(new Error('数字分身不存在'), { status: 404, code: 'NOT_FOUND' })
    if (body.projectId) await requireAccessibleProject(current.userId, body.projectId)
    const [existing] = await db.select().from(digitalTwinConversations).where(and(eq(digitalTwinConversations.twinId, id), body.projectId ? eq(digitalTwinConversations.projectId, body.projectId) : isNull(digitalTwinConversations.projectId))).limit(1)
    if (existing) { res.json(existing); return }
    const [project] = body.projectId ? await db.select({ name: projects.name }).from(projects).where(eq(projects.id, body.projectId)).limit(1) : []
    const conversation = await createConversation(current.userId, { title: `${twin.name} · 尽调对话`, scope: body.projectId ? 'project' : 'global', projectId: body.projectId ?? null, projectName: project?.name ?? null, userRole: req.user!.role })
    const row = { id: randomUUID(), twinId: id, ownerUserId: current.userId, projectId: body.projectId ?? null, conversationId: conversation.id, agentId: conversation.agentId || conversation.id }
    await db.insert(digitalTwinConversations).values(row); await audit(req, '创建数字分身实时会话', twin.name); res.status(201).json(row)
  } catch (error) { next(error) }
})
