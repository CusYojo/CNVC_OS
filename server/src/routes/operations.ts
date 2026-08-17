import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireSystemAdmin } from '../middleware/requireAuth.js'
import { operationalTelemetrySnapshot } from '../services/operationalTelemetryService.js'
import {
  listManagedRadarSources,
  setManagedRadarSourceEnabled,
} from '../services/radarSourceManagementService.js'
import {
  listRadarRuntimeJobs,
  queueRadarRuntimeJobNow,
  setRadarRuntimeJobEnabled,
} from '../services/runtimeJobScheduler.js'
import { writeAudit } from '../services/auditService.js'

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

operationsRouter.patch('/radar/sources/:id', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body)
    const source = await setManagedRadarSourceEnabled(z.string().min(1).max(64).parse(req.params.id), input.enabled)
    await writeAudit({
      userId: req.user!.uid,
      userName: req.user!.name,
      module: 'Radar来源',
      action: input.enabled ? '启用来源' : '停用来源',
      target: `${source?.name || req.params.id}:${req.params.id}`,
      ip: req.ip,
      requestId: String(res.locals.requestId || ''),
    })
    res.json(source)
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
