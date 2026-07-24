import { Router } from 'express'
import { authRouter } from './auth.js'
import { projectsRouter } from './projects.js'
import { meetingsRouter, todosRouter, aiRouter } from './meetings.js'
import { risksRouter } from './risks.js'
import { metaRouter } from './meta.js'
import { conversationsRouter } from './conversations.js'
import { workspaceRouter } from './workspace.js'
import { createMaterial } from '../controllers/materialController.js'
import { generateAiSlide } from '../services/aiCoverService.js'
import { aiTasksRouter } from './aiTasks.js'

export const apiRouter = Router()

apiRouter.use('/auth', authRouter)
apiRouter.use('/projects', projectsRouter)
apiRouter.use('/meetings', meetingsRouter)
apiRouter.use('/todos', todosRouter)
apiRouter.use('/risks', risksRouter)
apiRouter.use('/', metaRouter) // /users /templates /audit-logs /leads /ai-summaries
apiRouter.use('/ai', aiRouter)
apiRouter.use('/ai', aiTasksRouter)
apiRouter.use('/conversations', conversationsRouter)
apiRouter.use('/workspace', workspaceRouter)
apiRouter.post('/materials/generate', createMaterial)
// 内部端点：供 flue ppt-agent 调用可编辑 PPT 生成器（共享 secret 校验，不走用户JWT）
apiRouter.post('/materials/generate-internal', async (req, res, next) => {
  try {
    const secret = req.header('x-internal-secret')
    if (!secret || secret !== (process.env.INTERNAL_SECRET || 'cybernaut-internal-2026')) {
      res.status(403).json({ code: 'FORBIDDEN', message: 'bad internal secret' }); return
    }
    const { generateMaterial } = await import('../services/materialService.js')
    const result = await generateMaterial(req.body)
    res.json({ code: 0, message: 'success', ...result })
  } catch (err) { next(err) }
})
apiRouter.post('/materials/ai-cover', async (req, res, next) => {
  try {
    const { prompt, size } = req.body ?? {}
    if (!prompt || typeof prompt !== 'string') { res.status(400).json({ code: 'INVALID_ARGUMENT', message: '缺少 prompt' }); return }
    const result = await generateAiSlide(prompt, typeof size === 'string' ? size : undefined)
    res.json({ code: 0, message: 'success', ...result })
  } catch (err) { next(err) }
})

// /api/llm-health: 网关连通性探针，前端 dashboard 用
apiRouter.get('/llm-health', async (_req, res) => {
  const base = process.env.LLM_BASE_URL || 'http://127.0.0.1:18081/v1'
  const t0 = Date.now()
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(4000) })
    const ms = Date.now() - t0
    res.json({ ok: r.ok, base, ms, status: r.status })
  } catch (err) {
    res.status(503).json({ ok: false, base, error: (err as Error).message })
  }
})
