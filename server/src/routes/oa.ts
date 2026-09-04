import { Router } from 'express'
import { z } from 'zod'
import { officeRouter } from './office.js'
import { listApprovalCenter } from '../services/fdeApprovalCenterService.js'
import { readTypeApprovalNotice } from '../services/fdeTypeApprovalService.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { oaActionSchema } from '../contracts/oaWorkflowActionContract.js'
import {
  actOnOaApprovalRequest,
  createOaApprovalRequest,
  listOaApprovalRequests,
  listOaWorkflowLogs,
} from '../services/oaWorkflowService.js'

export const oaRouter = Router()
oaRouter.use('/office', officeRouter)
oaRouter.get('/center', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.json(await listApprovalCenter(req.user!.uid, req.query))
  } catch (error) { next(error) }
})

oaRouter.post('/type-notices/:id/read', async (req: AuthedRequest, res, next) => {
  try {
    z.object({}).strict().parse(req.body)
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    res.json(await readTypeApprovalNotice(z.string().uuid().parse(req.params.id), req.user!.uid))
  } catch (error) { next(error) }
})

const projectStage = z.enum(['入库', '立项', '尽调计划制定', '尽调计划审核', '启动尽调', '内核', '投决', '打款', '已 Close', '线索', '初筛', '尽调', '上会', '投后', '退出', '放弃'])
const createSchema = z.object({
  projectId: z.string().uuid(),
  targetStage: projectStage,
  reason: z.string().trim().min(5).max(8_000),
  priority: z.enum(['普通', '紧急']).default('普通'),
  amount: z.string().max(2_000).optional(),
  valuation: z.string().max(2_000).optional(),
  attachments: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
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
    const body = oaActionSchema.parse(req.body)
    const result = await actOnOaApprovalRequest({
      userId: req.user!.uid,
      requestId,
      ...body,
    })
    res.json(result)
  } catch (error) { next(error) }
})
