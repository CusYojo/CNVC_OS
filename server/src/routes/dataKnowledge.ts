import { Router } from 'express'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { getDataKnowledgeCapabilities } from '../services/fdeDataKnowledgeAccessService.js'
import { db } from '../db/client.js'

export const dataKnowledgeRouter = Router()
dataKnowledgeRouter.get('/capabilities', async (req: AuthedRequest, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  try { res.json(await db.transaction(tx => getDataKnowledgeCapabilities(req.user!.uid, tx), { isolationLevel: 'repeatable read', accessMode: 'read only' })) } catch (error) { next(error) }
})
