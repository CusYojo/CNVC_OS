import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { createRisk, listRisks, riskCounts, updateRisk } from '../services/riskService.js'

export const risksRouter = Router()
const routeId = (value: string | string[]) => z.string().min(1).parse(value)

risksRouter.get('/', async (req, res, next) => {
  try {
    res.json({ list: await listRisks(req.query.projectId as string | undefined, req.query.status as string | undefined), summary: await riskCounts() })
  } catch (err) { next(err) }
})

const CreateSchema = z.object({
  projectId: z.string().nullable().optional(),
  projectName: z.string(),
  type: z.string(),
  level: z.enum(['高', '中', '低']).default('中'),
  title: z.string(),
  description: z.string().optional(),
  source: z.string().default('人工录入'),
  status: z.string().default('待处置'),
  assignee: z.string().optional(),
})

risksRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = CreateSchema.parse(req.body)
    const row = await createRisk(body as never, req.user!.uid)
    res.status(201).json(row)
  } catch (err) { next(err) }
})

risksRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const row = await updateRisk(routeId(req.params.id), req.body, req.user!.uid)
    res.json(row)
  } catch (err) { next(err) }
})
