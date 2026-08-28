import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { exportProjectArchives, getArchiveFile, listArchiveAudit, listProjectArchives } from '../services/fdeArchiveService.js'

export const projectArchivesRouter = Router()
projectArchivesRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next() })
projectArchivesRouter.get('/', async (req: AuthedRequest, res, next) => { try { res.json(await listProjectArchives(req.user!.uid, req.query)) } catch (error) { next(error) } })
projectArchivesRouter.get('/audit', async (req: AuthedRequest, res, next) => { try { res.json(await listArchiveAudit(req.user!.uid, req.query)) } catch (error) { next(error) } })
projectArchivesRouter.post('/export', async (req: AuthedRequest, res, next) => {
  try {
    const result = await exportProjectArchives(req.user!.uid, req.body)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('项目档案可下载清单.csv')}`)
    res.setHeader('X-Archive-File-Count', String(result.count)); res.type('text/csv').send(result.csv)
  } catch (error) { next(error) }
})
projectArchivesRouter.get('/:id', async (req: AuthedRequest, res, next) => { try { res.json(await getArchiveFile(z.string().uuid().parse(req.params.id), req.user!.uid, req.query)) } catch (error) { next(error) } })
