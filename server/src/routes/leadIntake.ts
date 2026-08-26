import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import {
  buildLeadImportTemplate,
  commitLeadImportBatch,
  getLeadBpUpload,
  getLeadImportBatch,
  previewLeadImport,
  retryLeadBpUpload,
  uploadLeadBp,
} from '../services/leadIntakeService.js'
import { scheduleLeadScoring } from './meta.js'
import { writeAudit } from '../services/auditService.js'

export const leadIntakeRouter = Router()

const UploadSchema = z.object({
  name: z.string().min(1).max(255),
  declaredType: z.string().max(255).optional(),
  dataBase64: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128).optional(),
})

const routeId = (value: string | string[]) => z.string().uuid().parse(value)
const actor = (req: AuthedRequest) => ({ userId: req.user!.uid, userName: req.user!.name })

leadIntakeRouter.get('/leads/import-template', async (req: AuthedRequest, res, next) => {
  try {
    const buffer = await buildLeadImportTemplate()
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: '项目获取池',
      action: '下载公共线索批量导入模板', target: 'lead-import-v1', ip: req.ip,
    })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('公共线索池批量导入模板.xlsx')}`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.send(buffer)
  } catch (error) { next(error) }
})

leadIntakeRouter.post('/leads/imports/preview', async (req: AuthedRequest, res, next) => {
  try {
    const result = await previewLeadImport(UploadSchema.parse(req.body), actor(req))
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: '项目获取池',
      action: '预检公共线索批量导入', target: `${result.id};rows:${result.totalRows};errors:${result.errorRows}`, ip: req.ip,
    })
    res.status(201).json(result)
  } catch (error) { next(error) }
})

leadIntakeRouter.get('/leads/imports/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await getLeadImportBatch(routeId(req.params.id), actor(req))) } catch (error) { next(error) }
})

leadIntakeRouter.post('/leads/imports/:id/commit', async (req: AuthedRequest, res, next) => {
  try {
    const result = await commitLeadImportBatch(routeId(req.params.id), actor(req), scheduleLeadScoring)
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: '项目获取池',
      action: '确认公共线索批量导入',
      target: `${result.id};committed:${result.committedRows};excluded:${result.excludedRows};review:${result.reviewRows};failed:${result.failedRows}`, ip: req.ip,
    })
    res.json(result)
  } catch (error) { next(error) }
})

leadIntakeRouter.post('/leads/bp-uploads', async (req: AuthedRequest, res, next) => {
  try {
    const result = await uploadLeadBp(UploadSchema.parse(req.body), actor(req))
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: '项目获取池',
      action: '上传 BP 进入公共线索池解析队列', target: `${result.id};${result.name}`, ip: req.ip,
    })
    res.status(202).json(result)
  } catch (error) { next(error) }
})

leadIntakeRouter.get('/leads/bp-uploads/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await getLeadBpUpload(routeId(req.params.id), actor(req))) } catch (error) { next(error) }
})

leadIntakeRouter.post('/leads/bp-uploads/:id/retry', async (req: AuthedRequest, res, next) => {
  try { res.json(await retryLeadBpUpload(routeId(req.params.id), actor(req))) } catch (error) { next(error) }
})
