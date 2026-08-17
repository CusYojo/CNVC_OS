import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireImAdmin } from '../middleware/requireAuth.js'
import { requireImIntegrationsEnabled } from '../config/extensionFeatureFlags.js'
import {
  createLeadPushRule,
  deleteLeadPushRule,
  dispatchLeadPushRule,
  listLeadPushSettings,
  updateLeadPushRule,
  type ImActor,
} from '../services/imIntegrationService.js'

export const leadPushTargetsRouter = Router()
const uuid = z.string().uuid()
const status = z.string().trim().min(1).max(32).nullish()

leadPushTargetsRouter.use(requireImIntegrationsEnabled)

function actor(req: AuthedRequest): ImActor {
  return {
    userId: req.user!.uid, userName: req.user!.name, role: req.user!.role,
    department: req.user!.department, ip: req.ip,
  }
}

leadPushTargetsRouter.use(requireImAdmin)

leadPushTargetsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try { res.json(await listLeadPushSettings(actor(req))) } catch (error) { next(error) }
})

leadPushTargetsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      name: z.string().trim().min(1).max(128), botId: uuid, bindingId: uuid,
      leadStatus: status, projectId: uuid.nullish(),
      minScore: z.number().int().min(0).max(100).nullish(),
      messageTemplate: z.string().trim().min(1).max(4_000), enabled: z.boolean().optional(),
    }).strict().parse(req.body ?? {})
    res.status(201).json(await createLeadPushRule(body, actor(req)))
  } catch (error) { next(error) }
})

leadPushTargetsRouter.patch('/:ruleId', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      expectedVersion: z.number().int().positive(), name: z.string().trim().min(1).max(128).optional(),
      leadStatus: status.optional(), projectId: uuid.nullish(),
      minScore: z.number().int().min(0).max(100).nullish(),
      messageTemplate: z.string().trim().min(1).max(4_000).optional(), enabled: z.boolean().optional(),
    }).strict().parse(req.body ?? {})
    res.json(await updateLeadPushRule(uuid.parse(req.params.ruleId), body, actor(req)))
  } catch (error) { next(error) }
})

leadPushTargetsRouter.delete('/:ruleId', async (req: AuthedRequest, res, next) => {
  try { res.json(await deleteLeadPushRule(uuid.parse(req.params.ruleId), actor(req))) } catch (error) { next(error) }
})

leadPushTargetsRouter.post('/:ruleId/send', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      leadId: uuid, idempotencyKey: z.string().trim().min(8).max(128),
    }).strict().parse(req.body ?? {})
    res.status(202).json(await dispatchLeadPushRule({
      ruleId: uuid.parse(req.params.ruleId), ...body,
    }, actor(req)))
  } catch (error) { next(error) }
})
