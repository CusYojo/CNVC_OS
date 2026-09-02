import type { NextFunction, Request, Response } from 'express'
import {
  assertRequestCsrf,
  authenticateHttpRequest,
  renewAuthCookiesIfNeeded,
  type RequestAuth,
} from '../services/sessionAuthService.js'
import { userHasPermission } from '../services/systemAuthorizationService.js'
import { isAiPlatformAdminRole, isSystemAdminRole } from '../contracts/adminRoleContract.js'

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
  if (!req.user || !isSystemAdminRole(req.user.role)) {
    res.status(403).json({ code: 'ROLE_FORBIDDEN', message: '仅系统管理员可访问', details: null, requestId: String(res.locals.requestId || '') })
    return
  }
  next()
}

export function requireAiPlatformAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user || !isAiPlatformAdminRole(req.user.role)) {
    res.status(403).json({ code: 'ROLE_FORBIDDEN', message: '仅 AI 平台管理员可访问', details: null, requestId: String(res.locals.requestId || '') })
    return
  }
  next()
}

export function requireImAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  void requirePermission(req, res, next, 'im.manage', '仅具有 IM 管理权限的用户可访问').catch(next)
}
