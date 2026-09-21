import { FolderKanban, Inbox, Sparkles, Star, UsersRound } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useState } from 'react'
import type { ProjectClassification } from '../types'
import type { ProjectListCounts } from '../services/projectListApi'
import { ProjectsPage } from './ProjectsPage'
import { SourcingPage } from './SourcingPage'
import { LeadReviewPanel } from '../components/LeadReviewPanel'
import { ProjectDiscoveryPage } from './ProjectDiscoveryPage'

type ProjectCenterView = 'leads' | 'discover' | 'reviews' | ProjectClassification

const views: Array<{ id: ProjectCenterView; label: string; icon: typeof Inbox }> = [
  { id: 'leads', label: '线索池', icon: Inbox },
  { id: 'discover', label: '新项目发现', icon: Sparkles },
  { id: 'reviews', label: '待复核', icon: Inbox },
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
  const [classificationCounts, setClassificationCounts] = useState<ProjectListCounts>({ normal: 0, key: 0 })

  const selectView = (next: ProjectCenterView) => {
    const params = new URLSearchParams(searchParams)
    params.set('view', next)
    setSearchParams(params)
  }

  const selectAdjacentView = (current: ProjectCenterView, direction: -1 | 1) => {
    const currentIndex = visibleViews.findIndex((item) => item.id === current)
    const nextIndex = (currentIndex + direction + visibleViews.length) % visibleViews.length
    selectView(visibleViews[nextIndex].id)
  }

  return (
    <div className="fde-project-center">
      <div className="fde-page-heading">
        <div><h1>项目中心</h1><p className="mt-1 text-sm text-slate-500">使用顶部导航栏的"快速新建"按钮创建投资项目或登记非投资项目。</p></div>
      </div>
        <div className="fde-workspace-tabs fde-saved-views" role="tablist" aria-label="项目中心">
          {visibleViews.map((item) => {
            const active = item.id === view
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`project-center-tab-${item.id}`}
                aria-controls="project-center-panel"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => selectView(item.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  const direction = event.key === 'ArrowLeft' ? -1 : 1
                  const currentIndex = visibleViews.findIndex((viewItem) => viewItem.id === item.id)
                  const next = visibleViews[(currentIndex + direction + visibleViews.length) % visibleViews.length]
                  selectAdjacentView(item.id, direction)
                  requestAnimationFrame(() => document.getElementById(`project-center-tab-${next.id}`)?.focus())
                }}
                className={active ? 'active' : ''}
              >
                {item.label}{item.id !== 'leads' && item.id !== 'discover' && item.id !== 'reviews' && item.id !== 'pool' && <em>{classificationCounts[item.id]}</em>}
              </button>
            )
          })}
        </div>
      <div id="project-center-panel" role="tabpanel" aria-labelledby={`project-center-tab-${view}`}>
        {view === 'leads' ? <SourcingPage /> : view === 'discover' ? <ProjectDiscoveryPage /> : view === 'reviews' ? <LeadReviewPanel /> : <ProjectsPage classification={view} embedded onCountsChange={setClassificationCounts} />}
      </div>
    </div>
  )
}
