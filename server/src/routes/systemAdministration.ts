import { Router } from 'express'
import { z } from 'zod'
import { listOfficePolicies, publishOfficePolicy, resolveOfficePolicyCommand, saveOfficePolicy, setOfficePolicyEnabled } from '../services/fdeOfficePolicyService.js'
import { FDE_ROLE_CATEGORIES, type FdeRoleCategory } from '../contracts/fdeGovernanceContract.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireSystemAdmin } from '../middleware/requireAuth.js'
import { fdeWorkflowPolicySchema } from '../contracts/fdeWorkflowPolicyContract.js'
import { getFdeIntegrationSummary } from '../services/fdeIntegrationSummaryService.js'
import { createFdePolicyDraft, listFdeWorkflowPolicies, publishFdePolicyVersion, saveFdePolicyDraft, setFdePolicyEnabled } from '../services/fdeWorkflowPolicyService.js'
import {
  createDepartment,
  createDictionaryGroup,
  createDictionaryItem,
  createRole,
  listSystemAdministration,
  updateDepartment,
  updateDictionaryGroup,
  updateDictionaryItem,
  updateRole,
  updateUserRoleBindings,
} from '../services/systemAdministrationService.js'

export const systemAdministrationRouter = Router()
// Already authenticated by /api; only one's own minimal technical receipt.
// All configuration reads and new writes below retain system.manage.
systemAdministrationRouter.post('/office-policy-commands/resolve', async (req: AuthedRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await resolveOfficePolicyCommand(req.user!.uid, req.body)) } catch (e) { next(e) }
})
systemAdministrationRouter.use(requireSystemAdmin)

const routeId = (value: string | string[]) => z.string().uuid().parse(value)
const actor = (req: AuthedRequest) => ({ userId: req.user!.uid, userName: req.user!.name })
const status = z.enum(['启用', '禁用'])
const dataScope = z.enum(['self', 'department', 'all'])
const fdeCategory = z.custom<FdeRoleCategory>((value) => FDE_ROLE_CATEGORIES.some((category) => category.code === value)).nullable().optional()
const ruleReason = z.string().trim().min(5).max(1000)

systemAdministrationRouter.get('/office-policies', async (req: AuthedRequest, res, next) => { try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await listOfficePolicies(req.user!.uid)) } catch (e) { next(e) } })
systemAdministrationRouter.post('/office-policy-versions/:id/save', async (req: AuthedRequest, res, next) => { try { res.json(await saveOfficePolicy(routeId(req.params.id), req.user!.uid, req.body)) } catch (e) { next(e) } })
systemAdministrationRouter.post('/office-policy-versions/:id/publish', async (req: AuthedRequest, res, next) => { try { res.json(await publishOfficePolicy(routeId(req.params.id), req.user!.uid, req.body)) } catch (e) { next(e) } })
systemAdministrationRouter.post('/office-policies/:id/enabled', async (req: AuthedRequest, res, next) => { try { res.json(await setOfficePolicyEnabled(routeId(req.params.id), req.user!.uid, req.body)) } catch (e) { next(e) } })

systemAdministrationRouter.get('/integrations-summary', async (req: AuthedRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await getFdeIntegrationSummary(req.user!.uid)) } catch (error) { next(error) }
})

systemAdministrationRouter.get('/fde-policies', async (_req, res, next) => {
  try { res.json(await listFdeWorkflowPolicies()) } catch (error) { next(error) }
})
systemAdministrationRouter.post('/fde-policies/:id/drafts', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ sourceVersionId: z.uuid(), expectedVersion: z.number().int().positive(), reason: ruleReason }).strict().parse(req.body)
    res.status(201).json(await createFdePolicyDraft(routeId(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})
systemAdministrationRouter.patch('/fde-policy-versions/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ expectedVersion: z.number().int().positive(), configuration: fdeWorkflowPolicySchema, reason: ruleReason }).strict().parse(req.body)
    res.json(await saveFdePolicyDraft(routeId(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})
systemAdministrationRouter.post('/fde-policies/:id/publish', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ versionId: z.uuid(), expectedPolicyVersion: z.number().int().positive(), expectedDraftVersion: z.number().int().positive(), reason: ruleReason }).strict().parse(req.body)
    res.json(await publishFdePolicyVersion(routeId(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})
systemAdministrationRouter.patch('/fde-policies/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ enabled: z.boolean(), expectedVersion: z.number().int().positive(), reason: ruleReason }).strict().parse(req.body)
    res.json(await setFdePolicyEnabled(routeId(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})

systemAdministrationRouter.get('/', async (_req, res, next) => {
  try { res.json(await listSystemAdministration()) } catch (error) { next(error) }
})

systemAdministrationRouter.put('/users/:id/roles', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ primaryRoleId: z.uuid(), roleIds: z.array(z.uuid()).min(1).max(30), expectedRoleIds: z.array(z.uuid()).max(30), expectedPrimaryRoleId: z.uuid().nullable() }).strict().parse(req.body)
    res.json(await updateUserRoleBindings(routeId(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})

systemAdministrationRouter.post('/departments', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      code: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/),
      name: z.string().trim().min(1).max(64),
      parentId: z.uuid().nullable().optional(), managerUserId: z.uuid().nullable().optional(),
      description: z.string().max(1000).nullable().optional(), sortOrder: z.number().int().min(0).max(100000).optional(),
    }).strict().parse(req.body)
    res.status(201).json(await createDepartment(body, actor(req)))
  } catch (error) { next(error) }
})

systemAdministrationRouter.patch('/departments/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      name: z.string().trim().min(1).max(64).optional(), parentId: z.uuid().nullable().optional(),
      managerUserId: z.uuid().nullable().optional(), description: z.string().max(1000).nullable().optional(),
      status: status.optional(), sortOrder: z.number().int().min(0).max(100000).optional(),
      expectedVersion: z.number().int().positive(),
    }).strict().parse(req.body)
    res.json(await updateDepartment(routeId(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})

systemAdministrationRouter.post('/roles', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      code: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().min(1).max(32),
      description: z.string().max(1000).nullable().optional(), dataScope,
      fdeCategory,
      permissionIds: z.array(z.uuid()).max(200).optional(),
    }).strict().parse(req.body)
    res.status(201).json(await createRole(body, actor(req)))
  } catch (error) { next(error) }
})

systemAdministrationRouter.patch('/roles/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      name: z.string().trim().min(1).max(32).optional(), description: z.string().max(1000).nullable().optional(),
      dataScope: dataScope.optional(), status: status.optional(), permissionIds: z.array(z.uuid()).max(200).optional(),
      fdeCategory,
      expectedVersion: z.number().int().positive(),
    }).strict().parse(req.body)
    res.json(await updateRole(routeId(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})

systemAdministrationRouter.post('/dictionaries', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      code: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/), name: z.string().trim().min(1).max(64),
      description: z.string().max(1000).nullable().optional(),
    }).strict().parse(req.body)
    res.status(201).json(await createDictionaryGroup(body, actor(req)))
  } catch (error) { next(error) }
})

systemAdministrationRouter.patch('/dictionaries/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      name: z.string().trim().min(1).max(64).optional(), description: z.string().max(1000).nullable().optional(),
      status: status.optional(), expectedVersion: z.number().int().positive(),
    }).strict().parse(req.body)
    res.json(await updateDictionaryGroup(routeId(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})

systemAdministrationRouter.post('/dictionaries/:id/items', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      value: z.string().trim().min(1).max(128), label: z.string().trim().min(1).max(128),
      sortOrder: z.number().int().min(0).max(100000).optional(),
    }).strict().parse(req.body)
    res.status(201).json(await createDictionaryItem(routeId(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})

systemAdministrationRouter.patch('/dictionary-items/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      label: z.string().trim().min(1).max(128).optional(), sortOrder: z.number().int().min(0).max(100000).optional(),
      status: status.optional(), expectedVersion: z.number().int().positive(),
    }).strict().parse(req.body)
    res.json(await updateDictionaryItem(routeId(req.params.id), body, actor(req)))
  } catch (error) { next(error) }
})
