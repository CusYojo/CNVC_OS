import type { NextFunction, Response } from 'express'
import { generateMaterial } from '../services/materialService.js'
import { writeAudit } from '../services/auditService.js'
import type { MaterialRequest } from '../models/types.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireAccessibleProject } from '../services/projectAccessService.js'

export async function createMaterial(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const request = req.body as MaterialRequest
    if (!request.project?.name || !request.type || !Array.isArray(request.outline)) {
      res.status(400).json({ code: 'INVALID_ARGUMENT', message: '项目、材料类型和大纲不能为空', details: null })
      return
    }
    await requireAccessibleProject(req.user!.uid, request.project.id)
    const result = await generateMaterial(request, req.user!.uid)
    await writeAudit({
      userId: req.user!.uid,
      userName: req.user!.name,
      module: '上会材料',
      action: '生成材料',
      target: `${request.project.name}：${request.type}`,
      ip: req.ip,
    })
    res.json({ code: 0, message: 'success', ...result })
  } catch (error) {
    next(error)
  }
}
