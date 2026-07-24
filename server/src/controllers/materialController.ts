import type { NextFunction, Request, Response } from 'express'
import { generateMaterial } from '../services/materialService.js'
import { writeAudit } from '../services/auditService.js'
import type { MaterialRequest } from '../models/types.js'

export async function createMaterial(req: Request, res: Response, next: NextFunction) {
  try {
    const request = req.body as MaterialRequest
    if (!request.project?.name || !request.type || !Array.isArray(request.outline)) {
      res.status(400).json({ code: 'INVALID_ARGUMENT', message: '项目、材料类型和大纲不能为空', details: null })
      return
    }
    const result = await generateMaterial(request)
    writeAudit('上会材料', '生成材料', `${request.project.name}：${request.type}`)
    res.json({ code: 0, message: 'success', ...result })
  } catch (error) {
    next(error)
  }
}
