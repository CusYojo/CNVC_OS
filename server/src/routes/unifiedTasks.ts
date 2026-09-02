import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { getUnifiedTask } from '../services/unifiedTaskService.js'

export const unifiedTasksRouter = Router()

unifiedTasksRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id)
    const task = await getUnifiedTask(id, req.user!)
    if (!task) { res.status(404).json({ code: 'NOT_FOUND', message: '任务不存在', details: null }); return }
    res.json(task)
  } catch (error) { next(error) }
})
