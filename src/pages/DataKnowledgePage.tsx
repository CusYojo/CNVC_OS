import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { KnowledgePage } from './KnowledgePage'
import { FdeCompanyKnowledgePanel } from '../components/FdeCompanyKnowledgePanel'
import { FdeProjectArchivePanel } from '../components/FdeProjectArchivePanel'
import { FdeResponsibilityPanel } from '../components/FdeResponsibilityPanel'
import { PersonalNotesPanel } from '../components/PersonalNotesPanel'
import { responsibilityOverview } from '../../server/src/contracts/fdeResponsibilityViewContract'
import { Button, Card } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'
import { apiGet } from '../lib/api'
import { dataKnowledgeCapabilities, dataKnowledgeSelection, type ArchiveTool, type DataKnowledgeCapabilities } from '../../server/src/contracts/fdeDataKnowledgeContract'
import '../components/fde-workspace.css'
import './DataKnowledgePage.css'

export function DataKnowledgePage() {
  const userId = useAuthStore(state => state.user?.id ?? '')
  return <DataKnowledgeWorkspace key={userId} userId={userId} />
}

function DataKnowledgeWorkspace({ userId }: { userId: string }) {
  const [params, setParams] = useSearchParams()
  const [capabilities, setCapabilities] = useState<DataKnowledgeCapabilities | null>(null)
  const [management, setManagement] = useState(false)
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const requestedView = params.get('view'), requestedTool = params.get('archiveTool')
  useEffect(() => {
    let active = true, sequence = 0
    const load = async () => {
      const request = ++sequence; setManagement(false)
      try { const value = responsibilityOverview.parse(await apiGet<unknown>('/responsibility/overview')); if (active && request === sequence && useAuthStore.getState().user?.id === userId) setManagement(value.management) }
      catch { if (active && request === sequence) setManagement(false) }
    }
    void load(); window.addEventListener('focus', load)
    return () => { active = false; window.removeEventListener('focus', load) }
  }, [userId, refresh])
  useEffect(() => {
    let active = true, request = 0
    const load = async () => {
      const current = ++request
      try {
        const value = dataKnowledgeCapabilities.parse(await apiGet<unknown>('/data-knowledge/capabilities'))
        if (active && current === request && useAuthStore.getState().user?.id === userId) { setCapabilities(value); setError('') }
      } catch (cause) {
        if (active && current === request && useAuthStore.getState().user?.id === userId) { setCapabilities(null); setError((cause as Error).message) }
      }
    }
    void load()
    const focus = () => { void load() }
    window.addEventListener('focus', focus)
    return () => { active = false; window.removeEventListener('focus', focus) }
  }, [userId, requestedView, requestedTool, refresh])
  const selection = capabilities ? dataKnowledgeSelection(capabilities, requestedView, requestedTool) : null
  const openTool = (value: ArchiveTool | null) => { const next = new URLSearchParams(params); value ? next.set('archiveTool', value) : next.delete('archiveTool'); setParams(next) }
  const content = () => {
    if (requestedView === 'notes') return <PersonalNotesPanel />
    if (requestedView === 'responsibility') return <FdeResponsibilityPanel management />
    if (!capabilities || !selection) return <Card className="p-6"><p role={error ? 'alert' : 'status'} className="text-sm text-slate-600">{error || '正在核验当前账号的知识与档案访问资格…'}</p>{error && <Button className="mt-4" variant="secondary" onClick={() => setRefresh(value => value + 1)}>重新核验权限</Button>}</Card>
    if (!selection.allowed) return <Card className="p-6"><h2 className="font-semibold">当前职责无权使用此入口</h2><p role="alert" className="mt-2 text-sm text-slate-500">项目档案、公司知识和上传权限分别核验。请切换到有权页签，或联系管理员核对当前岗位与项目职责。</p><Button className="mt-4" variant="secondary" onClick={() => setRefresh(value => value + 1)}>重新核验权限</Button></Card>
    if (selection.view === 'company') return <FdeCompanyKnowledgePanel />
    if (selection.tool) return <div key={`${userId}:${selection.tool}`}><button className="mb-4 text-sm font-medium text-[#315f68]" onClick={() => openTool(null)}>← 返回项目档案</button><KnowledgePage initialTab={selection.tool === 'input' ? 'input' : selection.tool === 'meetings' ? 'meetings' : 'files'} initialUpload={selection.tool === 'upload'} allowedTools={capabilities} uploadProjectIds={capabilities.uploadProjectIds} /></div>
    return <FdeProjectArchivePanel capabilities={capabilities} onOpenTools={openTool} />
  }
  return <div className="fde-workspace fde-knowledge-page">
    <div className="fde-page-heading"><div><h1>知识库</h1></div></div>
    <div className="fde-workspace-tabs" role="tablist" aria-label="知识库">
      {capabilities && ([['company', '公司知识库'], ['archives', '项目档案']] as const).filter(([key]) => capabilities[key]).map(([key, title]) => <button key={key} role="tab" aria-selected={requestedView !== 'responsibility' && requestedView !== 'notes' && selection?.view === key} className={requestedView !== 'responsibility' && requestedView !== 'notes' && selection?.view === key ? 'active' : ''} onClick={() => { const next = new URLSearchParams(params); next.set('view', key); next.delete('archiveTool'); next.delete('entry'); setParams(next) }}>{title}</button>)}
      <button role="tab" aria-selected={requestedView === 'notes'} className={requestedView === 'notes' ? 'active' : ''} onClick={() => { const next = new URLSearchParams(params); next.set('view', 'notes'); next.delete('archiveTool'); next.delete('entry'); setParams(next) }}>个人笔记</button>
      {management && <button role="tab" aria-selected={requestedView === 'responsibility'} className={requestedView === 'responsibility' ? 'active' : ''} onClick={() => { const next = new URLSearchParams(params); next.set('view', 'responsibility'); next.delete('archiveTool'); next.delete('entry'); setParams(next) }}>管理参考</button>}
    </div>
    {content()}
  </div>
}
