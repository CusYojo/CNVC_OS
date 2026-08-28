import { Router } from 'express'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { executeTypePolicy, getTypePolicy, listTypePolicies, previewTypePolicy, recoverTypePolicy, typeRegistrationRoleOptions } from '../services/fdeTypePolicyService.js'

export const fdeTypePoliciesRouter = Router()
fdeTypePoliciesRouter.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff'); next() })
fdeTypePoliciesRouter.get('/', async (req: AuthedRequest, res, next) => { try { res.json(await listTypePolicies(req.user!.uid, req.query)) } catch (e) { next(e) } })
fdeTypePoliciesRouter.get('/registration-roles', async (req: AuthedRequest, res, next) => { try { res.json(await typeRegistrationRoleOptions(req.user!.uid)) } catch (e) { next(e) } })
fdeTypePoliciesRouter.post('/preview', async (req: AuthedRequest, res, next) => { try { res.json(await previewTypePolicy(req.user!.uid, req.body)) } catch (e) { next(e) } })
fdeTypePoliciesRouter.post('/commands', async (req: AuthedRequest, res, next) => { try { res.json(await executeTypePolicy(req.user!.uid, req.body)) } catch (e) { next(e) } })
fdeTypePoliciesRouter.post('/commands/recover', async (req: AuthedRequest, res, next) => { try { res.json(await recoverTypePolicy(req.user!.uid, req.body)) } catch (e) { next(e) } })
fdeTypePoliciesRouter.get('/:id', async (req: AuthedRequest, res, next) => { try { res.json(await getTypePolicy(req.user!.uid, String(req.params.id), req.query)) } catch (e) { next(e) } })
