import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireAiPlatformAdmin } from '../middleware/requireAuth.js'
import { AI_MODEL_PROFILE_KEYS } from '../services/aiModelSettingsService.js'
import { requireAiCapabilitiesEnabled } from '../config/extensionFeatureFlags.js'
import {
  AGENT_POLICY_LIMITS,
  AI_CAPABILITY_REVISION_TYPES,
  AI_CAPABILITY_SCOPE_TYPES,
  createCapabilityBinding,
  deleteSkill,
  getConversationCapabilities,
  listAvailableCapabilities,
  listCapabilitySettings,
  listCapabilityConfigurationRevisions,
  rollbackCapabilityConfigurationRevision,
  setConversationCapabilities,
  syncBuiltinCapabilities,
  testCapability,
  updateAgentCapabilityPolicy,
  updateCapability,
  updateCapabilityBinding,
  type AiCapabilityActor,
} from '../services/aiCapabilityService.js'

export const aiCapabilitiesRouter = Router()
const uuid = z.string().uuid()
const version = z.coerce.number().int().min(1)

aiCapabilitiesRouter.use(requireAiCapabilitiesEnabled)

function actor(req: AuthedRequest): AiCapabilityActor {
  return {
    userId: req.user!.uid, userName: req.user!.name, role: req.user!.role,
    department: req.user!.department, ip: req.ip,
  }
}

aiCapabilitiesRouter.get('/available', async (req: AuthedRequest, res, next) => {
  try {
    const query = z.object({ projectId: z.string().uuid().optional() }).parse(req.query)
    res.json({ list: await listAvailableCapabilities(actor(req), query.projectId) })
  } catch (error) { next(error) }
})

aiCapabilitiesRouter.get('/conversations/:conversationId', async (req: AuthedRequest, res, next) => {
  try { res.json(await getConversationCapabilities(actor(req), uuid.parse(req.params.conversationId))) } catch (error) { next(error) }
})

aiCapabilitiesRouter.put('/conversations/:conversationId', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ capabilityIds: z.array(uuid).max(64) }).parse(req.body)
    res.json(await setConversationCapabilities(actor(req), uuid.parse(req.params.conversationId), body.capabilityIds))
  } catch (error) { next(error) }
})

aiCapabilitiesRouter.use(requireAiPlatformAdmin)

aiCapabilitiesRouter.get('/', async (req: AuthedRequest, res, next) => {
  try { res.json(await listCapabilitySettings(actor(req))) } catch (error) { next(error) }
})

aiCapabilitiesRouter.get('/history/:resourceType/:resourceId', async (req: AuthedRequest, res, next) => {
  try {
    const resourceType = z.enum(AI_CAPABILITY_REVISION_TYPES).parse(req.params.resourceType)
    const resourceId = uuid.parse(req.params.resourceId)
    res.json(await listCapabilityConfigurationRevisions(resourceType, resourceId, actor(req)))
  } catch (error) { next(error) }
})

aiCapabilitiesRouter.post('/history/:resourceType/:resourceId/:revisionId/rollback', async (req: AuthedRequest, res, next) => {
  try {
    const resourceType = z.enum(AI_CAPABILITY_REVISION_TYPES).parse(req.params.resourceType)
    const body = z.object({ expectedVersion: version }).strict().parse(req.body ?? {})
    res.json(await rollbackCapabilityConfigurationRevision({
      resourceType, resourceId: uuid.parse(req.params.resourceId),
      revisionId: uuid.parse(req.params.revisionId), expectedVersion: body.expectedVersion,
    }, actor(req)))
  } catch (error) { next(error) }
})

aiCapabilitiesRouter.post('/sync', async (req: AuthedRequest, res, next) => {
  try { res.json(await syncBuiltinCapabilities(actor(req))) } catch (error) { next(error) }
})

aiCapabilitiesRouter.patch('/agents/:id/policy', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      expectedVersion: version,
      modelRouteKey: z.enum(AI_MODEL_PROFILE_KEYS),
      timeoutMs: z.coerce.number().int().min(AGENT_POLICY_LIMITS.timeoutMs.min).max(AGENT_POLICY_LIMITS.timeoutMs.max),
      maxTurns: z.coerce.number().int().min(AGENT_POLICY_LIMITS.maxTurns.min).max(AGENT_POLICY_LIMITS.maxTurns.max),
      maxBudgetUsd: z.coerce.number().min(AGENT_POLICY_LIMITS.maxBudgetUsd.min).max(AGENT_POLICY_LIMITS.maxBudgetUsd.max),
      toolNames: z.array(z.string().trim().min(1).max(128)).max(32),
      allowedRoles: z.array(z.string().trim().min(1).max(64)).max(32),
    }).strict().parse(req.body)
    res.json(await updateAgentCapabilityPolicy(uuid.parse(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})

aiCapabilitiesRouter.delete('/skills/:id', async (req: AuthedRequest, res, next) => {
  try {
    const query = z.object({ expectedVersion: version }).strict().parse(req.query)
    res.json(await deleteSkill(uuid.parse(req.params.id), query.expectedVersion, actor(req)))
  } catch (error) { next(error) }
})

aiCapabilitiesRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      expectedVersion: version,
      name: z.string().trim().min(1).max(128).optional(),
      description: z.string().max(4000).nullable().optional(),
      allowedRoles: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
      enabled: z.boolean().optional(),
    }).parse(req.body)
    res.json(await updateCapability(uuid.parse(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})

aiCapabilitiesRouter.post('/:id/test', async (req: AuthedRequest, res, next) => {
  try { res.json(await testCapability(uuid.parse(req.params.id), actor(req))) } catch (error) { next(error) }
})

aiCapabilitiesRouter.post('/bindings', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      capabilityId: uuid,
      scopeType: z.enum(AI_CAPABILITY_SCOPE_TYPES),
      department: z.string().trim().min(1).max(64).nullable().optional(),
      projectId: uuid.nullable().optional(),
      enabled: z.boolean().optional(),
    }).parse(req.body)
    res.status(201).json(await createCapabilityBinding(body, actor(req)))
  } catch (error) { next(error) }
})

aiCapabilitiesRouter.patch('/bindings/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ expectedVersion: version, enabled: z.boolean() }).parse(req.body)
    res.json(await updateCapabilityBinding(uuid.parse(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})
