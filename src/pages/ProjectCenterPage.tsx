import { FolderKanban, Inbox, Star, UsersRound } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import type { ProjectClassification } from '../types'
import { ProjectsPage } from './ProjectsPage'
import { SourcingPage } from './SourcingPage'
import { FdeTypeRegistrationPanel } from '../components/FdeTypeRegistrationPanel'

type ProjectCenterView = 'leads' | ProjectClassification

const views: Array<{ id: ProjectCenterView; label: string; icon: typeof Inbox }> = [
  { id: 'leads', label: '线索池', icon: Inbox },
  { id: 'pool', label: '项目池', icon: FolderKanban },
  { id: 'normal', label: '普通项目', icon: UsersRound },
  { id: 'key', label: '重点项目', icon: Star },
]

// 暂时隐藏项目池，保留分类和页面能力，恢复时移除此过滤。
const visibleViews = views.filter(item => item.id !== 'pool')

function validView(value: string | null): ProjectCenterView {
  return visibleViews.some((item) => item.id === value) ? value as ProjectCenterView : 'normal'
}

export function ProjectCenterPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const view = validView(searchParams.get('view'))
  const projects = useAppStore(state => state.projects)

  const selectView = (next: ProjectCenterView) => {
    const params = new URLSearchParams(searchParams)
    params.set('view', next)
    setSearchParams(params)
  }

  return (
    <div className="fde-project-center">
      <div className="fde-page-heading">
        <div><h1>项目中心</h1></div>
        {view !== 'leads' && <FdeTypeRegistrationPanel compact />}
      </div>
        <div className="fde-workspace-tabs fde-saved-views" role="tablist" aria-label="项目中心">
          {visibleViews.map((item) => {
            const active = item.id === view
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectView(item.id)}
                className={active ? 'active' : ''}
              >
                {item.label}{item.id !== 'leads' && <em>{projects.filter(project => (project.classification ?? 'normal') === item.id && (project.lifecycle ?? 'active') === 'active').length}</em>}
              </button>
            )
          })}
        </div>
      {view === 'leads' ? <SourcingPage /> : <ProjectsPage classification={view} embedded />}
    </div>
  )
}
