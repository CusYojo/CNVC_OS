import { Router } from 'express'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { listTypeRegistrationOptions, recoverTypeRegistration, registerTypeProject } from '../services/fdeTypeRegistrationService.js'
export const fdeTypeRegistrationRouter = Router()
fdeTypeRegistrationRouter.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
fdeTypeRegistrationRouter.get('/options', async (req: AuthedRequest, res, next) => { try { res.json(await listTypeRegistrationOptions(req.user!.uid)) } catch (error) { next(error) } })
fdeTypeRegistrationRouter.post('/commands', async (req: AuthedRequest, res, next) => { try { res.json(await registerTypeProject(req.user!.uid, req.body)) } catch (error) { next(error) } })
fdeTypeRegistrationRouter.post('/commands/recover', async (req: AuthedRequest, res, next) => { try { res.json(await recoverTypeRegistration(req.user!.uid, req.body)) } catch (error) { next(error) } })
