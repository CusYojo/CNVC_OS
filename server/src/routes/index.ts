import { Router } from 'express'
import { authRouter } from './auth.js'
import { projectsRouter } from './projects.js'
import { meetingsRouter, todosRouter, aiRouter } from './meetings.js'
import { risksRouter } from './risks.js'
import { metaRouter } from './meta.js'
import { conversationsRouter } from './conversations.js'
import { workspaceRouter } from './workspace.js'
import { createMaterial } from '../controllers/materialController.js'
import { oaRouter } from './oa.js'
import { generateAiSlide } from '../services/aiCoverService.js'
import { aiTasksRouter } from './aiTasks.js'
import { jwAgentRouter } from './jwAgent.js'
import { aiModelSettingsRouter } from './aiModelSettings.js'
import { aiCapabilitiesRouter } from './aiCapabilities.js'
import { imIntegrationsRouter } from './imIntegrations.js'
import { leadPushTargetsRouter } from './leadPushTargets.js'
import { operationsRouter } from './operations.js'
import { systemAdministrationRouter } from './systemAdministration.js'
import { leadIntakeRouter } from './leadIntake.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { createReadStream } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { writeAudit } from '../services/auditService.js'

export const apiRouter = Router()

apiRouter.use('/auth', authRouter)
apiRouter.use('/projects', projectsRouter)
apiRouter.use('/meetings', meetingsRouter)
apiRouter.use('/todos', todosRouter)
apiRouter.use('/risks', risksRouter)
apiRouter.use('/', leadIntakeRouter)
apiRouter.use('/', metaRouter) // /users /templates /audit-logs /leads /ai-summaries
apiRouter.use('/oa', oaRouter)
apiRouter.use('/ai', aiRouter)
apiRouter.use('/ai', aiTasksRouter)
apiRouter.use('/agent', jwAgentRouter)
apiRouter.use('/ai/model-settings', aiModelSettingsRouter)
apiRouter.use('/ai/capabilities', aiCapabilitiesRouter)
apiRouter.use('/integrations/im', imIntegrationsRouter)
apiRouter.use('/investment/leads/push-targets', leadPushTargetsRouter)
apiRouter.use('/operations', operationsRouter)
apiRouter.use('/system-administration', systemAdministrationRouter)
apiRouter.use('/conversations', conversationsRouter)
apiRouter.use('/workspace', workspaceRouter)
apiRouter.post('/materials/generate', createMaterial)
apiRouter.post('/materials/ai-cover', async (req: AuthedRequest, res, next) => {
  try {
    const { prompt, size } = req.body ?? {}
    if (!prompt || typeof prompt !== 'string') { res.status(400).json({ code: 'INVALID_ARGUMENT', message: '缺少 prompt' }); return }
    const result = await generateAiSlide(prompt, typeof size === 'string' ? size : undefined, req.user!.uid)
    res.json({ code: 0, message: 'success', ...result })
  } catch (err) { next(err) }
})

const generatedRoot = resolve(process.cwd(), 'server/generated')
const generatedMime: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

// 新生成材料只能由创建用户通过登录会话读取；旧 generated 根目录不再公开。
apiRouter.get('/generated/:file', async (req: AuthedRequest, res, next) => {
  try {
    const fileName = String(req.params.file ?? '')
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
      res.status(400).json({ code: 'BAD_PATH', message: '非法文件名' })
      return
    }
    const userRoot = resolve(generatedRoot, req.user!.uid)
    const filePath = resolve(userRoot, fileName)
    if (!filePath.startsWith(`${userRoot}${sep}`)) {
      res.status(400).json({ code: 'BAD_PATH', message: '非法文件名' })
      return
    }
    const [rootReal, fileReal, linkInfo] = await Promise.all([
      realpath(userRoot).catch(() => userRoot),
      realpath(filePath).catch(() => null),
      lstat(filePath).catch(() => null),
    ])
    if (!fileReal || !linkInfo || linkInfo.isSymbolicLink()
      || (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${sep}`))) {
      res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在' })
      return
    }
    const fileStat = await stat(filePath).catch(() => null)
    if (!fileStat?.isFile()) {
      res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在' })
      return
    }
    const fileKey = createHash('sha256').update(fileName).digest('hex')
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: '生成产物', action: '读取生成产物',
      target: `generated-file:${fileKey};bytes:${fileStat.size}`,
      ip: req.ip,
    })
    res.setHeader('Content-Type', generatedMime[extname(fileName).toLowerCase()] || 'application/octet-stream')
    res.setHeader('Content-Length', String(fileStat.size))
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    createReadStream(filePath).on('error', next).pipe(res)
  } catch (error) { next(error) }
})

// /api/llm-health: 网关连通性探针，前端 dashboard 用
apiRouter.get('/llm-health', async (_req, res) => {
  const base = (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, '')
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY
  const t0 = Date.now()
  try {
    // Some compatible gateways do not expose GET /models. An authenticated,
    // deliberately incomplete request proves route/auth reachability without
    // starting a billable model generation.
    const r = await fetch(`${base}/responses`, {
      method: 'POST',
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(4000),
    })
    const ms = Date.now() - t0
    const ok = r.ok || r.status === 400 || r.status === 422
    res.status(ok ? 200 : 503).json({ ok, base, ms, status: r.status })
  } catch (err) {
    res.status(503).json({ ok: false, base, error: (err as Error).message })
  }
})
