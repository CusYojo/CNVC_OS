import './security/hardenImageSizeRuntime.js'
import { randomUUID } from 'node:crypto'
import cors from 'cors'
import express from 'express'
import type { Server } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { apiRouter } from './routes/index.js'
import { imInboundRouter } from './routes/imIntegrations.js'
import { errorHandler } from './middleware/errorHandler.js'
import { requireAuth } from './middleware/requireAuth.js'
import { assertSchemaReady } from './db/migrate.js'
import { seedUsers } from './services/authService.js'
import { aiTaskWorkerHealth, recoverAiTasks, stopAiTaskWorker } from './services/aiTaskService.js'
import { pool } from './db/client.js'
import {
  jwAgentRuntimeHealth,
  recoverInterruptedJwAgentSessions,
  shutdownJwAgentRuntime,
} from './runtime/jwAgentRuntime.js'
import { radarCollectorHealth } from './services/radarCollectorService.js'
import { responsibilityScannerHealth, startResponsibilityScanner, stopResponsibilityScanner } from './services/fdeResponsibilityScanner.js'
import { ensureRadarMySqlSeeded, radarMySqlSourceHealth } from './services/radarDataMigrationService.js'
import {
  runtimeJobSchedulerHealth,
  startRuntimeJobScheduler,
  stopRuntimeJobScheduler,
} from './services/runtimeJobScheduler.js'
import {
  leadEnrichmentWorkerHealth,
  startLeadEnrichmentWorker,
  stopLeadEnrichmentWorker,
} from './services/leadEnrichmentWorkerService.js'
import {
  projectScoreJobHealth,
  startProjectScoreJobWorker,
  stopProjectScoreJobWorker,
} from './services/projectScoreJobService.js'
import { executeProjectScoring } from './services/projectScoringService.js'
import {
  AI_QA_SKILL_NAME,
  AI_REQUIRED_DOCUMENT_SKILL_NAMES,
  loadAiSkill,
} from './services/aiSkillService.js'
import {
  agentSocketHealth,
  initializeAgentSocket,
  shutdownAgentSocket,
} from './runtime/agentSocketService.js'
import { requestOriginAllowed, sessionAuthHealth } from './services/sessionAuthService.js'
import {
  shutdownSupervisedProcesses,
  supervisedProcessHealth,
} from './runtime/supervisedProcessService.js'
import { safeErrorLog } from './security/redactSecrets.js'
import { assertRuntimeConfiguration } from './config/runtimeSafety.js'
import { installStructuredLogging, runWithRequestLogContext } from './runtime/structuredLogger.js'
import { recoverInterruptedAiTemplateAnalysisProgress } from './services/aiTemplateAnalysisProgressService.js'
import { ensureBuiltinCapabilityCatalog } from './services/aiCapabilityService.js'
import { cleanupStaleProjectFileTemps } from './services/projectFileStorageService.js'
import { beginHttpTelemetry } from './runtime/httpTelemetry.js'
import { aiRuntimeTelemetrySnapshot } from './runtime/aiRuntimeTelemetry.js'
import { migrationWriteFreezePolicy } from './config/migrationWriteFreezePolicy.js'
import { startWeixinMessageBridge, stopWeixinMessageBridge } from './services/weixinMessageBridge.js'
import { leadBpWorkerHealth, startLeadBpWorker, stopLeadBpWorker } from './services/leadIntakeService.js'
import { radarInboundRouter } from './routes/radar.js'
import { scheduleInterruptedProjectFileRecovery } from './services/ragService.js'
import { normalizeTextPayload } from './contracts/textIntegrityContract.js'
import { sanitizeTextPayloadForDisplay } from './services/textQualityService.js'

assertRuntimeConfiguration()
installStructuredLogging()

const app = express()
const port = Number(process.env.API_PORT ?? 4100)
const distDir = path.resolve(process.cwd(), 'dist')
let serviceReady = false
let httpServer: Server | undefined
let shuttingDown = false

app.use((req, res, next) => {
  const startedAt = Date.now()
  const finishTelemetry = beginHttpTelemetry()
  const supplied = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].trim() : ''
  const requestId = /^[A-Za-z0-9._:-]{8,64}$/.test(supplied) ? supplied : randomUUID()
  res.locals.requestId = requestId
  res.setHeader('X-Request-ID', requestId)
  res.once('finish', () => {
    finishTelemetry(res.statusCode)
    console.log(JSON.stringify({
      event: 'http_request', requestId, method: req.method, path: req.path,
      status: res.statusCode, durationMs: Date.now() - startedAt,
    }))
  })
  const sendJson = res.json.bind(res)
  res.json = ((body: unknown) => {
    const safeBody = sanitizeTextPayloadForDisplay(body)
    if (
      res.statusCode >= 400
      && safeBody
      && typeof safeBody === 'object'
      && !Array.isArray(safeBody)
      && 'code' in safeBody
      && 'message' in safeBody
    ) {
      const errorBody = safeBody as Record<string, unknown>
      return sendJson({
        ...errorBody,
        details: errorBody.details ?? null,
        requestId: errorBody.requestId || requestId,
      })
    }
    return sendJson(safeBody)
  }) as typeof res.json
  runWithRequestLogContext(requestId, next)
})

app.use((req, res, next) => cors({
  origin: requestOriginAllowed(req.headers),
  credentials: true,
  exposedHeaders: ['X-Request-ID'],
})(req, res, next))
app.use((req, res, next) => {
  if (
    !migrationWriteFreezePolicy.enabled
    || !migrationWriteFreezePolicy.httpMutationMethods.includes(req.method as 'POST' | 'PUT' | 'PATCH' | 'DELETE')
  ) {
    next()
    return
  }
  res.setHeader('Retry-After', '60')
  res.status(503).json({
    code: 'MIGRATION_WRITE_FROZEN',
    message: '迁移回滚观察窗内已冻结写入，请使用只读功能。',
    details: { mode: migrationWriteFreezePolicy.mode },
  })
})
app.use(express.json({
  limit: '150mb',
  verify: (req, _res, buffer) => {
    // Preserve bytes only for the signed Radar webhook. HMAC must cover the
    // exact body received over the wire, not a re-serialized JSON object.
    if (req.url?.startsWith('/api/wechat-chat/push')) {
      ;(req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer)
    }
  },
}))
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
        requestId: String(res.locals.requestId || ''),
      })
      return
    }
  }
  next(err)
})
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.body == null) {
    next()
    return
  }
  const normalized = normalizeTextPayload(req.body)
  if (normalized.issue) {
    res.status(422).json({
      code: 'TEXT_ENCODING_INVALID',
      message: '检测到无法识别的文字，请重新输入；若来自文件，请重新导出后上传',
      details: { field: normalized.issue.path },
    })
    return
  }
  req.body = normalized.value
  next()
})

// 公共探针与登录（无鉴权）
app.get('/api/health', (_req, res) => res.status(serviceReady ? 200 : 503).json({
  ok: serviceReady,
  service: 'cybernaut-app',
  status: serviceReady ? 'ready' : 'starting',
  qaSkillName: AI_QA_SKILL_NAME,
  documentSkillNames: AI_REQUIRED_DOCUMENT_SKILL_NAMES,
  writeMode: migrationWriteFreezePolicy.mode,
  timestamp: new Date().toISOString(),
}))
app.get('/api/health/components', async (_req, res) => {
  const intentionallyDisabled = (name: string) => ({
    name,
    ok: true,
    inProcess: true,
    state: 'intentionally-disabled',
    reason: migrationWriteFreezePolicy.mode,
  })
  const components = migrationWriteFreezePolicy.enabled
    ? [
        jwAgentRuntimeHealth(),
        agentSocketHealth(),
        aiRuntimeTelemetrySnapshot(),
        intentionallyDisabled('radar-typescript-collector'),
        await radarMySqlSourceHealth(),
        intentionallyDisabled('mysql-runtime-jobs'),
        intentionallyDisabled('mysql-lead-score-jobs'),
        intentionallyDisabled('mysql-lead-enrichment'),
        intentionallyDisabled('mysql-lead-bp-jobs'),
        intentionallyDisabled('mysql-project-score-jobs'),
        intentionallyDisabled('mysql-ai-tasks'),
        intentionallyDisabled('fde-responsibility-scanner'),
        supervisedProcessHealth(),
        await sessionAuthHealth(),
        {
          name: 'migration-write-freeze', ok: true, inProcess: true,
          mode: migrationWriteFreezePolicy.mode,
          mysqlSessionDefault: 'read-only',
          httpMutationMethodsBlocked: migrationWriteFreezePolicy.httpMutationMethods,
        },
      ]
    : [
        jwAgentRuntimeHealth(),
        agentSocketHealth(),
        aiRuntimeTelemetrySnapshot(),
        await radarCollectorHealth(),
        await radarMySqlSourceHealth(),
        await runtimeJobSchedulerHealth(),
        await leadEnrichmentWorkerHealth(),
        await leadBpWorkerHealth(),
        await projectScoreJobHealth(),
        await aiTaskWorkerHealth(),
        responsibilityScannerHealth(),
        supervisedProcessHealth(),
        await sessionAuthHealth(),
      ]
  const ok = serviceReady && components.every((component) => component.ok)
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'cybernaut-app',
    apiReady: serviceReady,
    writeMode: migrationWriteFreezePolicy.mode,
    components,
    timestamp: new Date().toISOString(),
  })
})

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

// IM platform callbacks authenticate with a dedicated encrypted per-bot
// secret, so they must be mounted before the browser-session middleware.
app.use('/api/integrations/im/inbound', imInboundRouter)
// 微信群聊采集端使用独立 Push 密钥，必须与 IM 回调一样先于浏览器会话鉴权挂载。
app.use('/api/wechat-chat', radarInboundRouter)

// 受保护业务路由（仅登录、健康探针与 LLM 探针公开）
app.use('/api', (req, res, next) => {
  // 其余请求统一走 HttpOnly 会话（迁移窗口内可显式开启 Bearer）。
  if (
    req.path === '/health' ||
    req.path === '/auth/login' ||
    req.path === '/auth/register' ||
    req.path === '/auth/registration-options' ||
    req.path === '/llm-health' ||
    req.path.startsWith('/auth/login')
  ) {
    next()
    return
  }
  return requireAuth(req, res, next)
})
app.use('/api', apiRouter)

// API misses must never fall through to Express' HTML 404 or the SPA.  This
// also makes intentionally retired legacy endpoints observable as a stable,
// authenticated JSON contract during migration and rollback drills.
app.use('/api', (_req, res) => {
  res.status(404).json({
    code: 'NOT_FOUND',
    message: '接口不存在或已停用',
    details: null,
  })
})

// 旧公开 generated 链路明确退场，避免被 SPA fallback 伪装成成功响应。
app.use('/generated', (_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: '公开生成文件链接已停用' })
})

// 静态资源 & SPA fallback
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api')) {
      res.sendFile(path.join(distDir, 'index.html'))
      return
    }
    next()
  })
}
app.use(errorHandler)

// 主服务启动只验证 schema；DDL 必须由显式迁移流程使用独立权限执行。
// 历史固定演示账号生成入口已永久退役。
async function start() {
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer = app.listen(port, '127.0.0.1')
      httpServer.once('listening', resolve)
      httpServer.once('error', reject)
    })
    await assertSchemaReady()
    if (migrationWriteFreezePolicy.enabled) {
      initializeAgentSocket(httpServer!)
      serviceReady = true
      console.log(`[app] migration write freeze active mode=${migrationWriteFreezePolicy.mode}`)
      console.log(`[app] listening on http://127.0.0.1:${port}`)
      return
    }
    const fileTempCleanup = await cleanupStaleProjectFileTemps()
    console.log(`[project-files] temporary cleanup scanned=${fileTempCleanup.scanned} removed=${fileTempCleanup.removed} fresh=${fileTempCleanup.retainedFresh} ignored=${fileTempCleanup.ignored} symlinks=${fileTempCleanup.skippedSymlinks}`)
    const interruptedProjectFiles = await scheduleInterruptedProjectFileRecovery()
    console.log(`[project-file-recovery] startup queued=${interruptedProjectFiles}`)
    const demoSeed = await seedUsers()
    const capabilityCatalog = await ensureBuiltinCapabilityCatalog()
    console.log(`[ai-capability] builtin catalog ready capabilities=${capabilityCatalog.capabilities}`)
    const requiredDocumentSkills = await Promise.all(
      AI_REQUIRED_DOCUMENT_SKILL_NAMES.map((name) => loadAiSkill(name)),
    )
    console.log(`[ai-skill] document skills ready ${requiredDocumentSkills
      .map((skill) => `${skill.name}=${skill.version}`)
      .join(' ')}`)
    const jwRecovery = await recoverInterruptedJwAgentSessions()
    console.log(`[jw-runtime] startup recovery conversations=${jwRecovery.conversations} messages=${jwRecovery.messages} parts=${jwRecovery.parts}`)
    await recoverAiTasks()
    const interruptedTemplateAnalyses = await recoverInterruptedAiTemplateAnalysisProgress()
    console.log(`[ai-template-analysis] startup recovery interrupted=${interruptedTemplateAnalyses}`)
    await startLeadEnrichmentWorker()
    await startProjectScoreJobWorker(executeProjectScoring)
    await startLeadBpWorker()
    const radarSeed = await ensureRadarMySqlSeeded()
    console.log(`[radar-mysql] seed skipped=${radarSeed.skipped} candidates=${radarSeed.currentCandidates}`)
    await startRuntimeJobScheduler()
    startResponsibilityScanner()
    startWeixinMessageBridge()
    initializeAgentSocket(httpServer!)
    console.log(`[db] schema ready account-seed=${demoSeed.retired ? 'retired' : demoSeed.skipped ? 'disabled' : demoSeed.seeded}`)
    serviceReady = true
    console.log(`[app] listening on http://127.0.0.1:${port}`)
  } catch (err) {
    console.error('[db] startup failed:', (err as Error).message)
    process.exit(1)
  }
}
start()

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  serviceReady = false
  console.log(`[shutdown] received ${signal}`)
  const timeout = setTimeout(() => process.exit(1), 30_000)
  timeout.unref()
  await shutdownAgentSocket()
  await stopWeixinMessageBridge()
  await stopRuntimeJobScheduler()
  await stopResponsibilityScanner()
  await stopProjectScoreJobWorker()
  await stopLeadBpWorker()
  await stopLeadEnrichmentWorker()
  const aiTasks = migrationWriteFreezePolicy.enabled
    ? { active: 0, releasedLeases: 0, cancelled: 0 }
    : await stopAiTaskWorker()
  await shutdownJwAgentRuntime()
  const childProcesses = await shutdownSupervisedProcesses()
  await new Promise<void>((resolve) => {
    if (!httpServer) return resolve()
    httpServer.close(() => resolve())
  })
  console.log(`[shutdown] ai-tasks active=${aiTasks.active} leases-released=${aiTasks.releasedLeases} child-processes-terminated=${childProcesses.terminated} remaining=${childProcesses.remaining}`)
  await pool.end()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// 进程保活时的可读错误
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ event: 'unhandledRejection', error: safeErrorLog(reason) }))
})
