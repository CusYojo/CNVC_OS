import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import {
  abortJwAgent,
  getJwAgentSnapshot,
  respondJwAgentInteraction,
  sendJwAgentMessage,
  switchJwAgentModel,
} from '../runtime/jwAgentRuntime.js'

export const jwAgentRouter = Router()
const agentId = (value: string | string[]) => z.string().min(1).max(128).parse(value)

jwAgentRouter.get('/conversations/:agentId', async (req: AuthedRequest, res, next) => {
  try {
    const snapshot = await getJwAgentSnapshot(req.user!.uid, agentId(req.params.agentId))
    if (!snapshot) return res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在' })
    res.json(snapshot)
  } catch (error) { next(error) }
})

jwAgentRouter.post('/conversations/:agentId/messages', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ message: z.string().min(1).max(200_000) }).parse(req.body ?? {})
    const result = await sendJwAgentMessage(req.user!.uid, req.user!.role, agentId(req.params.agentId), body.message)
    if (!result) return res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在' })
    res.status(202).json(result)
  } catch (error) { next(error) }
})

jwAgentRouter.post('/conversations/:agentId/abort', async (req: AuthedRequest, res, next) => {
  try {
    const result = await abortJwAgent(req.user!.uid, agentId(req.params.agentId))
    if (!result) return res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在' })
    res.json(result)
  } catch (error) { next(error) }
})

jwAgentRouter.patch('/conversations/:agentId/model', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ modelId: z.string().uuid().nullable() }).parse(req.body ?? {})
    const result = await switchJwAgentModel({
      userId: req.user!.uid,
      userName: req.user!.name,
      userRole: req.user!.role,
      agentId: agentId(req.params.agentId),
      modelId: body.modelId,
    })
    if (!result) return res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在' })
    res.json(result)
  } catch (error) { next(error) }
})

jwAgentRouter.post('/conversations/:agentId/interactions/:interactionId/respond', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      action: z.enum(['answer', 'cancel']),
      answers: z.record(z.string().min(1).max(32), z.union([
        z.string().max(500),
        z.array(z.string().max(500)).min(1).max(8),
      ])).optional(),
    }).parse(req.body ?? {})
    const interactionId = z.string().min(1).max(160).parse(req.params.interactionId)
    const result = await respondJwAgentInteraction({
      userId: req.user!.uid,
      agentId: agentId(req.params.agentId),
      interactionId,
      action: body.action,
      answers: body.answers,
    })
    if (!result) return res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在' })
    res.json(result)
  } catch (error) { next(error) }
})
