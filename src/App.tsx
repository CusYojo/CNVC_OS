import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from './layout/AppLayout'
import { AiErrorBoundary } from './components/AiErrorBoundary'
import { useAuthStore } from './store/useAuthStore'
import { useAppStore } from './store/useAppStore'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { ProjectCenterPage } from './pages/ProjectCenterPage'
import { ProjectDetailPage } from './pages/ProjectDetailPage'
import { LeadDetailPage } from './pages/LeadDetailPage'
import { AIAssistantPage } from './pages/AIAssistantPage'
import { MeetingsPage } from './pages/MeetingsPage'
import { CollaborationPage } from './pages/CollaborationPage'
import { CommitteePage } from './pages/CommitteePage'
import { WorkflowPage } from './pages/WorkflowPage'
import { RisksPage } from './pages/RisksPage'
import { DataKnowledgePage } from './pages/DataKnowledgePage'
import { ResponsibilityPage } from './pages/ResponsibilityPage'
import { FdeResponsibilityPolicyPanel } from './components/FdeResponsibilityPolicyPanel'
import { SystemPage } from './pages/SystemPage'
import { ModelSettingsPage } from './pages/ModelSettingsPage'
import { CapabilitySettingsPage } from './pages/CapabilitySettingsPage'
import { ImBotsPage } from './pages/ImBotsPage'
import { RadarDingTalkSettingsPage } from './pages/RadarDingTalkSettingsPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { isAiPlatformAdminRole, isSystemAdminRole } from '../server/src/contracts/adminRoleContract'

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
  return isSystemAdminRole(user?.role ?? '') ? children : <Navigate to="/" replace />
}

function AiPlatformAdminOnly({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  return isAiPlatformAdminRole(user?.role ?? '')
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
  const refreshProjectDomain = useAppStore((state) => state.refreshProjectDomain)
  useEffect(() => { void restoreSession() }, [restoreSession])
  useEffect(() => { if (authenticated) { void hydrate() } }, [authenticated, hydrate])
  useEffect(() => {
    if (!authenticated) return
    const refresh = () => { if (document.visibilityState === 'visible') void refreshProjectDomain() }
    const timer = window.setInterval(refresh, 15_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [authenticated, refreshProjectDomain])
  return (
    <Routes>
      <Route path="/login" element={initialized && authenticated ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route element={<ProtectedLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectCenterPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/sourcing" element={<Navigate to="/projects?view=leads" replace />} />
        <Route path="/sourcing/:id" element={<LeadDetailPage />} />
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
        <Route path="/collaboration" element={<CollaborationPage />} />
        <Route path="/committee" element={<CommitteePage />} />
        <Route path="/workflow" element={<WorkflowPage />} />
        <Route path="/risks" element={<RisksPage />} />
        <Route path="/post-investment" element={<Navigate to="/projects" replace />} />
        <Route path="/knowledge" element={<DataKnowledgePage />} />
        <Route path="/responsibility" element={<ResponsibilityPage />} />
        <Route path="/responsibility/rules" element={<FdeResponsibilityPolicyPanel />} />
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
