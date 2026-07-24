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
import { MaterialsPage } from './pages/MaterialsPage'
import { MeetingsPage } from './pages/MeetingsPage'
import { WorkflowPage } from './pages/WorkflowPage'
import { RisksPage } from './pages/RisksPage'
import { PostInvestmentPage } from './pages/PostInvestmentPage'
import { KnowledgePage } from './pages/KnowledgePage'
import { SystemPage } from './pages/SystemPage'
import { NotFoundPage } from './pages/NotFoundPage'

function ProtectedLayout() {
  const authenticated = useAuthStore((state) => state.isAuthenticated)
  const location = useLocation()
  if (!authenticated) return <Navigate to="/login" state={{ from: location }} replace />
  return <AppLayout />
}

export default function App() {
  const authenticated = useAuthStore((state) => state.isAuthenticated)
  const hydrate = useAppStore((state) => state.hydrateFromServer)
  useEffect(() => { if (authenticated) { void hydrate() } }, [authenticated, hydrate])
  return (
    <Routes>
      <Route path="/login" element={authenticated ? <Navigate to="/" replace /> : <LoginPage />} />
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
        <Route path="/materials" element={<MaterialsPage />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/workflow" element={<WorkflowPage />} />
        <Route path="/risks" element={<RisksPage />} />
        <Route path="/post-investment" element={<PostInvestmentPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/system" element={<SystemPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
