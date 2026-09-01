import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { actOnOfficeRequest, getOfficeAttachment, getOfficeRequest, getOfficeRevision, grantOfficeAttachment, listOfficeRequests, listReusableOfficeRequests, officeCommandReceipt, officeOptions, officeTransferCandidates, previewOfficeRequest, resolveOfficeCommand, saveOfficeRequest, uploadOfficeAttachment } from '../services/fdeOfficeService.js'
import { projectFilePreviewContentType } from '../services/projectFileStorageService.js'
import { writeAudit } from '../services/auditService.js'
import { readOfficeNotice } from '../services/fdeApprovalCenterService.js'
import { getOfficeExecutions, recordOfficeExecution } from '../services/fdeOfficeService.js'

export const officeRouter = Router()
const id = (value: unknown) => z.string().uuid().parse(value)
officeRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next() })
officeRouter.get('/options', async (req: AuthedRequest, res, next) => { try { res.json(await officeOptions(req.user!.uid)) } catch (e) { next(e) } })
officeRouter.post('/notices/:id/read', async (req: AuthedRequest, res, next) => { try { z.object({}).strict().parse(req.body); res.json(await readOfficeNotice(id(req.params.id), req.user!.uid)) } catch (e) { next(e) } })
officeRouter.get('/requests', async (req: AuthedRequest, res, next) => { try { res.json(await listOfficeRequests(req.user!.uid, req.query)) } catch (e) { next(e) } })
officeRouter.get('/history', async (req: AuthedRequest, res, next) => { try { res.json(await listReusableOfficeRequests(req.user!.uid, req.query.kind)) } catch (e) { next(e) } })
officeRouter.get('/requests/:id', async (req: AuthedRequest, res, next) => { try { res.json(await getOfficeRequest(id(req.params.id), req.user!.uid, z.coerce.number().int().min(1).default(1).parse(req.query.page))) } catch (e) { next(e) } })
officeRouter.get('/requests/:id/executions', async (req: AuthedRequest, res, next) => { try { res.json(await getOfficeExecutions(id(req.params.id), req.user!.uid, z.coerce.number().int().min(1).max(100000).default(1).parse(req.query.page))) } catch (e) { next(e) } })
officeRouter.post('/requests/:id/executions', async (req: AuthedRequest, res, next) => { try { res.json(await recordOfficeExecution(id(req.params.id), req.user!.uid, req.body)) } catch (e) { next(e) } })
officeRouter.get('/requests/:id/preview', async (req: AuthedRequest, res, next) => { try { res.json(await previewOfficeRequest(id(req.params.id), req.user!.uid)) } catch (e) { next(e) } })
officeRouter.get('/requests/:id/transfer-candidates', async (req: AuthedRequest, res, next) => { try { res.json(await officeTransferCandidates(id(req.params.id), req.user!.uid)) } catch (e) { next(e) } })
officeRouter.get('/requests/:id/revisions/:revision', async (req: AuthedRequest, res, next) => { try { res.json(await getOfficeRevision(id(req.params.id), z.coerce.number().int().positive().parse(req.params.revision), req.user!.uid)) } catch (e) { next(e) } })
officeRouter.get('/requests/:id/commands/:commandId', async (req: AuthedRequest, res, next) => { try { res.json(await officeCommandReceipt(id(req.params.id), id(req.params.commandId), req.user!.uid)) } catch (e) { next(e) } })
officeRouter.post('/requests/:id/commands/resolve', async (req: AuthedRequest, res, next) => { try { res.json(await resolveOfficeCommand(id(req.params.id), req.user!.uid, req.body)) } catch (e) { next(e) } })
officeRouter.post('/requests/:id/save', async (req: AuthedRequest, res, next) => { try { res.json(await saveOfficeRequest(id(req.params.id), req.user!.uid, req.body)) } catch (e) { next(e) } })
officeRouter.post('/requests/:id/actions', async (req: AuthedRequest, res, next) => { try { res.json(await actOnOfficeRequest(id(req.params.id), req.user!.uid, req.body)) } catch (e) { next(e) } })
officeRouter.post('/requests/:id/attachments/:fileId', async (req: AuthedRequest, res, next) => { try { res.json(await uploadOfficeAttachment(id(req.params.id), id(req.params.fileId), req.user!.uid, req.body)) } catch (e) { next(e) } })
officeRouter.post('/requests/:id/attachments/:fileId/grants', async (req: AuthedRequest, res, next) => { try { res.json(await grantOfficeAttachment(id(req.params.id), id(req.params.fileId), req.user!.uid, req.body)) } catch (e) { next(e) } })
for (const operation of ['preview', 'download'] as const) officeRouter.get(`/requests/:id/attachments/:fileId/${operation}`, async (req: AuthedRequest, res, next) => {
  try {
    const result = await getOfficeAttachment(id(req.params.id), id(req.params.fileId), req.user!.uid, operation === 'download')
    const contentType = operation === 'preview' ? projectFilePreviewContentType(result.name) : 'application/octet-stream'
    if (!contentType) { res.status(415).json({ code: 'FILE_PREVIEW_UNSUPPORTED', message: '该格式不支持在线预览，有下载权时可下载查看' }); return }
    await writeAudit({ userId: req.user!.uid, userName: req.user!.name, module: '通用OA', action: operation === 'preview' ? '预览原件' : '下载原件', target: `${id(req.params.id)} / ${id(req.params.fileId)}`, ip: req.ip })
    res.setHeader('Content-Type', contentType); res.setHeader('Content-Disposition', `${operation === 'preview' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(result.name)}`)
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:")
    res.setHeader('X-Content-SHA256', result.sha256); res.send(result.bytes)
  } catch (e) { next(e) }
})
