import cors from 'cors'
import express from 'express'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { apiRouter } from './routes/index.js'
import { internalRouter } from './routes/internal.js'
import { errorHandler } from './middleware/errorHandler.js'
import { requireAuth } from './middleware/requireAuth.js'
import { ensureSchema } from './db/migrate.js'
import { seedUsers } from './services/authService.js'
import { recoverAiTasks } from './services/aiTaskService.js'
import { recoverLeadScoringQueue } from './routes/meta.js'
import { backfillLeadBusinessRegions } from './services/leadRegionBackfill.js'
import {
  AI_QA_SKILL_NAME,
  AI_REQUIRED_DOCUMENT_SKILL_NAMES,
  loadAiSkill,
} from './services/aiSkillService.js'

const app = express()
const port = Number(process.env.API_PORT ?? 3100)
const generatedDir = path.resolve(process.cwd(), 'server/generated')
const distDir = path.resolve(process.cwd(), 'dist')
let serviceReady = false

app.use(cors())
app.use(express.json({ limit: '150mb' }))
// 【上传400修复】express.json 解析失败(如上传大文件传到一半连接断开、body 被截断)时，
// 默认会返回裸 400 空响应，前端无法 catch 只会卡住。这里捕获成明确 JSON 错误，前端能提示重试。
app.use((err: unknown, _req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
  if (err && typeof err === 'object' && ('type' in err || 'status' in err)) {
    const e = err as { type?: string; status?: number; message?: string }
    if (e.type === 'entity.parse.failed' || e.type === 'entity.too.large' || e.status === 400 || e.status === 413) {
      res.status(e.status ?? 400).json({
        code: e.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'BAD_BODY',
        message: e.type === 'entity.too.large' ? '文件过大超出上限' : '上传数据不完整或已中断，请重试（大文件请耐心等待上传完成）',
        details: null,
      })
      return
    }
  }
  next(err)
})

// 公共探针与登录（无鉴权）
app.get('/api/health', (_req, res) => res.status(serviceReady ? 200 : 503).json({
  ok: serviceReady,
  service: 'intelligent-investment-platform-api',
  status: serviceReady ? 'ready' : 'starting',
  qaSkillName: AI_QA_SKILL_NAME,
  documentSkillNames: AI_REQUIRED_DOCUMENT_SKILL_NAMES,
  timestamp: new Date().toISOString(),
}))

// Bind the API socket before running any startup recovery. A second process
// must fail fast on EADDRINUSE instead of recovering and executing the same AI
// tasks in the background without owning the HTTP listener.
app.use('/api', (req, res, next) => {
  if (serviceReady || req.path === '/health') {
    next()
    return
  }
  res.status(503).json({
    code: 'SERVICE_STARTING',
    message: '服务正在完成启动恢复，请稍后重试。',
    details: null,
  })
})

// 内部端点（供 flue assistant agent 的 tools 回调）：x-internal-secret 校验，挂在用户鉴权之前
app.use('/api/internal', internalRouter)

// 受保护业务路由（除 /auth/login, /auth/me, /health, /llm-health）
app.use('/api', (req, res, next) => {
  // 放行：health、登录、llm 健康、内部密钥调用
  if (
    req.path === '/health' ||
    req.path === '/auth/login' ||
    req.path === '/llm-health' ||
    req.path.startsWith('/auth/login') ||
    req.path === '/materials/generate-internal' ||
    req.header('x-internal-secret') === (process.env.INTERNAL_SECRET || 'cybernaut-internal-2026')
  ) {
    next()
    return
  }
  return requireAuth(req, res, next)
})
app.use('/api', apiRouter)

// 静态资源 & SPA fallback
app.use('/generated', express.static(generatedDir))
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api') && !req.path.startsWith('/generated')) {
      res.sendFile(path.join(distDir, 'index.html'))
      return
    }
    next()
  })
}
app.use(errorHandler)

// 启动时先确保 schema，再 seed 用户
async function start() {
  try {
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1')
      server.once('listening', resolve)
      server.once('error', reject)
    })
    await ensureSchema()
    await seedUsers()
    const requiredDocumentSkills = await Promise.all(
      AI_REQUIRED_DOCUMENT_SKILL_NAMES.map((name) => loadAiSkill(name)),
    )
    console.log(`[ai-skill] document skills ready ${requiredDocumentSkills
      .map((skill) => `${skill.name}=${skill.version}`)
      .join(' ')}`)
    const regionBackfill = await backfillLeadBusinessRegions()
    console.log(`[lead-region] startup backfill scanned=${regionBackfill.scanned} updated=${regionBackfill.updated} unresolved=${regionBackfill.unresolved}`)
    await recoverAiTasks()
    const scoreRecovery = await recoverLeadScoringQueue()
    console.log(`[lead-score] startup recovery found=${scoreRecovery.found} queued=${scoreRecovery.recovered}`)
    console.log('[db] schema ready & demo users seeded')
    serviceReady = true
    console.log(`Mock API listening on http://127.0.0.1:${port}`)
  } catch (err) {
    console.error('[db] startup failed:', (err as Error).message)
    process.exit(1)
  }
}
start()

// 进程保活时的可读错误
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason))
