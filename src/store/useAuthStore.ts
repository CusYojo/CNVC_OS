import { create } from 'zustand'

export interface AuthUser {
  id: string
  email: string
  name: string
  role: string
  department: string
  status?: string
  permissionCodes?: string[]
}

interface AuthState {
  user: AuthUser | null
  isAuthenticated: boolean
  initialized: boolean
  setAuth: (payload: { user: AuthUser }) => void
  restoreSession: () => Promise<void>
  clearAuth: () => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  isAuthenticated: false,
  initialized: false,
  setAuth: ({ user }) => set({ user, isAuthenticated: true, initialized: true }),
  restoreSession: async () => {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'include' })
      if (!response.ok) throw new Error('session unavailable')
      const body = await response.json() as { user?: AuthUser }
      if (!body.user) throw new Error('session user unavailable')
      set({ user: body.user, isAuthenticated: true, initialized: true })
    } catch {
      set({ user: null, isAuthenticated: false, initialized: true })
    }
  },
  clearAuth: () => set({ user: null, isAuthenticated: false, initialized: true }),
  logout: () => {
    const csrf = readCookie('cybernaut_csrf')
    void fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    }).catch(() => undefined)
    set({ user: null, isAuthenticated: false, initialized: true })
  },
}))

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const prefix = `${name}=`
  const value = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(prefix))
  if (!value) return null
  try { return decodeURIComponent(value.slice(prefix.length)) } catch { return null }
}

export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const method = (init.method || 'GET').toUpperCase()
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie('cybernaut_csrf')
    if (csrf) headers.set('X-CSRF-Token', csrf)
  }
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return fetch(input, { ...init, headers, credentials: 'include' })
}
