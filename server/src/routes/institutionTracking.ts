import { Router } from 'express'
import { z } from 'zod'
import { getInstitutionTrackingProfile, listInstitutionTrackingProfiles } from '../services/institutionTrackingService.js'

export const institutionTrackingRouter = Router()

institutionTrackingRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ list: await listInstitutionTrackingProfiles() })
  } catch (error) { next(error) }
})

institutionTrackingRouter.get('/:key', async (req, res, next) => {
  try {
    const key = z.string().regex(/^[a-f0-9]{2,2040}$/u).parse(req.params.key)
    const profile = await getInstitutionTrackingProfile(key)
    if (!profile) { res.status(404).json({ code: 'INSTITUTION_NOT_FOUND', message: '机构不存在或尚无关联项目' }); return }
    res.json(profile)
  } catch (error) { next(error) }
})
