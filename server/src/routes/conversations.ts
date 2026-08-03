import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import {
  listConversations, getConversation, createConversation, appendMessages, deleteConversation, renameConversation,
  continueConversationInCurrentRuntime,
} from '../services/conversationService.js'

export const conversationsRouter = Router()
const routeId = (value: string | string[]) => z.string().min(1).parse(value)

// 列表（当前用户）
conversationsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try { res.json({ list: await listConversations(req.user!.uid) }) } catch (err) { next(err) }
})

// 取单个会话（含消息）
conversationsRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const conv = await getConversation(req.user!.uid, routeId(req.params.id))
    if (!conv) return res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在' })
    res.json(conv)
  } catch (err) { next(err) }
})

// 新建会话
conversationsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      title: z.string().optional(),
      scope: z.enum(['project', 'global']).optional(),
      projectId: z.string().nullable().optional(),
      projectName: z.string().nullable().optional(),
    }).parse(req.body ?? {})
    res.status(201).json(await createConversation(req.user!.uid, body))
  } catch (err) { next(err) }
})

// 改标题（会话内容在 flue，不动本表 messages）
// 用 LLM 把首轮对话总结成一句话标题(类似 ChatGPT/Claude),并写库
// body: { userText, assistantText } —— 首轮的用户问题 + AI 回答
conversationsRouter.post('/:id/summarize-title', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      userText: z.string().default(''),
      assistantText: z.string().default(''),
    }).parse(req.body)
    const base = (process.env.LLM_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, '')
    const key = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''
    const model = process.env.LLM_MODEL || 'claude-sonnet-4-6'
    // 截断,避免过长
    const u = body.userText.slice(0, 1500)
    const a = body.assistantText.slice(0, 1500)
    const prompt = `请根据下面这轮对话,生成一个不超过 16 个汉字的简短中文标题,概括对话主题。只输出标题本身,不要引号、标点、解释。\n\n【用户】${u}\n\n【助手】${a}`
    let title = ''
    try {
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 40 }),
        signal: AbortSignal.timeout(30000),
      })
      if (resp.ok) {
        const d = await resp.json() as { choices?: { message?: { content?: string } }[] }
        title = (d.choices?.[0]?.message?.content || '').trim().replace(/^["'「」]+|["'「」。.]+$/g, '').slice(0, 20)
      }
    } catch { /* LLM 失败时用用户问题兜底 */ }
    // 兜底:LLM 没给出标题就用用户问题前 16 字
    if (!title) title = (body.userText.replace(/【[^】]*】[^\n]*\n?/g, '').trim() || '新会话').slice(0, 16)
    const row = await renameConversation(req.user!.uid, routeId(req.params.id), title)
    res.json({ title, row })
  } catch (err) { next(err) }
})

conversationsRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ title: z.string().min(1) }).parse(req.body)
    const row = await renameConversation(req.user!.uid, routeId(req.params.id), body.title)
    if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在' })
    res.json(row)
  } catch (err) { next(err) }
})

// 追加消息
conversationsRouter.post('/:id/messages', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      messages: z.array(z.object({
        id: z.string(),
        role: z.enum(['user', 'assistant']),
        content: z.string(),
        sources: z.array(z.string()).optional(),
        confidence: z.number().optional(),
        createdAt: z.string().optional(),
      })),
      title: z.string().optional(),
    }).parse(req.body)
    const row = await appendMessages(req.user!.uid, routeId(req.params.id), body.messages, body.title)
    if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在' })
    res.json(row)
  } catch (err) { next(err) }
})

// 旧会话只读；在当前 runtime 创建同项目的新会话，不复制旧 Flue transcript。
conversationsRouter.post('/:id/continue-current-runtime', async (req: AuthedRequest, res, next) => {
  try {
    const row = await continueConversationInCurrentRuntime(
      req.user!.uid,
      routeId(req.params.id),
    )
    if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在' })
    res.status(201).json(row)
  } catch (err) { next(err) }
})

// 删除会话
conversationsRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const ok = await deleteConversation(req.user!.uid, routeId(req.params.id))
    if (!ok) return res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})
