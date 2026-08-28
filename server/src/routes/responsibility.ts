import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { executeResponsibilityCommand, getResponsibilityRecord, listResponsibilityRecords, recoverResponsibilityCommand, getResponsibilityOverview, responsibilityEvidenceOptions } from '../services/fdeResponsibilityService.js'

export const responsibilityRouter = Router()
responsibilityRouter.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff'); next() })
responsibilityRouter.get('/overview', async (req: AuthedRequest, res, next) => {
  try { res.json(await getResponsibilityOverview(req.user!.uid)) } catch (error) { next(error) }
})
responsibilityRouter.get('/:id/evidence-options', async (req: AuthedRequest, res, next) => {
  try { res.json(await responsibilityEvidenceOptions(req.user!.uid, String(req.params.id), req.query)) } catch (error) { next(error) }
})
responsibilityRouter.get('/', async (req: AuthedRequest, res, next) => {
  try { res.json(await listResponsibilityRecords(req.user!.uid, req.query)) } catch (error) { next(error) }
})
responsibilityRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).strict().parse(req.query)
    res.json(await getResponsibilityRecord(req.user!.uid, String(req.params.id), query.page))
  } catch (error) { next(error) }
})
responsibilityRouter.post('/projects/:projectId/commands', async (req: AuthedRequest, res, next) => {
  try { res.json(await executeResponsibilityCommand(String(req.params.projectId), req.user!.uid, req.body)) } catch (error) { next(error) }
})
responsibilityRouter.post('/projects/:projectId/commands/recover', async (req: AuthedRequest, res, next) => {
  try { res.json(await recoverResponsibilityCommand(String(req.params.projectId), req.user!.uid, req.body)) } catch (error) { next(error) }
})
