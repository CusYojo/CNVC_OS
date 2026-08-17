import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { safeErrorLog } from '../security/redactSecrets.js'

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = String(res.locals.requestId || '')
  if (error instanceof ZodError) {
    res.status(400).json({
      code: 'INVALID_ARGUMENT',
      message: '请求参数不符合要求',
      details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      requestId,
    })
    return
  }
  const typed = error as { status?: number; code?: string; message?: string }
  const status = Number.isInteger(typed?.status) ? Number(typed.status) : 500
  const log = { requestId, method: req.method, path: req.path, status, code: typed?.code ?? 'INTERNAL_ERROR' }
  if (status >= 500) console.error(JSON.stringify({ ...log, error: safeErrorLog(error) }))
  else console.warn(JSON.stringify(log))
  res.status(status).json({
    code: status >= 500 ? 'INTERNAL_ERROR' : (typed?.code ?? 'REQUEST_FAILED'),
    message: status >= 500 ? '服务器内部错误' : (typed?.message ?? '请求处理失败'),
    details: null,
    requestId,
  })
}
