import { Router } from 'express'
import { z } from 'zod'
import { PROMPT_LIBRARY_CATEGORIES, type PromptLibraryCategory } from '../contracts/promptLibraryCategories.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { PROMPT_LIBRARY_KINDS, safePromptDownloadFileName, type PromptLibraryActor, type createPromptLibraryService } from '../services/promptLibraryService.js'

type PromptLibraryService = ReturnType<typeof createPromptLibraryService>
const itemId = z.union([z.string().uuid(), z.string().regex(/^builtin:[a-z0-9-]{1,128}$/)])
const expectedVersion = z.number().int().positive()

function actor(req: AuthedRequest): PromptLibraryActor {
  return { userId: req.user!.uid, userName: req.user!.name, role: req.user!.role, ip: req.ip }
}

function limitBody(req: AuthedRequest) {
  if (Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8') > 256 * 1024) {
    throw Object.assign(new Error('提示词请求不能超过 256KB'), { status: 413, code: 'PROMPT_TOO_LARGE' })
  }
}

export function createPromptLibraryRouter(service: PromptLibraryService) {
  const router = Router()
  router.use((req: AuthedRequest, res, next) => {
    if (!req.user) {
      res.status(401).json({ code: 'AUTH_REQUIRED', message: '请先登录', details: null })
      return
    }
    next()
  })

  router.get('/', async (req: AuthedRequest, res, next) => {
    try {
      const query = z.object({
        kind: z.enum(PROMPT_LIBRARY_KINDS),
        category: z.enum(PROMPT_LIBRARY_CATEGORIES.map(item => item.id) as [PromptLibraryCategory, ...PromptLibraryCategory[]]).optional(),
      }).strict().parse(req.query)
      res.json({ list: await service.list(actor(req), query.kind, query.category) })
    } catch (error) { next(error) }
  })

  router.post('/', async (req: AuthedRequest, res, next) => {
    try {
      limitBody(req)
      res.status(201).json(await service.create(actor(req), req.body))
    } catch (error) { next(error) }
  })

  router.get('/:id/download', async (req: AuthedRequest, res, next) => {
    try {
      const item = await service.download(actor(req), itemId.parse(req.params.id))
      const safeName = safePromptDownloadFileName(item.fileName || item.name, item.kind)
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${item.kind}.md"; filename*=UTF-8''${encodeURIComponent(safeName)}`)
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.send(item.markdown)
    } catch (error) { next(error) }
  })

  router.get('/:id', async (req: AuthedRequest, res, next) => {
    try { res.json(await service.get(actor(req), itemId.parse(req.params.id))) } catch (error) { next(error) }
  })

  router.patch('/:id', async (req: AuthedRequest, res, next) => {
    try {
      limitBody(req)
      const body = z.object({ expectedVersion }).passthrough().parse(req.body)
      res.json(await service.update(actor(req), itemId.parse(req.params.id), body))
    } catch (error) { next(error) }
  })

  router.delete('/:id', async (req: AuthedRequest, res, next) => {
    try {
      const body = z.object({ expectedVersion }).strict().parse(req.body)
      await service.remove(actor(req), itemId.parse(req.params.id), body.expectedVersion)
      res.json({ deleted: true })
    } catch (error) { next(error) }
  })

  return router
}
