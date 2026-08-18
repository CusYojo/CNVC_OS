import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireSystemAdmin } from '../middleware/requireAuth.js'
import {
  getRadarDingTalkSettings,
  saveRadarDingTalkSettings,
  testRadarDingTalkSettings,
} from '../services/radarDingTalkService.js'

export const radarDingTalkRouter = Router()

radarDingTalkRouter.use(requireSystemAdmin)

function actor(req: AuthedRequest) {
  return { userId: req.user!.uid, userName: req.user!.name, ip: req.ip }
}

radarDingTalkRouter.get('/', async (_req, res, next) => {
  try { res.json(await getRadarDingTalkSettings()) } catch (error) { next(error) }
})

radarDingTalkRouter.put('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      expectedVersion: z.number().int().nonnegative(),
      webhookUrl: z.string().trim().url().max(2_048).optional(),
      signingSecret: z.string().trim().min(8).max(8_000).optional(),
      enabled: z.boolean(),
      notifySuccess: z.boolean(),
    }).strict().parse(req.body ?? {})
    res.json(await saveRadarDingTalkSettings(body, actor(req)))
  } catch (error) { next(error) }
})

radarDingTalkRouter.post('/test', async (req: AuthedRequest, res, next) => {
  try { res.json(await testRadarDingTalkSettings(actor(req))) } catch (error) { next(error) }
})
