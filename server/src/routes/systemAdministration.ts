import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireSystemAdmin } from '../middleware/requireAuth.js'
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
} from '../services/systemAdministrationService.js'

export const systemAdministrationRouter = Router()
systemAdministrationRouter.use(requireSystemAdmin)

const routeId = (value: string | string[]) => z.string().uuid().parse(value)
const actor = (req: AuthedRequest) => ({ userId: req.user!.uid, userName: req.user!.name })
const status = z.enum(['启用', '禁用'])
const dataScope = z.enum(['self', 'department', 'all'])

systemAdministrationRouter.get('/', async (_req, res, next) => {
  try { res.json(await listSystemAdministration()) } catch (error) { next(error) }
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
