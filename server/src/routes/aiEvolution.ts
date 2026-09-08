import { Router } from 'express'
import { planAiEvolutionReevaluation, createAiEvolutionReevaluation } from '../services/aiEvolutionReevaluationService.js'
import { planAiEvolutionSkillPromotion, approveAiEvolutionSkillPromotion, promoteAiEvolutionSkillTrial } from '../services/aiEvolutionSkillTrialApplicationService.js'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { aiEvolutionService, assertAiEvolutionEnabled, getAiEvolutionCandidateForUser, getAiEvolutionArtifactForUser } from '../services/aiEvolutionApplicationService.js'
import { createAiEvolutionLocalPreview } from '../services/aiEvolutionLocalPreviewService.js'
import { listAiEvolutionReleaseTargets, approveAiEvolutionRelease, queueAiEvolutionRelease, getAiEvolutionReleaseJob } from '../services/aiEvolutionReleaseApplicationService.js'
import { getAiEvolutionPatchForUser } from '../services/aiEvolutionApplicationService.js'
import { decideAiEvolutionCandidate } from '../services/aiEvolutionApplicationService.js'
import { getLatestAiEvolutionCandidate } from '../services/aiEvolutionApplicationService.js'
import { getAiEvolutionProposalRuns } from '../services/aiEvolutionApplicationService.js'
import { savePersonalAiExperience, listPersonalAiExperiences, disablePersonalAiExperience } from '../services/aiEvolutionApplicationService.js'
import { getPersonalAiExperienceApplication } from '../services/aiEvolutionApplicationService.js'
import { getAiEvolutionSkillComparisonForUser } from '../services/aiEvolutionApplicationService.js'
import { registerAiEvolutionSkillVersionForUser, listAiEvolutionSkillPackagesForUser } from '../services/aiEvolutionApplicationService.js'
import { activateAiEvolutionSkillTrial, approveAiEvolutionSkillTrial, rollbackAiEvolutionSkillTrial, planAiEvolutionSkillTrial, getAiEvolutionSkillTrialStatus } from '../services/aiEvolutionSkillTrialApplicationService.js'
import { getAiEvolutionSkillRunComparisonForUser, getAiEvolutionSkillRunArtifactForUser } from '../services/aiEvolutionApplicationService.js'

export const aiEvolutionRouter = Router()
const uuid = z.string().uuid()
aiEvolutionRouter.use((_req, _res, next) => { try { assertAiEvolutionEnabled(); next() } catch (error) { next(error) } })
aiEvolutionRouter.post('/candidates/:id/reevaluation-plan', async (req: AuthedRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await planAiEvolutionReevaluation(req.user!.uid, uuid.parse(req.params.id), req.body)) } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/reevaluation', async (req: AuthedRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await createAiEvolutionReevaluation(req.user!.uid, uuid.parse(req.params.id), req.body, req.get('Idempotency-Key'))) } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/skill-promotion-plan', async (req: AuthedRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await planAiEvolutionSkillPromotion(req.user!.uid, uuid.parse(req.params.id), req.body)) } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/skill-promotion-approval', async (req: AuthedRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await approveAiEvolutionSkillPromotion(req.user!.uid, uuid.parse(req.params.id), req.body)) } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/skill-promotion', async (req: AuthedRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await promoteAiEvolutionSkillTrial(req.user!.uid, uuid.parse(req.params.id), req.body, req.get('Idempotency-Key'))) } catch (error) { next(error) }
})
const revisionInput = z.object({ expectedRevision: z.number().int().min(1) }).strict()

aiEvolutionRouter.get('/experiences', async (req: AuthedRequest, res, next) => {
  try { res.json(await listPersonalAiExperiences(req.user!.uid)) } catch (error) { next(error) }
})
aiEvolutionRouter.get('/applications', async (req: AuthedRequest, res, next) => {
  try {
    const { taskId } = z.object({ taskId: z.string().min(1).max(128) }).strict().parse(req.query)
    res.setHeader('Cache-Control', 'no-store')
    res.json(await getPersonalAiExperienceApplication(req.user!.uid, taskId))
  } catch (error) { next(error) }
})
aiEvolutionRouter.post('/proposals/:id/save-experience', async (req: AuthedRequest, res, next) => {
  try {
    const { expectedRevision } = revisionInput.parse(req.body)
    res.json(await savePersonalAiExperience(req.user!.uid, uuid.parse(req.params.id), expectedRevision))
  } catch (error) { next(error) }
})
aiEvolutionRouter.post('/experiences/:id/disable', async (req: AuthedRequest, res, next) => {
  try {
    const { expectedRevision } = revisionInput.parse(req.body)
    res.json(await disablePersonalAiExperience(req.user!.uid, uuid.parse(req.params.id), expectedRevision))
  } catch (error) { next(error) }
})

aiEvolutionRouter.get('/proposals', async (req: AuthedRequest, res, next) => {
  try { res.json(await aiEvolutionService.list(req.user!.uid, req.query)) } catch (error) { next(error) }
})
aiEvolutionRouter.get('/candidates/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await getAiEvolutionCandidateForUser(req.user!.uid, uuid.parse(req.params.id))) } catch (error) { next(error) }
})
aiEvolutionRouter.get('/candidates/:id/skill-comparison', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    res.json(await getAiEvolutionSkillComparisonForUser(req.user!.uid, uuid.parse(req.params.id)))
  } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/skill-versions', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await registerAiEvolutionSkillVersionForUser(req.user!.uid, uuid.parse(req.params.id), req.body))
  } catch (error) { next(error) }
})
aiEvolutionRouter.get('/candidates/:id/skill-packages', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await listAiEvolutionSkillPackagesForUser(req.user!.uid, uuid.parse(req.params.id)))
  } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/skill-trial', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await activateAiEvolutionSkillTrial(req.user!.uid, uuid.parse(req.params.id), req.body, req.get('Idempotency-Key')))
  } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/skill-trial-approval', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await approveAiEvolutionSkillTrial(req.user!.uid, uuid.parse(req.params.id), req.body))
  } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/skill-trial-rollback', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await rollbackAiEvolutionSkillTrial(req.user!.uid, uuid.parse(req.params.id), req.body, req.get('Idempotency-Key')))
  } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/skill-trial-plan', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await planAiEvolutionSkillTrial(req.user!.uid, uuid.parse(req.params.id), req.body))
  } catch (error) { next(error) }
})
aiEvolutionRouter.get('/candidates/:id/skill-trial', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await getAiEvolutionSkillTrialStatus(req.user!.uid, uuid.parse(req.params.id)))
  } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/preview', async (req: AuthedRequest, res, next) => {
  try {
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(req.hostname)) throw new Error('Local preview requires a local business origin')
    res.setHeader('Cache-Control', 'no-store')
    res.json(await createAiEvolutionLocalPreview(req.user!.uid, uuid.parse(req.params.id)))
  } catch (error) { next(error) }
})
aiEvolutionRouter.get('/candidates/:id/release-targets', async (req: AuthedRequest, res, next) => {
  try { res.json(await listAiEvolutionReleaseTargets(req.user!.uid, uuid.parse(req.params.id))) } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/release-approval', async (req: AuthedRequest, res, next) => {
  try { res.json(await approveAiEvolutionRelease(req.user!.uid, uuid.parse(req.params.id), req.body)) } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/release', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    res.status(202).json(await queueAiEvolutionRelease(req.user!.uid, uuid.parse(req.params.id), req.body, req.get('Idempotency-Key')))
  } catch (error) { next(error) }
})
aiEvolutionRouter.get('/candidates/:id/release', async (req: AuthedRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await getAiEvolutionReleaseJob(req.user!.uid, uuid.parse(req.params.id))) }
  catch (error) { next(error) }
})
aiEvolutionRouter.get('/candidates/:id/patch', async (req: AuthedRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await getAiEvolutionPatchForUser(req.user!.uid, uuid.parse(req.params.id))) } catch (error) { next(error) }
})
aiEvolutionRouter.post('/candidates/:id/decision', async (req: AuthedRequest, res, next) => {
  try { res.json(await decideAiEvolutionCandidate(req.user!.uid, uuid.parse(req.params.id), req.body)) } catch (error) { next(error) }
})
aiEvolutionRouter.get('/candidates/:id/artifacts/:index', async (req: AuthedRequest, res, next) => {
  try {
    const { filename, content } = await getAiEvolutionArtifactForUser(req.user!.uid, uuid.parse(req.params.id), z.coerce.number().int().min(0).parse(req.params.index))
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(content)
  } catch (error) { next(error) }
})
aiEvolutionRouter.post('/proposals', async (req: AuthedRequest, res, next) => {
  try { res.status(201).json(await aiEvolutionService.create(req.user!.uid, req.body, req.get('Idempotency-Key'))) } catch (error) { next(error) }
})
aiEvolutionRouter.get('/proposals/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await aiEvolutionService.get(req.user!.uid, uuid.parse(req.params.id))) } catch (error) { next(error) }
})
aiEvolutionRouter.get('/proposals/:id/candidate', async (req: AuthedRequest, res, next) => {
  try { res.json(await getLatestAiEvolutionCandidate(req.user!.uid, uuid.parse(req.params.id))) } catch (error) { next(error) }
})
aiEvolutionRouter.get('/proposals/:id/runs', async (req: AuthedRequest, res, next) => {
  try { res.json(await getAiEvolutionProposalRuns(req.user!.uid, uuid.parse(req.params.id))) } catch (error) { next(error) }
})
aiEvolutionRouter.patch('/proposals/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await aiEvolutionService.edit(req.user!.uid, uuid.parse(req.params.id), req.body)) } catch (error) { next(error) }
})
aiEvolutionRouter.post('/proposals/:id/execute', async (req: AuthedRequest, res, next) => {
  try {
    res.status(202).json(await aiEvolutionService.execute(req.user!.uid, uuid.parse(req.params.id), req.body, req.get('Idempotency-Key')))
  } catch (error) { next(error) }
})
aiEvolutionRouter.get('/runs/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await aiEvolutionService.run(req.user!.uid, uuid.parse(req.params.id))) } catch (error) { next(error) }
})
aiEvolutionRouter.get('/runs/:id/skill-comparison', async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    res.json(await getAiEvolutionSkillRunComparisonForUser(req.user!.uid, uuid.parse(req.params.id)))
  } catch (error) { next(error) }
})
aiEvolutionRouter.get('/runs/:id/skill-artifacts/:index', async (req: AuthedRequest, res, next) => {
  try {
    const { checkpointHash } = z.object({ checkpointHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.query)
    const { filename, content } = await getAiEvolutionSkillRunArtifactForUser(req.user!.uid, uuid.parse(req.params.id),
      z.coerce.number().int().min(0).parse(req.params.index), checkpointHash)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(content)
  } catch (error) { next(error) }
})
aiEvolutionRouter.get('/runs/:id/events', async (req: AuthedRequest, res, next) => {
  try {
    const query = z.object({ afterSequence: z.coerce.number().int().min(0).default(0) }).strict().parse(req.query)
    res.json(await aiEvolutionService.events(req.user!.uid, uuid.parse(req.params.id), query.afterSequence))
  } catch (error) { next(error) }
})
aiEvolutionRouter.post('/runs/:id/cancel', async (req: AuthedRequest, res, next) => {
  try { res.json(await aiEvolutionService.cancel(req.user!.uid, uuid.parse(req.params.id))) } catch (error) { next(error) }
})
aiEvolutionRouter.post('/runs/:id/resume', async (req: AuthedRequest, res, next) => {
  try {
    const { expectedAttempt } = z.object({ expectedAttempt: z.number().int().min(1) }).strict().parse(req.body)
    res.status(202).json(await aiEvolutionService.resume(req.user!.uid, uuid.parse(req.params.id), expectedAttempt))
  } catch (error) { next(error) }
})
