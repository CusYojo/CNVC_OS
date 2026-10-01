import { Router } from 'express'
import { z } from 'zod'
import { listDiscoveryPeople } from '../services/discoveryPeopleService.js'

export const discoveryPeopleRouter = Router()

discoveryPeopleRouter.get('/people', async (req, res, next) => {
  try {
    const query = z.object({
      kind: z.enum(['all', 'ranking', 'research', 'expert']).default('all'),
      q: z.string().trim().max(100).default(''),
      page: z.coerce.number().int().min(1).max(2000).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(20),
    }).parse(req.query)
    res.setHeader('Cache-Control', 'private, no-store')
    res.json(await listDiscoveryPeople({ kind: query.kind, query: query.q, page: query.page, pageSize: query.pageSize }))
  } catch (error) { next(error) }
})
