import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import {
  actOnOaApprovalRequest,
  createOaApprovalRequest,
  listOaApprovalRequests,
  listOaWorkflowLogs,
} from '../services/oaWorkflowService.js'

export const oaRouter = Router()

const projectStage = z.enum(['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出', '放弃'])
const createSchema = z.object({
  projectId: z.string().uuid(),
  targetStage: projectStage,
  reason: z.string().trim().min(5).max(8_000),
  priority: z.enum(['普通', '紧急']).default('普通'),
  amount: z.string().max(2_000).optional(),
  valuation: z.string().max(2_000).optional(),
  attachments: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
})
const actionSchema = z.object({
  action: z.enum(['approve', 'return', 'reject', 'withdraw', 'resubmit']),
  comment: z.string().trim().min(2).max(8_000),
})

oaRouter.get('/requests', async (req: AuthedRequest, res, next) => {
  try {
    const list = await listOaApprovalRequests(req.user!.uid)
    res.json({ list, total: list.length })
  } catch (error) { next(error) }
})

oaRouter.get('/workflow-logs', async (req: AuthedRequest, res, next) => {
  try {
    const list = await listOaWorkflowLogs(req.user!.uid)
    res.json({ list, total: list.length })
  } catch (error) { next(error) }
})

oaRouter.post('/requests', async (req: AuthedRequest, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    const request = await createOaApprovalRequest({ userId: req.user!.uid, ...body })
    res.status(201).json(request)
  } catch (error) { next(error) }
})

oaRouter.post('/requests/:id/actions', async (req: AuthedRequest, res, next) => {
  try {
    const requestId = z.string().uuid().parse(req.params.id)
    const body = actionSchema.parse(req.body)
    const result = await actOnOaApprovalRequest({
      userId: req.user!.uid,
      requestId,
      ...body,
    })
    res.json(result)
  } catch (error) { next(error) }
})
