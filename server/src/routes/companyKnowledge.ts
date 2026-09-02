import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { actOnCompanyKnowledge, commentCompanyKnowledge, companyKnowledgeOptions, companyKnowledgeOriginal, companyKnowledgeSummary, getCompanyKnowledge, listCompanyKnowledge, rateCompanyKnowledge, saveCompanyKnowledge, withdrawCompanyKnowledgeComment } from '../services/fdeKnowledgeService.js'
import { projectFilePreviewContentType } from '../services/projectFileStorageService.js'
import { canonicalizeProjectTextBuffer } from '../security/projectFileValidation.js'
import { writeAudit } from '../services/auditService.js'
import { resolveKnowledgeCommand } from '../services/fdeKnowledgeCommandService.js'

export const companyKnowledgeRouter = Router()
const id = (value: unknown) => z.string().uuid().parse(value)
companyKnowledgeRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next() })
companyKnowledgeRouter.post('/commands/resolve', async (req: AuthedRequest, res, next) => { try { res.json(await resolveKnowledgeCommand(req.user!.uid, req.body)) } catch (error) { next(error) } })
companyKnowledgeRouter.get('/', async (req: AuthedRequest, res, next) => { try { res.json(await listCompanyKnowledge(req.user!.uid, req.query)) } catch (error) { next(error) } })
companyKnowledgeRouter.get('/options', async (req: AuthedRequest, res, next) => { try { res.json(await companyKnowledgeOptions(req.user!.uid)) } catch (error) { next(error) } })
companyKnowledgeRouter.get('/:id', async (req: AuthedRequest, res, next) => { try { res.json(await getCompanyKnowledge(id(req.params.id), req.user!.uid, req.query)) } catch (error) { next(error) } })
companyKnowledgeRouter.post('/:id/save', async (req: AuthedRequest, res, next) => { try { res.json(await saveCompanyKnowledge(id(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) } })
companyKnowledgeRouter.post('/:id/actions', async (req: AuthedRequest, res, next) => { try { res.json(await actOnCompanyKnowledge(id(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) } })
companyKnowledgeRouter.post('/:id/comments', async (req: AuthedRequest, res, next) => { try { res.json(await commentCompanyKnowledge(id(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) } })
companyKnowledgeRouter.post('/:id/comments/:commentId/withdraw', async (req: AuthedRequest, res, next) => { try { res.json(await withdrawCompanyKnowledgeComment(id(req.params.id), id(req.params.commentId), req.user!.uid, req.body)) } catch (error) { next(error) } })
companyKnowledgeRouter.post('/:id/rating', async (req: AuthedRequest, res, next) => { try { res.json(await rateCompanyKnowledge(id(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) } })
companyKnowledgeRouter.get('/:id/summary', async (req: AuthedRequest, res, next) => {
  try {
    const result = await companyKnowledgeSummary(id(req.params.id), req.user!.uid)
    await writeAudit({ userId: req.user!.uid, userName: req.user!.name, module: '公司知识', action: '下载摘要', target: id(req.params.id), ip: req.ip })
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`)
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.type('text/plain').send(result.text)
  } catch (error) { next(error) }
})
for (const operation of ['preview', 'download'] as const) companyKnowledgeRouter.get(`/:id/${operation}`, async (req: AuthedRequest, res, next) => {
  try {
    const result = await companyKnowledgeOriginal(id(req.params.id), req.user!.uid, operation === 'download')
    const contentType = operation === 'preview' ? projectFilePreviewContentType(result.name) : 'application/octet-stream'
    if (!contentType) { res.status(415).json({ code: 'FILE_PREVIEW_UNSUPPORTED', message: '该格式不支持在线预览；有下载权时可下载查看' }); return }
    await writeAudit({ userId: req.user!.uid, userName: req.user!.name, module: '公司知识', action: operation === 'preview' ? '预览原始附件' : '下载原始附件', target: `${id(req.params.id)} / v${result.version}`, ip: req.ip })
    res.setHeader('Content-Type', contentType); res.setHeader('Content-Disposition', `${operation === 'preview' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(result.name)}`)
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:")
    res.setHeader('X-File-Version', String(result.version)); res.setHeader('X-Content-SHA256', result.sha256); res.send(operation === 'preview' ? canonicalizeProjectTextBuffer(result.name, result.bytes) : result.bytes)
  } catch (error) { next(error) }
})
