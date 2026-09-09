import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireImAdmin } from '../middleware/requireAuth.js'
import { requireImIntegrationsEnabled } from '../config/extensionFeatureFlags.js'
import { sendJwAgentMessage } from '../runtime/jwAgentRuntime.js'
import {
  createImBinding,
  createImBot,
  deleteImBinding,
  enqueueImMessage,
  IM_CONFIGURATION_REVISION_TYPES,
  IM_PLATFORMS,
  listImSettings,
  listImConfigurationRevisions,
  rollbackImConfigurationRevision,
  routeImInboundMessage,
  testImBotConnection,
  updateImBinding,
  updateImBot,
  type ImActor,
} from '../services/imIntegrationService.js'
import {
  startPersonalWeixinQrLogin,
  startWeixinQrLogin,
  waitForPersonalWeixinQrLogin,
  waitForWeixinQrLogin,
} from '../services/weixinQrLoginService.js'
import { disconnectPersonalWeixinAi, getPersonalWeixinAi } from '../services/personalWeixinAiService.js'

export const imIntegrationsRouter = Router()
export const imInboundRouter = Router()

const uuid = z.string().uuid()
const credentialSchema = z.record(z.string().min(1).max(64), z.string().min(1).max(8_000))
const configSchema = z.record(z.string().min(1).max(64), z.unknown()).default({})

imIntegrationsRouter.use(requireImIntegrationsEnabled)
imInboundRouter.use(requireImIntegrationsEnabled)

function actor(req: AuthedRequest): ImActor {
  return {
    userId: req.user!.uid,
    userName: req.user!.name,
    role: req.user!.role,
    department: req.user!.department,
    ip: req.ip,
  }
}

imIntegrationsRouter.get('/', requireImAdmin, async (req: AuthedRequest, res, next) => {
  try { res.json(await listImSettings(actor(req))) } catch (error) { next(error) }
})

imIntegrationsRouter.post('/weixin/login/start', requireImAdmin, async (_req: AuthedRequest, res, next) => {
  try { res.json(await startWeixinQrLogin()) } catch (error) { next(error) }
})

imIntegrationsRouter.post('/weixin/login/wait', requireImAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ sessionKey: uuid }).strict().parse(req.body ?? {})
    res.json(await waitForWeixinQrLogin(body.sessionKey, actor(req)))
  } catch (error) { next(error) }
})

imIntegrationsRouter.get('/weixin/self', async (req: AuthedRequest, res, next) => {
  try { res.json(await getPersonalWeixinAi(actor(req))) } catch (error) { next(error) }
})

imIntegrationsRouter.post('/weixin/self/login/start', async (req: AuthedRequest, res, next) => {
  try {
    const current = await getPersonalWeixinAi(actor(req))
    if (!current.eligible) {
      throw Object.assign(new Error(current.reason || '当前账号不可连接微信 AI'), {
        code: 'PERSONAL_WEIXIN_FORBIDDEN', status: 403,
      })
    }
    res.json(await startPersonalWeixinQrLogin(req.user!.uid))
  } catch (error) { next(error) }
})

imIntegrationsRouter.post('/weixin/self/login/wait', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ sessionKey: uuid }).strict().parse(req.body ?? {})
    res.json(await waitForPersonalWeixinQrLogin(body.sessionKey, actor(req)))
  } catch (error) { next(error) }
})

imIntegrationsRouter.post('/weixin/self/disconnect', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      expectedVersion: z.number().int().positive(),
      idempotencyKey: uuid,
    }).strict().parse(req.body ?? {})
    res.json(await disconnectPersonalWeixinAi(actor(req), body.expectedVersion))
  } catch (error) { next(error) }
})

imIntegrationsRouter.get('/history/:resourceType/:resourceId', requireImAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const resourceType = z.enum(IM_CONFIGURATION_REVISION_TYPES).parse(req.params.resourceType)
    res.json(await listImConfigurationRevisions(resourceType, uuid.parse(req.params.resourceId), actor(req)))
  } catch (error) { next(error) }
})

imIntegrationsRouter.post('/history/:resourceType/:resourceId/:revisionId/rollback', requireImAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const resourceType = z.enum(IM_CONFIGURATION_REVISION_TYPES).parse(req.params.resourceType)
    const body = z.object({
      expectedVersion: z.number().int().nonnegative(),
      confirmImpact: z.boolean().optional(),
    }).strict().parse(req.body ?? {})
    res.json(await rollbackImConfigurationRevision({
      resourceType, resourceId: uuid.parse(req.params.resourceId),
      revisionId: uuid.parse(req.params.revisionId), expectedVersion: body.expectedVersion,
      confirmImpact: body.confirmImpact,
    }, actor(req)))
  } catch (error) { next(error) }
})

imIntegrationsRouter.post('/bots', requireImAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      platform: z.enum(IM_PLATFORMS),
      name: z.string().trim().min(1).max(128),
      credentials: credentialSchema,
      config: configSchema.optional(),
      enabled: z.boolean().optional(),
    }).strict().parse(req.body ?? {})
    res.status(201).json(await createImBot(body, actor(req)))
  } catch (error) { next(error) }
})

imIntegrationsRouter.patch('/bots/:botId', requireImAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      expectedVersion: z.number().int().positive(),
      name: z.string().trim().min(1).max(128).optional(),
      credentials: credentialSchema.optional(),
      config: configSchema.optional(),
      enabled: z.boolean().optional(),
      confirmDisableImpact: z.boolean().optional(),
    }).strict().parse(req.body ?? {})
    res.json(await updateImBot(uuid.parse(req.params.botId), body, actor(req)))
  } catch (error) { next(error) }
})

imIntegrationsRouter.post('/bots/:botId/test', requireImAdmin, async (req: AuthedRequest, res, next) => {
  try { res.json(await testImBotConnection(uuid.parse(req.params.botId), actor(req))) } catch (error) { next(error) }
})

imIntegrationsRouter.post('/bindings', requireImAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      botId: uuid,
      externalConversationId: z.string().trim().min(1).max(191),
      userId: uuid,
      projectId: uuid.nullish(),
      conversationId: uuid.nullish(),
      department: z.string().trim().min(1).max(64).nullish(),
      enabled: z.boolean().optional(),
    }).strict().parse(req.body ?? {})
    res.status(201).json(await createImBinding(body, actor(req)))
  } catch (error) { next(error) }
})

imIntegrationsRouter.patch('/bindings/:bindingId', requireImAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      expectedVersion: z.number().int().positive(),
      externalConversationId: z.string().trim().min(1).max(191).optional(),
      enabled: z.boolean().optional(),
    }).strict().parse(req.body ?? {})
    res.json(await updateImBinding(uuid.parse(req.params.bindingId), body, actor(req)))
  } catch (error) { next(error) }
})

imIntegrationsRouter.delete('/bindings/:bindingId', requireImAdmin, async (req: AuthedRequest, res, next) => {
  try { res.json(await deleteImBinding(uuid.parse(req.params.bindingId), actor(req))) } catch (error) { next(error) }
})

imIntegrationsRouter.post('/outbox', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      botId: uuid,
      bindingId: uuid,
      idempotencyKey: z.string().trim().min(8).max(128),
      message: z.string().trim().min(1).max(4_000),
    }).strict().parse(req.body ?? {})
    res.status(202).json(await enqueueImMessage(body, actor(req)))
  } catch (error) { next(error) }
})

// This route is mounted before session authentication. Its per-bot secret is
// verified in constant time before any external identity can reach an Agent.
imInboundRouter.post('/:botId', async (req, res, next) => {
  try {
    const body = z.object({
      externalMessageId: z.string().trim().min(1).max(191),
      externalConversationId: z.string().trim().min(1).max(191),
      externalUserId: z.string().trim().min(1).max(191).optional(),
      message: z.string().trim().min(1).max(20_000),
      payload: z.record(z.string(), z.unknown()).optional(),
    }).strict().parse(req.body ?? {})
    const inboundSecret = z.string().min(16).max(8_000).parse(req.headers['x-im-webhook-secret'])
    const result = await routeImInboundMessage({
      botId: uuid.parse(req.params.botId), inboundSecret, ...body,
    }, async (route) => await sendJwAgentMessage(
      route.userId, route.userRole, route.agentId, route.message,
    ))
    res.status(result.duplicate ? 200 : 202).json({
      id: result.id, status: result.status, duplicate: result.duplicate,
    })
  } catch (error) { next(error) }
})
