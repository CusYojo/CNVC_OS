import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { createMeeting, createTodo, deleteTodo, getMeeting, getTodo, listMeetingTodos, listMeetings, listTodos, presentMeeting, presentMeetings, todoCounts, updateMeeting, updateTodo } from '../services/meetingService.js'
import { answerQuestion, meetingSummary } from '../services/aiService.js'
import { requireAccessibleProject } from '../services/projectAccessService.js'
import { parseShanghaiDateTime } from '../utils/shanghaiTime.js'

export const meetingsRouter = Router()
const routeId = (value: string | string[]) => z.string().min(1).parse(value)

meetingsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = req.query.projectId as string | undefined
    if (projectId) await requireAccessibleProject(req.user!.uid, projectId)
    res.json({ list: await presentMeetings(await listMeetings(projectId, req.user!)) })
  }
  catch (err) { next(err) }
})

meetingsRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const row = await getMeeting(routeId(req.params.id), req.user!)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '会议不存在', details: null }); return }
    res.json(await presentMeeting(row))
  } catch (err) { next(err) }
})

const CreateSchema = z.object({
  projectId: z.string().nullable().optional(),
  projectName: z.string().min(1),
  title: z.string().min(1),
  type: z.string().default('项目会议'),
  meetingTime: z.string().min(1),
  participants: z.array(z.string().trim().min(1)).min(1),
  status: z.string().optional(),
  rawText: z.string().optional(),
  summary: z.string().optional(),
  conclusions: z.array(z.string()).default([]),
  newTodos: z.array(z.object({
    title: z.string().min(1), owner: z.string().min(1), dueDate: z.string().optional(),
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
    const row = await createMeeting({
      projectId: body.projectId,
      projectName: body.projectName,
      title: body.title,
      type: body.type,
      host: body.participants[0],
      attendees: body.participants,
      rawTranscript: body.rawText,
      aiSummary: body.summary,
      conclusions: body.conclusions,
      startedAt: parseMeetingTime(body.meetingTime),
    }, body.newTodos as never, req.user!.uid, req.user!.name)
    const createdTodos = await listMeetingTodos(row.id, req.user!)
    res.status(201).json({ ...await presentMeeting(row), createdTodos })
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
    }
    const row = await updateMeeting(existing.id, patch, expectedVersion)
    res.json(await presentMeeting(row))
  } catch (err) { next(err) }
})

export const todosRouter = Router()
todosRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = req.query.projectId as string | undefined
    if (projectId) await requireAccessibleProject(req.user!.uid, projectId)
    res.json({
      list: await listTodos(req.query.owner as string | undefined, projectId, req.user!),
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
    res.json(await answerQuestion(question, projectName, pid))
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
    const result = await answerQuestion(question, projectName, pid)
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
