import { Router } from 'express'
import { z } from 'zod'
import { login, seedUsers, verifyToken } from '../services/authService.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'

export const authRouter = Router()

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = LoginSchema.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ code: 'INVALID_ARGUMENT', message: '请输入合法的邮箱和密码', details: body.error.flatten() })
      return
    }
    const result = await login(body.data.email, body.data.password)
    await seedUsers().catch(() => {}) // 幂等自愈，不阻断
    res.json(result)
  } catch (err) {
    const e = err as Error & { code?: string }
    res.status(401).json({ code: e.code || 'AUTH_FAILED', message: e.message, details: null })
  }
})

authRouter.get('/me', (req: AuthedRequest, res) => {
  const header = req.headers.authorization
  if (!header) { res.status(401).json({ code: 'AUTH_REQUIRED', message: '未登录', details: null }); return }
  try {
    const payload = verifyToken(header.slice(7))
    res.json({ user: payload })
  } catch {
    res.status(401).json({ code: 'AUTH_INVALID', message: '令牌无效', details: null })
  }
})

authRouter.post('/logout', (_req, res) => res.json({ ok: true }))
