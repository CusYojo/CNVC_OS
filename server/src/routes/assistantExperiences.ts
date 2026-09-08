import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import {
  decideAssistantExperienceCandidate, deleteAssistantExperience, getAssistantExperienceSettings,
  listAssistantExperienceCandidates, listAssistantExperiences, updateAssistantExperience,
  updateAssistantExperienceSettings,
} from '../services/assistantExperienceService.js'

export const assistantExperiencesRouter = Router()
const uuid = z.string().uuid()

assistantExperiencesRouter.get('/settings', async (req: AuthedRequest, res, next) => {
  try { res.json(await getAssistantExperienceSettings(req.user!.uid)) } catch (error) { next(error) }
})
assistantExperiencesRouter.patch('/settings', async (req: AuthedRequest, res, next) => {
  try { res.json(await updateAssistantExperienceSettings(req.user!.uid, z.object({ autoSummaryEnabled: z.boolean(), revision: z.number().int().positive() }).parse(req.body))) } catch (error) { next(error) }
})
assistantExperiencesRouter.get('/candidates', async (req: AuthedRequest, res, next) => {
  try { res.json(await listAssistantExperienceCandidates(req.user!.uid, z.object({ conversationId: uuid.optional(), status: z.enum(['pending', 'adopted', 'rejected']).optional() }).parse(req.query))) } catch (error) { next(error) }
})
assistantExperiencesRouter.post('/candidates/:id/decision', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ action: z.enum(['adopt', 'reject']), version: z.number().int().positive(), idempotencyKey: uuid, editedRule: z.string().trim().min(3).max(2000).optional(), scopeType: z.enum(['global', 'project']).optional() }).parse(req.body)
    res.json(await decideAssistantExperienceCandidate(req.user!.uid, uuid.parse(req.params.id), body))
  } catch (error) { next(error) }
})
assistantExperiencesRouter.get('/', async (req: AuthedRequest, res, next) => {
  try { res.json(await listAssistantExperiences(req.user!.uid, z.string().uuid().optional().parse(req.query.projectId))) } catch (error) { next(error) }
})
assistantExperiencesRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await updateAssistantExperience(req.user!.uid, uuid.parse(req.params.id), z.object({ version: z.number().int().positive(), rule: z.string().trim().min(3).max(2000).optional(), status: z.enum(['active', 'disabled']).optional() }).parse(req.body))) } catch (error) { next(error) }
})
assistantExperiencesRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await deleteAssistantExperience(req.user!.uid, uuid.parse(req.params.id), z.object({ version: z.number().int().positive() }).parse(req.body).version)) } catch (error) { next(error) }
})
