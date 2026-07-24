// Auth store：保存 token + 当前用户，使用 sessionStorage（关闭浏览器即清）
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export interface AuthUser {
  id: string
  email: string
  name: string
  role: string
  department: string
  status?: string
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  isAuthenticated: boolean
  setAuth: (payload: { token: string; user: AuthUser }) => void
  logout: () => void
  getToken: () => string | null
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      isAuthenticated: false,
      setAuth: ({ token, user }) => set({ token, user, isAuthenticated: true }),
      logout: () => set({ token: null, user: null, isAuthenticated: false }),
      getToken: () => get().token,
    }),
    {
      name: 'cybernaut-auth',
      storage: createJSONStorage(() => sessionStorage),
    }
  )
)

// 帮助全局 fetch 自动加 Authorization
export function authHeader(): Record<string, string> {
  const t = useAuthStore.getState().token
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const t = useAuthStore.getState().token
  if (t) headers.set('Authorization', `Bearer ${t}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return fetch(input, { ...init, headers })
}
