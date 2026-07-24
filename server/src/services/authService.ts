import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'

const SECRET = process.env.JWT_SECRET || 'cybernaut-dev-secret-change-me'
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h'

export interface JwtPayload {
  uid: string
  email: string
  name: string
  role: string
  department: string
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN as jwt.SignOptions['expiresIn'] })
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, SECRET) as JwtPayload
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10)
}

export async function checkPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export async function login(email: string, password: string) {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1)
  const user = rows[0]
  if (!user || user.status !== '启用') {
    throw Object.assign(new Error('账号不存在或已禁用'), { code: 'AUTH_NOT_FOUND' })
  }
  const ok = await checkPassword(password, user.passwordHash)
  if (!ok) {
    throw Object.assign(new Error('密码错误'), { code: 'AUTH_BAD_PASSWORD' })
  }
  // 更新 last_login
  await db.update(users).set({ lastLogin: new Date() }).where(eq(users.id, user.id))
  const payload: JwtPayload = {
    uid: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    department: user.department,
  }
  return { token: signToken(payload), user: sanitize(user) }
}

export async function seedUsers() {
  const DEMO_USERS = [
    { email: 'lin@cybernaut.com',     name: '林知远', role: '投资经理',     department: '投资部', password: '123456' },
    { email: 'chen@cybernaut.com',    name: '陈思齐', role: '投资总监',     department: '投资部', password: '123456' },
    { email: 'zhao@cybernaut.com',    name: '赵旻',   role: '风控与法务', department: '风险与合规', password: '123456' },
    { email: 'tang@cybernaut.com',    name: '唐婉',   role: '投委会秘书', department: '平台运营', password: '123456' },
    { email: 'admin@cybernaut.com',   name: '系统管理员', role: '系统管理员', department: '信息技术', password: '123456' },
  ]
  for (const u of DEMO_USERS) {
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.email, u.email)).limit(1)
    if (exists[0]) continue
    const passwordHash = await hashPassword(u.password)
    await db.insert(users).values({ email: u.email, name: u.name, role: u.role, department: u.department, passwordHash })
  }
}

function sanitize<T extends Record<string, unknown>>(row: T): Omit<T, 'passwordHash'> {
  const { passwordHash: _omit, ...rest } = row as Record<string, unknown>
  return rest as Omit<T, 'passwordHash'>
}
