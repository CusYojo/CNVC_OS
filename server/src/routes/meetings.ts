import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { createMeeting, createTodo, deleteTodo, getMeeting, listMeetings, listTodos, todoCounts, updateMeeting, updateTodo } from '../services/meetingService.js'
import { projectSummary as projectSummaryLLM, answerQuestion, meetingSummary } from '../services/aiService.js'

export const meetingsRouter = Router()

meetingsRouter.get('/', async (req, res, next) => {
  try { res.json({ list: await listMeetings(req.query.projectId as string | undefined) }) }
  catch (err) { next(err) }
})

meetingsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getMeeting(req.params.id)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '会议不存在', details: null }); return }
    res.json(row)
  } catch (err) { next(err) }
})

const CreateSchema = z.object({
  projectId: z.string().nullable().optional(),
  projectName: z.string().min(1),
  title: z.string().min(1),
  type: z.string().default('项目会议'),
  host: z.string().min(1),
  attendees: z.array(z.string()).default([]),
  rawTranscript: z.string().optional(),
  newTodos: z.array(z.object({
    title: z.string(), owner: z.string(), dueDate: z.string().optional(),
    priority: z.enum(['高', '中', '低']).default('中'),
    type: z.string().default('待办'),
    projectId: z.string().optional(), projectName: z.string().optional(),
  })).default([]),
})

meetingsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = CreateSchema.parse(req.body)
    const row = await createMeeting(body as never, body.newTodos as never, req.user!.uid)
    res.status(201).json(row)
  } catch (err) { next(err) }
})

meetingsRouter.patch('/:id', async (req, res, next) => {
  try {
    const row = await updateMeeting(req.params.id, req.body)
    res.json(row)
  } catch (err) { next(err) }
})

export const todosRouter = Router()
todosRouter.get('/', async (req, res, next) => {
  try { res.json({ list: await listTodos(req.query.owner as string | undefined, req.query.projectId as string | undefined), counts: await todoCounts() }) }
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

todosRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = TodoSchema.parse(req.body)
    const row = await createTodo(body as never, req.user!.uid)
    res.status(201).json(row)
  } catch (err) { next(err) }
})

todosRouter.patch('/:id', async (req, res, next) => {
  try {
    const row = await updateTodo(req.params.id, req.body)
    res.json(row)
  } catch (err) { next(err) }
})

todosRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await deleteTodo(req.params.id)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '待办不存在', details: null }); return }
    res.json({ ok: true, deleted: row })
  } catch (err) { next(err) }
})

export const aiRouter = Router()

// /chat：纯转发给 flue advisor agent（真·agent，自带 RAG/PPT/情报工具 + 投研/PPT skill，自主决策）。
// 不再用正则硬分流：无论用户如何措辞，由 agent 判断该调哪个能力。
aiRouter.post('/chat', async (req, res, next) => {
  try {
    const { question, projectName, projectId, scope } = z.object({
      question: z.string().min(1),
      projectName: z.string().optional(),
      projectId: z.string().optional(),
      scope: z.string().optional(),
    }).parse(req.body)
    res.json(await answerQuestion(question, projectName, scope === 'global' ? undefined : projectId))
  } catch (err) { next(err) }
})

// /chat-stream：真流式（SSE）。把问题转发给 flue advisor agent，逐 token 把回答 + 工具调用推给前端，
// 像 Pi Agent Web 那样实时滚动。底层 flue=pi，用其 SSE 契约：POST ?stream=true 拿 offset，再 GET ?view=updates&live=sse。
const FLUE_STREAM_BASE = process.env.FLUE_BASE_URL || 'http://127.0.0.1:8790'
aiRouter.post('/chat-stream', async (req: AuthedRequest, res) => {
  const parsed = z.object({
    question: z.string().min(1),
    projectName: z.string().optional(),
    projectId: z.string().optional(),
    scope: z.string().optional(),
    conversationId: z.string().optional(),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ code: 'INVALID_ARGUMENT', message: '缺少 question' }); return }
  const { question, projectName = '当前项目', projectId, scope, conversationId } = parsed.data
  const pid = scope === 'global' ? undefined : projectId

  // SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // 关键：让 nginx 不缓冲 SSE
  res.flushHeaders?.()
  const sse = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }

  const msg = [
    `【当前项目】${projectName}`,
    pid ? `【projectId】${pid}（调 search_project_docs 时用此 id）` : '【范围】全局知识库（无 projectId）',
    `【用户问题】${question}`,
  ].join('\n')

  // flue 靠统一 sessionId 做记忆传承：同一对话复用同一 id，agent 才能记住上文（如刚触发了 PPT）。
  // 用前端传来的 conversationId 锁定会话；缺失时才退化为随机 id（无记忆）。
  const sid = conversationId
    ? `conv-${conversationId.replace(/[^A-Za-z0-9_-]/g, '')}`
    : `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const agentUrl = `${FLUE_STREAM_BASE}/agents/advisor/${sid}`
  const ac = new AbortController()
  res.on('close', () => ac.abort())

  try {
    // 1) 启动（非阻塞），拿起始 offset
    const startResp = await fetch(`${agentUrl}?stream=true`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }), signal: ac.signal,
    })
    if (!startResp.ok) throw new Error(`flue start ${startResp.status}`)
    const { offset } = await startResp.json() as { offset?: string }

    // 2) 读 flue SSE，转成干净的前端 SSE
    const streamResp = await fetch(`${agentUrl}?view=updates&offset=${encodeURIComponent(offset ?? '-1')}&live=sse`, {
      headers: { Accept: 'text/event-stream' }, signal: ac.signal,
    })
    if (!streamResp.ok || !streamResp.body) throw new Error(`flue stream ${streamResp.status}`)

    let full = ''
    let done = false
    let pendingTools = 0
    const reader = streamResp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (!done) {
      const { value, done: rd } = await reader.read()
      if (rd) break
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let payload: unknown
        try { payload = JSON.parse(line.slice(5).trim()) } catch { continue }
        if (!Array.isArray(payload)) continue
        for (const ev of payload as Array<Record<string, unknown>>) {
          if (ev.type === 'message-delta' && ev.kind === 'text' && typeof ev.delta === 'string') {
            full += ev.delta
            sse('delta', { text: ev.delta })
          } else if (ev.type === 'tool-input') {
            pendingTools++
            sse('tool', { name: (ev.toolName ?? ev.name ?? '工具'), phase: 'start' })
          } else if (ev.type === 'tool-output' || ev.type === 'tool-output-error') {
            pendingTools = Math.max(0, pendingTools - 1)
            sse('tool', { name: (ev.toolName ?? ev.name ?? '工具'), phase: 'end', error: ev.type === 'tool-output-error' })
          } else if (ev.type === 'message-completed') {
            // 有工具调用时会产生多条 assistant 消息；仅当没有未完成工具时才算真正结束
            if (pendingTools === 0) done = true
          }
        }
      }
    }

    // 3) 解析标记，回传结构化收尾
    let answer = full
    let pptJobId: string | undefined
    let sources: string[] = []
    const pptM = full.match(/\[\[PPT_JOB:([^\]]+)\]\]/)
    if (pptM) { pptJobId = pptM[1].trim(); answer = answer.replace(pptM[0], '').trim() }
    const srcM = full.match(/\[\[SOURCES:([^\]]*)\]\]/)
    if (srcM) { sources = srcM[1].split('|').map((s) => s.trim()).filter(Boolean); answer = answer.replace(srcM[0], '').trim() }
    sse('done', { answer, sources, confidence: sources.length ? 0.8 : (pptJobId ? 1 : null), pptJobId })
    res.end()
  } catch (err) {
    if (!ac.signal.aborted) { sse('error', { message: (err as Error).message }); res.end() }
  }
})

aiRouter.post('/project-summary', async (req, res, next) => {
  try {
    const { projectName, projectId } = z.object({
      projectName: z.string().min(1),
      projectId: z.string().optional(),
    }).parse(req.body)
    res.json(await projectSummaryLLM(projectName))
  } catch (err) { next(err) }
})

aiRouter.post('/bp-parse', async (req, res) => {
  // Sprint 0 占位：真异步任务到 Sprint 2 再做
  res.json({ jobId: `bp-${Date.now()}`, status: '解析中', note: 'MVP 期间文件元数据解析在 Sprint 2 接入' })
})

aiRouter.post('/meeting-summary', async (req, res, next) => {
  try {
    const { transcript } = z.object({ transcript: z.string().min(1) }).parse(req.body)
    res.json(await meetingSummary(transcript))
  } catch (err) { next(err) }
})

aiRouter.get('/jobs/:id', (req, res) => {
  res.json({ id: req.params.id, status: '成功', progress: 100, note: 'MVP 期间同步完成（Sprint 2 接异步任务）' })
})
