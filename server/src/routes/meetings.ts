import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { addMeetingContribution, archiveExpiredCompletedPersonalTodos, createMeeting, createTodo, deleteMeetingRecord, deleteTodo, finalizeMeeting, getMeeting, getTodo, listMeetingTodos, listMeetings, listTodos, presentMeeting, presentMeetings, readMeetingNotice, todoCounts, updateMeeting, updateMeetingLifecycle, updateTodo } from '../services/meetingService.js'
import { answerQuestion, meetingSummary } from '../services/aiService.js'
import { requireAccessibleProject } from '../services/projectAccessService.js'
import { parseShanghaiDateTime } from '../utils/shanghaiTime.js'

export const meetingsRouter = Router()
const routeId = (value: string | string[]) => z.string().min(1).parse(value)

meetingsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = req.query.projectId as string | undefined
    if (projectId) await requireAccessibleProject(req.user!.uid, projectId)
    res.json({ list: await presentMeetings(await listMeetings(projectId, req.user!), req.user!.uid) })
  }
  catch (err) { next(err) }
})

meetingsRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const row = await getMeeting(routeId(req.params.id), req.user!)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '会议不存在', details: null }); return }
    res.json(await presentMeeting(row, req.user!.uid))
  } catch (err) { next(err) }
})

const CreateSchema = z.object({
  clientRequestId: z.string().uuid().optional(),
  projectId: z.string().nullable().optional(),
  projectName: z.string().min(1),
  title: z.string().min(1),
  type: z.string().default('项目会议'),
  meetingTime: z.string().min(1),
  meetingEndTime: z.string().min(1).nullable().optional(),
  participants: z.array(z.string().trim().min(1)).min(1),
  participantUserIds: z.array(z.string().uuid()).min(1).optional(),
  purpose: z.string().trim().max(2000).default(''),
  requirements: z.string().trim().max(2000).default(''),
  status: z.string().optional(),
  rawText: z.string().optional(),
  summary: z.string().optional(),
  conclusions: z.array(z.string()).default([]),
  newTodos: z.array(z.object({
    title: z.string().min(1), owner: z.string().min(1), dueDate: z.string().optional(),
    ownerUserId: z.string().uuid().optional(),
    deliverable: z.string().max(2000).optional(),
    priority: z.enum(['高', '中', '低']).default('中'),
    type: z.string().default('待办'),
    status: z.string().default('未开始'),
    projectId: z.string().optional(), projectName: z.string().optional(),
  })).default([]),
})

const PatchSchema = CreateSchema.omit({ newTodos: true }).partial().extend({
  expectedVersion: z.number().int().positive(),
}).strict()

function parseMeetingTime(value: string) {
  try {
    return parseShanghaiDateTime(value)
  } catch {
    const error = new Error('会议时间格式无效') as Error & { status?: number; code?: string }
    error.status = 400
    error.code = 'INVALID_MEETING_TIME'
    throw error
  }
}

meetingsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = CreateSchema.parse(req.body)
    const projectIds = new Set([
      body.projectId,
      ...body.newTodos.map((todo) => todo.projectId),
    ].filter((value): value is string => Boolean(value)))
    await Promise.all([...projectIds].map((projectId) => requireAccessibleProject(req.user!.uid, projectId)))
    const startedAt = parseMeetingTime(body.meetingTime)
    const endsAt = body.meetingEndTime ? parseMeetingTime(body.meetingEndTime) : null
    if (endsAt && endsAt <= startedAt) {
      const error = new Error('会议结束时间必须晚于开始时间') as Error & { status?: number; code?: string }
      error.status = 400; error.code = 'INVALID_MEETING_TIME_RANGE'; throw error
    }
    const row = await createMeeting({
      projectId: body.projectId,
      projectName: body.projectName,
      title: body.title,
      type: body.type,
      host: req.user!.name,
      attendees: body.participants,
      rawTranscript: body.rawText,
      aiSummary: body.summary,
      conclusions: body.conclusions,
      weeklyReview: { kind: 'project_meeting_workspace', purpose: body.purpose, requirements: body.requirements, contributions: [] } as never,
      workflowStatus: 'scheduled',
      startedAt,
      endsAt,
    }, body.newTodos as never, req.user!.uid, req.user!.name, body.participantUserIds, body.clientRequestId)
    const createdTodos = await listMeetingTodos(row.id, req.user!)
    res.status(201).json({ ...await presentMeeting(row, req.user!.uid), createdTodos })
  } catch (err) { next(err) }
})

meetingsRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const existing = await getMeeting(routeId(req.params.id), req.user!)
    if (!existing) { res.status(404).json({ code: 'NOT_FOUND', message: '会议不存在', details: null }); return }
    const { expectedVersion, ...body } = PatchSchema.parse(req.body)
    if (typeof body.projectId === 'string') {
      await requireAccessibleProject(req.user!.uid, body.projectId)
    }
    const patch = {
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      ...(body.projectName !== undefined ? { projectName: body.projectName } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.participants !== undefined ? { host: body.participants[0], attendees: body.participants } : {}),
      ...(body.rawText !== undefined ? { rawTranscript: body.rawText } : {}),
      ...(body.summary !== undefined ? { aiSummary: body.summary } : {}),
      ...(body.conclusions !== undefined ? { conclusions: body.conclusions } : {}),
      ...(body.meetingTime !== undefined ? { startedAt: parseMeetingTime(body.meetingTime) } : {}),
      ...(body.meetingEndTime !== undefined ? { endsAt: body.meetingEndTime ? parseMeetingTime(body.meetingEndTime) : null } : {}),
    }
    const row = await updateMeeting(existing.id, patch, expectedVersion)
    res.json(await presentMeeting(row, req.user!.uid))
  } catch (err) { next(err) }
})

const ContributionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  content: z.string().trim().max(4000).default(''),
  fileIds: z.array(z.string().uuid()).max(20).default([]),
}).refine((value) => Boolean(value.content || value.fileIds.length), '请填写会议想法或上传文件')

meetingsRouter.post('/:id/contributions', async (req: AuthedRequest, res, next) => {
  try {
    const input = ContributionSchema.parse(req.body)
    const row = await addMeetingContribution({ meetingId: routeId(req.params.id), userId: req.user!.uid, ...input })
    res.status(201).json(await presentMeeting(row, req.user!.uid))
  } catch (err) { next(err) }
})

const LifecycleSchema = z.object({ expectedVersion: z.number().int().positive(), action: z.enum(['start', 'end', 'cancel']) }).strict()
meetingsRouter.post('/:id/lifecycle', async (req: AuthedRequest, res, next) => {
  try {
    const input = LifecycleSchema.parse(req.body)
    const row = await updateMeetingLifecycle({ meetingId: routeId(req.params.id), userId: req.user!.uid, ...input })
    res.json(await presentMeeting(row, req.user!.uid))
  } catch (err) { next(err) }
})

const DeleteMeetingSchema = z.object({
  clientRequestId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(2).max(500),
}).strict()
meetingsRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const input = DeleteMeetingSchema.parse(req.body)
    res.json(await deleteMeetingRecord({ meetingId: routeId(req.params.id), userId: req.user!.uid, userName: req.user!.name, ...input }))
  } catch (err) { next(err) }
})

const FinalizeSchema = z.object({
  expectedVersion: z.number().int().positive(),
  summary: z.string().trim().min(1).max(5000),
  conclusions: z.array(z.string().trim().min(1).max(1000)).max(50),
  tasks: z.array(z.object({ title: z.string().trim().min(1).max(500), ownerUserId: z.string().uuid(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).max(50),
}).strict()
meetingsRouter.post('/:id/finalize', async (req: AuthedRequest, res, next) => {
  try {
    const input = FinalizeSchema.parse(req.body)
    const row = await finalizeMeeting({ meetingId: routeId(req.params.id), userId: req.user!.uid, userName: req.user!.name, ...input })
    res.json({ ...await presentMeeting(row, req.user!.uid), createdTodos: await listMeetingTodos(row.id, req.user!) })
  } catch (err) { next(err) }
})

meetingsRouter.post('/:id/notices/:noticeId/read', async (req: AuthedRequest, res, next) => {
  try {
    z.object({}).strict().parse(req.body)
    res.json(await readMeetingNotice(routeId(req.params.id), routeId(req.params.noticeId), req.user!.uid))
  } catch (err) { next(err) }
})

export const todosRouter = Router()
const TodoListQuerySchema = z.object({
  owner: z.string().optional(),
  projectId: z.string().uuid().optional(),
  personal: z.enum(['true']).optional(),
  includeCompleted: z.enum(['true']).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine(value => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo, '待办日期范围无效')
todosRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const query = TodoListQuerySchema.parse(req.query)
    const projectId = query.projectId
    if (projectId) await requireAccessibleProject(req.user!.uid, projectId)
    res.json({
      list: await listTodos(query.owner, projectId, req.user!, query.personal === 'true' ? {
        personalOwnerUserId: req.user!.uid,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        includeCompleted: query.includeCompleted === 'true',
      } : undefined),
      counts: await todoCounts(req.user!),
    })
  }
  catch (err) { next(err) }
})

const TodoSchema = z.object({
  projectId: z.string().nullable().optional(),
  projectName: z.string().optional(),
  title: z.string(),
  owner: z.string(),
  ownerUserId: z.string().uuid().optional(),
  deliverable: z.string().max(2000).optional(),
  dueDate: z.string().optional(),
  priority: z.enum(['高', '中', '低']).default('中'),
  type: z.string().default('待办'),
  status: z.string().default('未开始'),
})

const TodoPatchSchema = TodoSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
}).strict()

todosRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = TodoSchema.parse(req.body)
    if (body.projectId) await requireAccessibleProject(req.user!.uid, body.projectId)
    const row = await createTodo(body as never, req.user!.uid)
    res.status(201).json(row)
  } catch (err) { next(err) }
})

todosRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const existing = await getTodo(routeId(req.params.id), req.user!)
    if (!existing) { res.status(404).json({ code: 'NOT_FOUND', message: '待办不存在', details: null }); return }
    const { expectedVersion, ...patch } = TodoPatchSchema.parse(req.body)
    if (typeof patch.projectId === 'string') {
      await requireAccessibleProject(req.user!.uid, patch.projectId)
    }
    const row = await updateTodo(existing.id, patch, expectedVersion)
    res.json(row)
  } catch (err) { next(err) }
})

todosRouter.delete('/personal/completed', async (req: AuthedRequest, res, next) => {
  try {
    const { before } = z.object({ before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query)
    const archived = await archiveExpiredCompletedPersonalTodos(req.user!.uid, before)
    res.json({ ok: true, archived })
  } catch (err) { next(err) }
})

todosRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const existing = await getTodo(routeId(req.params.id), req.user!)
    if (!existing) { res.status(404).json({ code: 'NOT_FOUND', message: '待办不存在', details: null }); return }
    const row = await deleteTodo(existing.id)
    res.json({ ok: true, deleted: row })
  } catch (err) { next(err) }
})

export const aiRouter = Router()

// 兼容旧问答接口；新 AI 页面使用同进程 JW Runtime，会话历史统一落 MySQL。
aiRouter.post('/chat', async (req: AuthedRequest, res, next) => {
  try {
    const { question, projectName, projectId, scope } = z.object({
      question: z.string().min(1),
      projectName: z.string().optional(),
      projectId: z.string().optional(),
      scope: z.string().optional(),
    }).parse(req.body)
    const pid = scope === 'global' ? undefined : projectId
    if (pid) await requireAccessibleProject(req.user!.uid, pid)
    res.json(await answerQuestion(question, projectName, pid, req.user!.uid))
  } catch (err) { next(err) }
})

// 兼容旧 SSE 客户端。统一问答完成后发送一个 delta 和 done，避免继续依赖第二套流式协议。
aiRouter.post('/chat-stream', async (req: AuthedRequest, res) => {
  const parsed = z.object({
    question: z.string().min(1),
    projectName: z.string().optional(),
    projectId: z.string().optional(),
    scope: z.string().optional(),
    conversationId: z.string().optional(),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ code: 'INVALID_ARGUMENT', message: '缺少 question' }); return }
  const { question, projectName = '当前项目', projectId, scope } = parsed.data
  const pid = scope === 'global' ? undefined : projectId

  try {
    if (pid) await requireAccessibleProject(req.user!.uid, pid)
  } catch (error) {
    res.status(403).json({
      code: 'PROJECT_FORBIDDEN',
      message: (error as Error).message,
      details: null,
      requestId: String(res.locals.requestId || ''),
    })
    return
  }

  // SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // 关键：让 nginx 不缓冲 SSE
  res.flushHeaders?.()
  const sse = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }

  try {
    const result = await answerQuestion(question, projectName, pid, req.user!.uid)
    sse('delta', { text: result.answer })
    sse('done', result)
    res.end()
  } catch (err) {
    sse('error', { message: (err as Error).message })
    res.end()
  }
})

aiRouter.post('/meeting-summary', async (req, res, next) => {
  try {
    const { transcript } = z.object({ transcript: z.string().min(1) }).parse(req.body)
    res.json(await meetingSummary(transcript))
  } catch (err) { next(err) }
})
