import { Router } from 'express'
import { LoginSchema } from '../schemas/login.js'
import { AccountRegistrationSchema, ChangeOwnPasswordSchema } from '../schemas/account.js'
import {
  createAuthSession,
  legacyBearerAllowedForUser,
  legacyBearerAllowed,
  login,
  revokeAuthSession,
  signToken,
} from '../services/authService.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { clearAuthCookies, requestOriginAllowed, setAuthCookies } from '../services/sessionAuthService.js'
import { writeAudit } from '../services/auditService.js'
import { listEffectivePermissionCodes } from '../services/systemAuthorizationService.js'
import { changeOwnPassword, requestUserRegistration } from '../services/identityAdministrationService.js'
import { listSystemAdministration } from '../services/systemAdministrationService.js'
import { isAiPlatformAdminRole, isImAdminRole, isSystemAdminRole } from '../contracts/adminRoleContract.js'

export const authRouter = Router()

authRouter.get('/registration-options', async (_req, res, next) => {
  try {
    const administration = await listSystemAdministration()
    res.setHeader('Cache-Control', 'private, max-age=60')
    res.json({
      roles: administration.roles
        .filter((role) => role.status === '启用' && role.fdeCategory !== 'system_admin')
        .filter((role) => !isSystemAdminRole(role.name) && !isAiPlatformAdminRole(role.name) && !isImAdminRole(role.name))
        .map((role) => role.name),
      departments: administration.departments
        .filter((department) => department.status === '启用')
        .map((department) => department.name),
    })
  } catch (error) { next(error) }
})

authRouter.post('/register', async (req, res, next) => {
  try {
    if (!requestOriginAllowed(req.headers)) {
      throw Object.assign(new Error('注册请求来源不受信任'), { status: 403, code: 'ORIGIN_FORBIDDEN' })
    }
    const result = await requestUserRegistration(AccountRegistrationSchema.parse(req.body))
    res.status(202).json({ ...result, message: '注册申请已提交，请等待系统管理员审核' })
  } catch (error) { next(error) }
})

authRouter.post('/login', async (req, res, next) => {
  try {
    if (!requestOriginAllowed(req.headers)) {
      throw Object.assign(new Error('登录请求来源不受信任'), { status: 403, code: 'ORIGIN_FORBIDDEN' })
    }
    const body = LoginSchema.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({
        code: 'INVALID_ARGUMENT', message: '请输入姓名或邮箱和密码', details: body.error.flatten(),
        requestId: String(res.locals.requestId || ''),
      })
      return
    }
    const result = await login(body.data.identifier, body.data.password)
    const session = await createAuthSession({
      userId: result.payload.uid,
      remember: body.data.remember,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    })
    setAuthCookies(res, { ...session, persistent: body.data.remember })
    await writeAudit({
      userId: result.payload.uid,
      userName: result.payload.name,
      module: '账号安全',
      action: '登录成功',
      target: result.payload.email,
      ip: req.ip,
    })
    const includeLegacyToken = legacyBearerAllowed()
      && legacyBearerAllowedForUser(result.payload.uid)
      && req.headers['x-legacy-bearer-auth'] === 'acceptance'
    res.json({
      user: { ...result.user, permissionCodes: await listEffectivePermissionCodes(result.payload.uid, result.payload.role) },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
      ...(includeLegacyToken ? { token: signToken(result.payload) } : {}),
    })
  } catch (err) {
    const e = err as Error & { status?: number; code?: string }
    res.status(e.status ?? 401).json({
      code: e.code || 'AUTH_FAILED', message: e.message, details: null,
      requestId: String(res.locals.requestId || ''),
    })
  }
})

authRouter.get('/me', async (req: AuthedRequest, res, next) => {
  try {
  const user = req.user
  res.json({
    user: user ? {
      id: user.uid,
      email: user.email,
      name: user.name,
      role: user.role,
      department: user.department,
      status: '启用',
      permissionCodes: await listEffectivePermissionCodes(user.uid, user.role),
    } : null,
    authMode: req.auth?.mode,
  })
  } catch (error) { next(error) }
})

authRouter.post('/logout', async (req: AuthedRequest, res, next) => {
  try {
    if (req.user) {
      await writeAudit({
        userId: req.user.uid,
        userName: req.user.name,
        module: '账号安全',
        action: '退出登录',
        target: req.user.email,
        ip: req.ip,
      })
    }
    if (req.auth?.sessionId) await revokeAuthSession(req.auth.sessionId)
    clearAuthCookies(res)
    res.json({ ok: true })
  } catch (error) { next(error) }
})

authRouter.post('/change-password', async (req: AuthedRequest, res, next) => {
  try {
    const body = ChangeOwnPasswordSchema.parse(req.body)
    const result = await changeOwnPassword({ userId: req.user!.uid, ...body })
    clearAuthCookies(res)
    res.json({ ok: true, reauthRequired: true, revokedSessions: result.revokedSessions })
  } catch (error) { next(error) }
})
