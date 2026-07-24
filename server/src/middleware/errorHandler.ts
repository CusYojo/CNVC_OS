import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  console.error(error)
  if (error instanceof ZodError) {
    res.status(400).json({
      code: 'INVALID_ARGUMENT',
      message: '请求参数不符合要求',
      details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    })
    return
  }
  const typed = error as { status?: number; code?: string; message?: string }
  const status = Number.isInteger(typed?.status) ? Number(typed.status) : 500
  res.status(status).json({
    code: typed?.code ?? 'INTERNAL_ERROR',
    message: typed?.message ?? '服务器内部错误',
    details: null,
  })
}
