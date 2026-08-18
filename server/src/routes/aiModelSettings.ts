import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireAiPlatformAdmin } from '../middleware/requireAuth.js'
import {
  AI_MODEL_PROFILE_KEYS,
  AI_MODEL_REVISION_TYPES,
  createAiModel,
  createModelProvider,
  deleteAiModel,
  deleteModelProvider,
  listAvailableModels,
  listModelSettings,
  listModelConfigurationRevisions,
  rollbackModelConfigurationRevision,
  testModelProvider,
  updateAiModel,
  updateModelProvider,
  upsertAiModelRoute,
  type AiModelActor,
} from '../services/aiModelSettingsService.js'

export const aiModelSettingsRouter = Router()

const providerId = z.string().uuid()
const protocol = z.enum(['openai-compatible', 'anthropic-compatible'])
const baseUrl = z.string().url().max(2048)
const apiKey = z.string().min(8).max(4096)
const timeoutMs = z.coerce.number().int().min(1_000).max(600_000)
const version = z.coerce.number().int().min(1)
const roleList = z.array(z.string().min(1).max(64)).max(32).default([])
const tagList = z.array(z.string().min(1).max(64)).max(32).default([])

const CreateProvider = z.object({
  name: z.string().trim().min(1).max(128),
  protocol: protocol.default('openai-compatible'),
  baseUrl,
  apiKey,
  timeoutMs: timeoutMs.default(120_000),
  enabled: z.boolean().default(true),
})

const UpdateProvider = z.object({
  expectedVersion: version,
  name: z.string().trim().min(1).max(128).optional(),
  protocol: protocol.optional(),
  baseUrl: baseUrl.optional(),
  apiKey: apiKey.optional(),
  timeoutMs: timeoutMs.optional(),
  enabled: z.boolean().optional(),
})

const CreateModel = z.object({
  providerId,
  modelKey: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(128),
  contextWindow: z.coerce.number().int().min(1).max(10_000_000).nullish(),
  capabilityTags: tagList,
  allowedRoles: roleList,
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
})

const UpdateModel = z.object({
  expectedVersion: version,
  providerId: providerId.optional(),
  modelKey: z.string().trim().min(1).max(128).optional(),
  displayName: z.string().trim().min(1).max(128).optional(),
  contextWindow: z.coerce.number().int().min(1).max(10_000_000).nullable().optional(),
  capabilityTags: tagList.optional(),
  allowedRoles: roleList.optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
})

const UpsertRoute = z.object({
  profileKey: z.enum(AI_MODEL_PROFILE_KEYS),
  modelId: z.string().uuid(),
  fallbackModelId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().default(true),
  expectedVersion: version.optional(),
})

function actor(req: AuthedRequest): AiModelActor {
  return {
    userId: req.user!.uid,
    userName: req.user!.name,
    role: req.user!.role,
    ip: req.ip,
  }
}

aiModelSettingsRouter.get('/available', async (req: AuthedRequest, res, next) => {
  try { res.json({ list: await listAvailableModels(req.user!.role) }) } catch (error) { next(error) }
})

aiModelSettingsRouter.use(requireAiPlatformAdmin)

aiModelSettingsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try { res.json(await listModelSettings(actor(req))) } catch (error) { next(error) }
})

aiModelSettingsRouter.get('/history/:resourceType/:resourceId', async (req: AuthedRequest, res, next) => {
  try {
    const resourceType = z.enum(AI_MODEL_REVISION_TYPES).parse(req.params.resourceType)
    const resourceId = resourceType === 'route'
      ? z.enum(AI_MODEL_PROFILE_KEYS).parse(req.params.resourceId)
      : z.string().uuid().parse(req.params.resourceId)
    res.json(await listModelConfigurationRevisions(resourceType, resourceId, actor(req)))
  } catch (error) { next(error) }
})

aiModelSettingsRouter.post('/history/:resourceType/:resourceId/:revisionId/rollback', async (req: AuthedRequest, res, next) => {
  try {
    const resourceType = z.enum(AI_MODEL_REVISION_TYPES).parse(req.params.resourceType)
    const resourceId = resourceType === 'route'
      ? z.enum(AI_MODEL_PROFILE_KEYS).parse(req.params.resourceId)
      : z.string().uuid().parse(req.params.resourceId)
    const body = z.object({ expectedVersion: version }).strict().parse(req.body ?? {})
    res.json(await rollbackModelConfigurationRevision({
      resourceType, resourceId, revisionId: z.string().uuid().parse(req.params.revisionId),
      expectedVersion: body.expectedVersion,
    }, actor(req)))
  } catch (error) { next(error) }
})

aiModelSettingsRouter.post('/providers', async (req: AuthedRequest, res, next) => {
  try { res.status(201).json(await createModelProvider(CreateProvider.parse(req.body), actor(req))) } catch (error) { next(error) }
})

aiModelSettingsRouter.patch('/providers/:id', async (req: AuthedRequest, res, next) => {
  try {
    res.json(await updateModelProvider(providerId.parse(req.params.id), UpdateProvider.parse(req.body), actor(req)))
  } catch (error) { next(error) }
})

aiModelSettingsRouter.delete('/providers/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ expectedVersion: version }).strict().parse(req.query)
    res.json(await deleteModelProvider(providerId.parse(req.params.id), body.expectedVersion, actor(req)))
  } catch (error) { next(error) }
})

aiModelSettingsRouter.post('/providers/:id/test', async (req: AuthedRequest, res, next) => {
  try { res.json(await testModelProvider(providerId.parse(req.params.id), actor(req))) } catch (error) { next(error) }
})

aiModelSettingsRouter.post('/models', async (req: AuthedRequest, res, next) => {
  try { res.status(201).json(await createAiModel(CreateModel.parse(req.body), actor(req))) } catch (error) { next(error) }
})

aiModelSettingsRouter.patch('/models/:id', async (req: AuthedRequest, res, next) => {
  try {
    res.json(await updateAiModel(z.string().uuid().parse(req.params.id), UpdateModel.parse(req.body), actor(req)))
  } catch (error) { next(error) }
})

aiModelSettingsRouter.delete('/models/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ expectedVersion: version }).strict().parse(req.query)
    res.json(await deleteAiModel(z.string().uuid().parse(req.params.id), body.expectedVersion, actor(req)))
  } catch (error) { next(error) }
})

aiModelSettingsRouter.put('/routes/:profileKey', async (req: AuthedRequest, res, next) => {
  try {
    const profileKey = z.enum(AI_MODEL_PROFILE_KEYS).parse(req.params.profileKey)
    res.json(await upsertAiModelRoute(UpsertRoute.parse({ ...req.body, profileKey }), actor(req)))
  } catch (error) { next(error) }
})
