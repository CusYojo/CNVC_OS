import { Router } from 'express'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { executeResponsibilityPolicyCommand, getCurrentResponsibilityPolicy, getResponsibilityPolicyVersion, listResponsibilityPolicies, recoverResponsibilityPolicyCommand } from '../services/fdeResponsibilityPolicyService.js'

export const responsibilityPoliciesRouter = Router()
responsibilityPoliciesRouter.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff'); next() })
responsibilityPoliciesRouter.get('/', async (req: AuthedRequest, res, next) => {
  try { res.json(await listResponsibilityPolicies(req.user!.uid, req.query)) } catch (error) { next(error) }
})
responsibilityPoliciesRouter.get('/versions/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await getResponsibilityPolicyVersion(req.user!.uid, String(req.params.id))) } catch (error) { next(error) }
})
responsibilityPoliciesRouter.get('/current', async (req: AuthedRequest, res, next) => {
  try { res.json(await getCurrentResponsibilityPolicy(req.user!.uid)) } catch (error) { next(error) }
})
responsibilityPoliciesRouter.post('/commands', async (req: AuthedRequest, res, next) => {
  try { res.json(await executeResponsibilityPolicyCommand(req.user!.uid, req.body)) } catch (error) { next(error) }
})
responsibilityPoliciesRouter.post('/commands/recover', async (req: AuthedRequest, res, next) => {
  try { res.json(await recoverResponsibilityPolicyCommand(req.user!.uid, req.body)) } catch (error) { next(error) }
})
