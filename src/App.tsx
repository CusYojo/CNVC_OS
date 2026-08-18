import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from './layout/AppLayout'
import { AiErrorBoundary } from './components/AiErrorBoundary'
import { useAuthStore } from './store/useAuthStore'
import { useAppStore } from './store/useAppStore'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { ProjectDetailPage } from './pages/ProjectDetailPage'
import { SourcingPage } from './pages/SourcingPage'
import { AIAssistantPage } from './pages/AIAssistantPage'
import { MeetingsPage } from './pages/MeetingsPage'
import { WorkflowPage } from './pages/WorkflowPage'
import { RisksPage } from './pages/RisksPage'
import { KnowledgePage } from './pages/KnowledgePage'
import { SystemPage } from './pages/SystemPage'
import { ModelSettingsPage } from './pages/ModelSettingsPage'
import { CapabilitySettingsPage } from './pages/CapabilitySettingsPage'
import { ImBotsPage } from './pages/ImBotsPage'
import { RadarDingTalkSettingsPage } from './pages/RadarDingTalkSettingsPage'
import { NotFoundPage } from './pages/NotFoundPage'

function ProtectedLayout() {
  const authenticated = useAuthStore((state) => state.isAuthenticated)
  const initialized = useAuthStore((state) => state.initialized)
  const location = useLocation()
  if (!initialized) return <div className="grid min-h-screen place-items-center text-sm text-slate-500">正在恢复登录状态…</div>
  if (!authenticated) return <Navigate to="/login" state={{ from: location }} replace />
  return <AppLayout />
}

function SystemAdminOnly({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  return user?.permissionCodes?.includes('system.manage') || user?.role === '系统管理员' ? children : <Navigate to="/" replace />
}

function AiPlatformAdminOnly({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  return user?.permissionCodes?.includes('ai.configure') || ['系统管理员', 'AI平台管理员', 'AI 平台管理员'].includes(user?.role || '')
    ? children : <Navigate to="/" replace />
}

function ImAdminOnly({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  return user?.permissionCodes?.includes('im.manage') || ['系统管理员', '运营管理员'].includes(user?.role || '')
    ? children : <Navigate to="/" replace />
}

export default function App() {
  const authenticated = useAuthStore((state) => state.isAuthenticated)
  const initialized = useAuthStore((state) => state.initialized)
  const restoreSession = useAuthStore((state) => state.restoreSession)
  const hydrate = useAppStore((state) => state.hydrateFromServer)
  useEffect(() => { void restoreSession() }, [restoreSession])
  useEffect(() => { if (authenticated) { void hydrate() } }, [authenticated, hydrate])
  return (
    <Routes>
      <Route path="/login" element={initialized && authenticated ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route element={<ProtectedLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/sourcing" element={<SourcingPage />} />
        <Route
          path="/ai"
          element={(
            <AiErrorBoundary level="route" title="AI 助手暂时无法显示" resetKey="ai-route">
              <AIAssistantPage />
            </AiErrorBoundary>
          )}
        />
        <Route path="/materials" element={<Navigate to="/ai" replace />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/workflow" element={<WorkflowPage />} />
        <Route path="/risks" element={<RisksPage />} />
        <Route path="/post-investment" element={<Navigate to="/projects" replace />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/system" element={<SystemAdminOnly><SystemPage /></SystemAdminOnly>} />
        <Route path="/system/ai/models" element={<AiPlatformAdminOnly><ModelSettingsPage /></AiPlatformAdminOnly>} />
        <Route path="/system/ai/capabilities" element={<AiPlatformAdminOnly><CapabilitySettingsPage /></AiPlatformAdminOnly>} />
        <Route path="/system/integrations/im-bots" element={<ImAdminOnly><ImBotsPage /></ImAdminOnly>} />
        <Route path="/system/integrations/radar-dingtalk" element={<SystemAdminOnly><RadarDingTalkSettingsPage /></SystemAdminOnly>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
