import type { NextFunction, Request, Response } from 'express'
import { verifyToken } from '../services/authService.js'

export interface AuthedRequest extends Request {
  user?: {
    uid: string
    email: string
    name: string
    role: string
    department: string
  }
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ code: 'AUTH_REQUIRED', message: '未提供访问令牌', details: null })
    return
  }
  try {
    req.user = verifyToken(header.slice('Bearer '.length))
    next()
  } catch (err) {
    res.status(401).json({ code: 'AUTH_INVALID', message: '令牌无效或已过期', details: null })
  }
}

export function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    try { req.user = verifyToken(header.slice('Bearer '.length)) } catch {}
  }
  next()
}
