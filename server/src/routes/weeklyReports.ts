import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { shanghaiToday, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { actOnWeeklyReport, createWeeklyReport, listWeeklyReports, readWeeklyReport, saveWeeklyReport, weeklyReportRecipients } from '../services/fdeWeeklyReportService.js'

export const weeklyReportsRouter = Router()
weeklyReportsRouter.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
weeklyReportsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try { res.json(await listWeeklyReports(req.user!.uid, z.string().parse(req.query.weekStart ?? weekStartFor(shanghaiToday())))) } catch (error) { next(error) }
})
weeklyReportsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try { res.status(201).json(await createWeeklyReport(req.user!.uid, req.body)) } catch (error) { next(error) }
})
weeklyReportsRouter.post('/:id/save', async (req: AuthedRequest, res, next) => {
  try { res.json(await saveWeeklyReport(z.string().uuid().parse(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) }
})
weeklyReportsRouter.post('/:id/actions', async (req: AuthedRequest, res, next) => {
  try { res.json(await actOnWeeklyReport(z.string().uuid().parse(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) }
})
weeklyReportsRouter.get('/:id/recipients', async (req: AuthedRequest, res, next) => {
  try { res.json(await weeklyReportRecipients(z.string().uuid().parse(req.params.id), req.user!.uid)) } catch (error) { next(error) }
})
weeklyReportsRouter.post('/:id/read', async (req: AuthedRequest, res, next) => {
  try { res.json(await readWeeklyReport(z.string().uuid().parse(req.params.id), req.user!.uid)) } catch (error) { next(error) }
})
