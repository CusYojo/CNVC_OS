import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireSystemAdmin } from '../middleware/requireAuth.js'
import { operationalTelemetrySnapshot } from '../services/operationalTelemetryService.js'
import {
  listManagedRadarSources,
  importManagedWechatAccounts,
  setManagedRadarSourceEnabled,
  updateManagedRadarSourceMetadata,
} from '../services/radarSourceManagementService.js'
import {
  listRadarRuntimeJobs,
  listKr36RuntimeJobs,
  queueKr36RuntimeJobNow,
  queueRadarRuntimeJobNow,
  setKr36RuntimeJobEnabled,
  setRadarRuntimeJobEnabled,
} from '../services/runtimeJobScheduler.js'
import { writeAudit } from '../services/auditService.js'
import { getKr36CandidateSupplySnapshot } from '../services/kr36ProjectCandidateService.js'
import { previewKr36ProjectSupply } from '../services/kr36ProjectSyncService.js'

export const operationsRouter = Router()

operationsRouter.get('/metrics', requireSystemAdmin, async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    res.json(await operationalTelemetrySnapshot())
  } catch (error) {
    next(error)
  }
})

operationsRouter.get('/radar', requireSystemAdmin, async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    const [sources, jobs] = await Promise.all([
      listManagedRadarSources(),
      listRadarRuntimeJobs(),
    ])
    res.json({ sources, jobs })
  } catch (error) {
    next(error)
  }
})

operationsRouter.get('/kr36', requireSystemAdmin, async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    const [supply, jobs] = await Promise.all([
      getKr36CandidateSupplySnapshot(),
      listKr36RuntimeJobs(),
    ])
    res.json({ supply, jobs })
  } catch (error) {
    next(error)
  }
})

operationsRouter.get('/kr36/preview', requireSystemAdmin, async (req, res, next) => {
  try {
    const query = z.object({
      pages: z.coerce.number().int().min(1).max(5).default(1),
    }).parse(req.query)
    res.setHeader('Cache-Control', 'private, no-store')
    res.json(await previewKr36ProjectSupply({ pagesPerYear: query.pages, minimumYear: 2025 }))
  } catch (error) {
    next(error)
  }
})

operationsRouter.patch('/kr36/jobs/:id', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body)
    const id = z.string().min(1).max(64).parse(req.params.id)
    const job = await setKr36RuntimeJobEnabled(id, input.enabled)
    await writeAudit({
      userId: req.user!.uid,
      userName: req.user!.name,
      module: '36氪项目源',
      action: input.enabled ? '启用任务' : '停用任务',
      target: id,
      ip: req.ip,
      requestId: String(res.locals.requestId || ''),
    })
    res.json(job)
  } catch (error) {
    next(error)
  }
})

operationsRouter.post('/kr36/jobs/:id/run', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const id = z.string().min(1).max(64).parse(req.params.id)
    const result = await queueKr36RuntimeJobNow(id)
    await writeAudit({
      userId: req.user!.uid,
      userName: req.user!.name,
      module: '36氪项目源',
      action: '立即执行任务',
      target: id,
      ip: req.ip,
      requestId: String(res.locals.requestId || ''),
    })
    res.status(202).json(result)
  } catch (error) {
    next(error)
  }
})

operationsRouter.patch('/radar/sources/:id', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const input = z.object({
      enabled: z.boolean().optional(),
      group: z.string().max(64).optional(),
      frequency: z.string().max(64).optional(),
    }).strict().refine((value) => Object.values(value).some((entry) => entry !== undefined), '至少提供一个修改字段').parse(req.body)
    const id = z.string().min(1).max(64).parse(req.params.id)
    let source = input.enabled === undefined
      ? (await listManagedRadarSources()).find((item) => item.id === id)
      : await setManagedRadarSourceEnabled(id, input.enabled)
    if (input.group !== undefined || input.frequency !== undefined) {
      source = await updateManagedRadarSourceMetadata(id, { group: input.group, frequency: input.frequency })
    }
    await writeAudit({
      userId: req.user!.uid,
      userName: req.user!.name,
      module: 'Radar来源',
      action: input.enabled === true ? '启用来源' : input.enabled === false ? '停用来源' : '修改来源配置',
      target: `${source?.name || req.params.id}:${req.params.id}`,
      ip: req.ip,
      requestId: String(res.locals.requestId || ''),
    })
    res.json(source)
  } catch (error) {
    next(error)
  }
})

operationsRouter.post('/radar/wechat-accounts/import', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const input = z.object({
      name: z.string().min(1).max(255),
      dataBase64: z.string().min(1),
      replace: z.boolean().optional().default(false),
    }).strict().parse(req.body)
    const result = await importManagedWechatAccounts(input)
    await writeAudit({
      userId: req.user!.uid,
      userName: req.user!.name,
      module: 'Radar来源',
      action: input.replace ? '替换公众号账号' : '导入公众号账号',
      target: `${input.name};imported:${result.imported};total:${result.total}`,
      ip: req.ip,
      requestId: String(res.locals.requestId || ''),
    })
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

operationsRouter.patch('/radar/jobs/:id', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body)
    const id = z.string().min(1).max(64).parse(req.params.id)
    const job = await setRadarRuntimeJobEnabled(id, input.enabled)
    await writeAudit({
      userId: req.user!.uid,
      userName: req.user!.name,
      module: 'Radar调度',
      action: input.enabled ? '启用任务' : '停用任务',
      target: id,
      ip: req.ip,
      requestId: String(res.locals.requestId || ''),
    })
    res.json(job)
  } catch (error) {
    next(error)
  }
})

operationsRouter.post('/radar/jobs/:id/run', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const id = z.string().min(1).max(64).parse(req.params.id)
    const result = await queueRadarRuntimeJobNow(id)
    await writeAudit({
      userId: req.user!.uid,
      userName: req.user!.name,
      module: 'Radar调度',
      action: '立即执行任务',
      target: id,
      ip: req.ip,
      requestId: String(res.locals.requestId || ''),
    })
    res.status(202).json(result)
  } catch (error) {
    next(error)
  }
})
