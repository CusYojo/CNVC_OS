import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { createRisk, getRisk, listRisks, presentRisk, presentRisks, riskCounts, updateRisk } from '../services/riskService.js'
import { requireAccessibleProject } from '../services/projectAccessService.js'
import { parseShanghaiDate } from '../utils/shanghaiTime.js'

export const risksRouter = Router()
const routeId = (value: string | string[]) => z.string().min(1).parse(value)

risksRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = req.query.projectId as string | undefined
    if (projectId) await requireAccessibleProject(req.user!.uid, projectId)
    const requestedStatus = z.enum(['待确认', '处理中', '已关闭', '误报']).optional().parse(req.query.status)
    res.json({
      list: presentRisks(await listRisks(projectId, requestedStatus ? riskStatus(requestedStatus) : undefined, req.user!)),
      summary: await riskCounts(req.user!),
    })
  } catch (err) { next(err) }
})

const RiskFieldsSchema = z.object({
  projectId: z.string().nullable().optional(),
  projectName: z.string(),
  type: z.string(),
  level: z.enum(['高', '中', '低']),
  description: z.string().trim().min(1),
  status: z.enum(['待确认', '处理中', '已关闭', '误报']),
  owner: z.string().trim().min(1),
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export const RiskCreateSchema = RiskFieldsSchema.extend({
  level: z.enum(['高', '中', '低']).default('中'),
  status: z.enum(['待确认', '处理中', '已关闭', '误报']).default('待确认'),
})

// PATCH must not inject create-time defaults into fields omitted by the caller.
export const RiskPatchSchema = RiskFieldsSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
}).strict()

function riskStatus(status: '待确认' | '处理中' | '已关闭' | '误报') {
  return { 待确认: '待处置', 处理中: '处置中', 已关闭: '已解除', 误报: '已忽略' }[status]
}

function riskDate(value: string) {
  try { return parseShanghaiDate(value) }
  catch { throw Object.assign(new Error('风险发生日期无效'), { status: 400, code: 'INVALID_RISK_DATE' }) }
}

risksRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = RiskCreateSchema.parse(req.body)
    if (body.projectId) await requireAccessibleProject(req.user!.uid, body.projectId)
    const row = await createRisk({
      projectId: body.projectId,
      projectName: body.projectName,
      type: body.type,
      level: body.level,
      title: body.description.slice(0, 255),
      description: body.description,
      source: '人工录入',
      status: riskStatus(body.status),
      assignee: body.owner,
      detectedAt: riskDate(body.occurredAt),
    }, req.user!.uid, req.user!.name)
    res.status(201).json(presentRisk(row))
  } catch (err) { next(err) }
})

risksRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const riskId = routeId(req.params.id)
    const existing = await getRisk(riskId, req.user!)
    if (!existing) { res.status(404).json({ code: 'NOT_FOUND', message: '风险不存在', details: null }); return }
    const { expectedVersion, ...body } = RiskPatchSchema.parse(req.body)
    if (typeof body.projectId === 'string') {
      await requireAccessibleProject(req.user!.uid, body.projectId)
    }
    const patch = {
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      ...(body.projectName !== undefined ? { projectName: body.projectName } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.level !== undefined ? { level: body.level } : {}),
      ...(body.description !== undefined ? { title: body.description.slice(0, 255), description: body.description } : {}),
      ...(body.status !== undefined ? { status: riskStatus(body.status) } : {}),
      ...(body.owner !== undefined ? { assignee: body.owner } : {}),
      ...(body.occurredAt !== undefined ? { detectedAt: riskDate(body.occurredAt) } : {}),
    }
    const row = await updateRisk(existing.id, patch, req.user!.uid, req.user!.name, expectedVersion)
    res.json(presentRisk(row))
  } catch (err) { next(err) }
})
