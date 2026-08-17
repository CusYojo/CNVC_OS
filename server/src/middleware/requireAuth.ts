import type { NextFunction, Request, Response } from 'express'
import {
  assertRequestCsrf,
  authenticateHttpRequest,
  renewAuthCookiesIfNeeded,
  type RequestAuth,
} from '../services/sessionAuthService.js'
import { userHasPermission } from '../services/systemAuthorizationService.js'

export interface AuthedRequest extends Request {
  user?: {
    uid: string
    email: string
    name: string
    role: string
    department: string
  }
  auth?: RequestAuth
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    req.auth = await authenticateHttpRequest(req)
    req.user = req.auth.user
    assertRequestCsrf(req, req.auth)
    await renewAuthCookiesIfNeeded(res, req.auth)
    next()
  } catch (error) {
    const typed = error as Error & { status?: number; code?: string }
    const status = typed.status ?? (typed.code?.startsWith('AUTH_') ? 401 : 403)
    res.status(status).json({
      code: typed.code || 'AUTH_INVALID',
      message: typed.message || '登录状态无效',
      details: null,
      requestId: String(res.locals.requestId || ''),
    })
  }
}

export async function optionalAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    req.auth = await authenticateHttpRequest(req)
    req.user = req.auth.user
    await renewAuthCookiesIfNeeded(res, req.auth)
  } catch {}
  next()
}

async function requirePermission(req: AuthedRequest, res: Response, next: NextFunction, code: string, message: string) {
  if (!req.user || !await userHasPermission(req.user.uid, req.user.role, code)) {
    res.status(403).json({
      code: 'ROLE_FORBIDDEN',
      message,
      details: null,
      requestId: String(res.locals.requestId || ''),
    })
    return
  }
  next()
}

export function requireSystemAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  void requirePermission(req, res, next, 'system.manage', '仅具有系统管理权限的用户可访问').catch(next)
}

export function requireAiPlatformAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  void requirePermission(req, res, next, 'ai.configure', '仅具有 AI 配置权限的用户可访问').catch(next)
}

export function requireImAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  void requirePermission(req, res, next, 'im.manage', '仅具有 IM 管理权限的用户可访问').catch(next)
}
