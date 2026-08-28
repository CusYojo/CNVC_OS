import { Router } from 'express'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { getWorkbench } from '../services/fdeWorkbenchService.js'

export const workbenchRouter = Router()
workbenchRouter.get('/', async (req: AuthedRequest, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store')
  try { res.json(await getWorkbench(req.user!.uid)) } catch (error) { next(error) }
})
