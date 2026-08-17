import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, users } from '../db/schema.js'
import { hashPassword, signToken } from '../services/authService.js'

const baseUrl = process.env.AUTH_ACCEPTANCE_URL || 'http://127.0.0.1:3100'

function setCookieLines(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] }
  return enhanced.getSetCookie?.() ?? [headers.get('set-cookie') || '']
}

function cookieValue(lines: string[], name: string): string {
  const match = lines.join(',').match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`))
  if (!match?.[1]) throw new Error(`missing ${name} cookie`)
  return decodeURIComponent(match[1])
}

async function main() {
  if (process.env.AUTH_ALLOW_LEGACY_BEARER === 'true') {
    throw new Error('auth acceptance requires AUTH_ALLOW_LEGACY_BEARER=false')
  }
  const email = `auth-acceptance-${randomUUID()}@example.invalid`
  const password = `acceptance-${randomUUID()}`
  const [created] = await db.insert(users).values({
    email,
    name: '会话验收用户',
    role: '投资经理',
    department: '验收部',
    passwordHash: await hashPassword(password),
  }).$returningId()
  try {
    const wrongPassword = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: `${password}-wrong` }),
    })
    if (wrongPassword.status !== 401) throw new Error(`wrong password returned HTTP ${wrongPassword.status}`)

    const missingAccount = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `missing-${email}`, password }),
    })
    if (missingAccount.status !== 401) throw new Error(`missing account returned HTTP ${missingAccount.status}`)

    const crossOriginLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (crossOriginLogin.status !== 403) throw new Error(`cross-origin login returned HTTP ${crossOriginLogin.status}`)

    const transientLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember: false }),
    })
    if (!transientLogin.ok) throw new Error(`transient login returned HTTP ${transientLogin.status}`)
    const transientCookies = setCookieLines(transientLogin.headers)
    if (transientCookies.some((line) => /Expires=|Max-Age=/i.test(line))) {
      throw new Error('remember=false unexpectedly created persistent browser cookies')
    }
    const transientSession = cookieValue(transientCookies, 'cybernaut_session')
    const transientCsrf = cookieValue(transientCookies, 'cybernaut_csrf')
    const transientCookie = `cybernaut_session=${encodeURIComponent(transientSession)}; cybernaut_csrf=${encodeURIComponent(transientCsrf)}`
    const transientLogout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST', headers: { Cookie: transientCookie, 'X-CSRF-Token': transientCsrf },
    })
    if (!transientLogout.ok) throw new Error(`transient logout returned HTTP ${transientLogout.status}`)

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember: true }),
    })
    if (!login.ok) throw new Error(`login returned HTTP ${login.status}`)
    const loginBody = await login.json() as { user?: { id?: string }; token?: string }
    if (loginBody.user?.id !== created.id || loginBody.token) throw new Error('login identity or legacy-token response is invalid')
    const cookies = setCookieLines(login.headers)
    const sessionToken = cookieValue(cookies, 'cybernaut_session')
    const csrfToken = cookieValue(cookies, 'cybernaut_csrf')
    const sessionCookieLine = cookies.find((line) => line.startsWith('cybernaut_session=')) || ''
    const csrfCookieLine = cookies.find((line) => line.startsWith('cybernaut_csrf=')) || ''
    if (!/HttpOnly/i.test(sessionCookieLine) || /HttpOnly/i.test(csrfCookieLine)) {
      throw new Error('HttpOnly cookie attributes are invalid')
    }
    if (!/SameSite=(Lax|Strict|None)/i.test(sessionCookieLine) || !/Path=\//i.test(sessionCookieLine)) {
      throw new Error('session cookie SameSite/Path attributes are missing')
    }
    const cookie = `cybernaut_session=${encodeURIComponent(sessionToken)}; cybernaut_csrf=${encodeURIComponent(csrfToken)}`

    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } })
    if (!me.ok || ((await me.json()) as { user?: { id?: string } }).user?.id !== created.id) {
      throw new Error(`session /me failed HTTP ${me.status}`)
    }

    const legacy = signToken({
      uid: created.id,
      email,
      name: '会话验收用户',
      role: '投资经理',
      department: '验收部',
    })
    const oldBearer = await fetch(`${baseUrl}/api/users`, { headers: { Authorization: `Bearer ${legacy}` } })
    if (oldBearer.status !== 401) throw new Error(`legacy Bearer returned HTTP ${oldBearer.status}`)

    const withoutCsrf = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    })
    if (withoutCsrf.status !== 403) throw new Error(`missing CSRF returned HTTP ${withoutCsrf.status}`)

    const crossOrigin = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://attacker.invalid', 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (crossOrigin.status !== 403) throw new Error(`cross-origin mutation returned HTTP ${crossOrigin.status}`)

    const create = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'auth acceptance', scope: 'global' }),
    })
    if (create.status !== 201) throw new Error(`valid CSRF mutation returned HTTP ${create.status}`)
    const conversation = await create.json() as { id?: string }
    if (!conversation.id) throw new Error('created conversation id missing')
    const remove = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(conversation.id)}`, {
      method: 'DELETE', headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
    })
    if (!remove.ok) throw new Error(`conversation cleanup returned HTTP ${remove.status}`)

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
    })
    if (!logout.ok) throw new Error(`logout returned HTTP ${logout.status}`)
    const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } })
    if (afterLogout.status !== 401) throw new Error(`revoked session returned HTTP ${afterLogout.status}`)

    await db.update(users).set({ status: '禁用' }).where(eq(users.id, created.id))
    const disabledLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (disabledLogin.status !== 401) throw new Error(`disabled account returned HTTP ${disabledLogin.status}`)

    console.log(JSON.stringify({
      ok: true,
      checks: ['correct-login', 'wrong-password', 'missing-account', 'disabled-account', 'httponly-session-cookie', 'remember-cookie-policy', 'csrf-cookie', 'session-restore', 'login-origin-rejection', 'csrf-rejection', 'origin-rejection', 'valid-mutation', 'server-revocation', 'legacy-bearer-rejection'],
    }))
  } finally {
    await db.delete(auditLogs).where(eq(auditLogs.userId, created.id))
    await db.delete(users).where(eq(users.id, created.id))
  }
}

await main().finally(async () => pool.end())
