import { Router } from 'express'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { checkCommitteeEditorAccess, committeeHistory, committeeOptions, executeCommittee, getCommittee, listCommittee, previewCommitteeFile, readCommitteeNotice, recoverCommittee } from '../services/fdeCommitteeService.js'
import { projectFilePreviewContentType } from '../services/projectFileStorageService.js'
import { canonicalizeProjectTextBuffer } from '../security/projectFileValidation.js'

export const committeeRouter = Router()
committeeRouter.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff'); next() })
committeeRouter.get('/', async (req: AuthedRequest, res, next) => { try { res.json(await listCommittee(req.user!.uid, req.query)) } catch (error) { next(error) } })
committeeRouter.get('/options', async (req: AuthedRequest, res, next) => { try { res.json(await committeeOptions(req.user!.uid, req.query)) } catch (error) { next(error) } })
committeeRouter.post('/editor-access', async (req: AuthedRequest, res, next) => { try { res.json(await checkCommitteeEditorAccess(req.user!.uid, req.body)) } catch (error) { next(error) } })
committeeRouter.post('/commands', async (req: AuthedRequest, res, next) => { try { res.json(await executeCommittee(req.user!.uid, req.body)) } catch (error) { next(error) } })
committeeRouter.post('/commands/recover', async (req: AuthedRequest, res, next) => { try { res.json(await recoverCommittee(req.user!.uid, req.body)) } catch (error) { next(error) } })
committeeRouter.get('/:id', async (req: AuthedRequest, res, next) => { try { res.json(await getCommittee(req.user!.uid, String(req.params.id))) } catch (error) { next(error) } })
committeeRouter.get('/:id/history', async (req: AuthedRequest, res, next) => { try { res.json(await committeeHistory(req.user!.uid, String(req.params.id), req.query)) } catch (error) { next(error) } })
committeeRouter.get('/:id/agendas/:agendaId/files/:fileId/:version/preview', async (req: AuthedRequest, res, next) => {
  try {
    const file = await previewCommitteeFile(req.user!.uid, { meetingId: req.params.id, agendaId: req.params.agendaId, fileId: req.params.fileId, version: req.params.version })
    const contentType = projectFilePreviewContentType(file.name)
    if (!contentType) { res.status(415).json({ code: 'FILE_PREVIEW_UNSUPPORTED', message: '该格式需在项目文件工作区按下载权限使用本地软件查看' }); return }
    const bytes = canonicalizeProjectTextBuffer(file.name, file.bytes)
    res.set({ 'Content-Type': contentType, 'Content-Length': String(bytes.length), 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'X-Content-SHA256': file.sha256, 'X-File-Version': String(file.version), 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:" })
    res.send(bytes)
  } catch (error) { next(error) }
})
committeeRouter.post('/:id/notices/:noticeId/read', async (req: AuthedRequest, res, next) => { try { res.json(await readCommitteeNotice(req.user!.uid, String(req.params.id), String(req.params.noticeId))) } catch (error) { next(error) } })
