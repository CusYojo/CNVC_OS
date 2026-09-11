import { AlertTriangle, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import {
  ADMIN_PERMANENT_DELETION_RISK_TEXT,
  type PermanentDeletionPreview,
  type PermanentDeletionResourceType,
  type PermanentDeletionTarget,
} from '../../server/src/contracts/adminPermanentDeletionContract'
import { apiGet, apiPost } from '../lib/api'
import { useToast } from './Toast'
import { Badge, Button, Card, Modal } from './ui'

const labels: Record<PermanentDeletionResourceType, string> = {
  lead: '项目池线索', project: '正式项目', knowledge: '知识库条目',
}

export function AdminPermanentDeletionPanel() {
  const { showToast } = useToast()
  const [resourceType, setResourceType] = useState<PermanentDeletionResourceType>('lead')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PermanentDeletionTarget[]>([])
  const [searching, setSearching] = useState(false)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [preview, setPreview] = useState<PermanentDeletionPreview | null>(null)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [resourceName, setResourceName] = useState('')
  const [riskText, setRiskText] = useState('')
  const [deleting, setDeleting] = useState(false)

  async function search() {
    if (!query.trim()) return
    setSearching(true)
    try {
      const params = new URLSearchParams({ resourceType, query: query.trim() })
      setResults(await apiGet<PermanentDeletionTarget[]>(`/system-administration/permanent-deletions/search?${params}`))
    } catch (error) { showToast((error as Error).message, 'error') }
    finally { setSearching(false) }
  }

  async function openPreview(target: PermanentDeletionTarget) {
    setPreviewing(target.id)
    try {
      const next = await apiPost<PermanentDeletionPreview>('/system-administration/permanent-deletions/preview', { resourceType, resourceId: target.id })
      setPreview(next); setStep(1); setResourceName(''); setRiskText('')
    } catch (error) { showToast((error as Error).message, 'error') }
    finally { setPreviewing(null) }
  }

  function close() {
    if (deleting) return
    setPreview(null); setStep(1); setResourceName(''); setRiskText('')
  }

  async function permanentlyDelete() {
    if (!preview || deleting || resourceName !== preview.resourceName || riskText !== ADMIN_PERMANENT_DELETION_RISK_TEXT) return
    setDeleting(true)
    try {
      await apiPost('/system-administration/permanent-deletions/execute', {
        resourceType: preview.resourceType,
        resourceId: preview.resourceId,
        previewToken: preview.previewToken,
        resourceName,
        riskText,
      })
      showToast(`已彻底删除“${preview.resourceName}”`)
      setPreview(null); setStep(1); setResourceName(''); setRiskText(''); await search()
    } catch (error) {
      showToast((error as Error).message, 'error')
      setStep(1); setResourceName(''); setRiskText(''); setPreview(null)
    } finally { setDeleting(false) }
  }

  const blocked = Boolean(preview?.blockers.length)
  return <div className="space-y-5">
    <Card className="border border-rose-200 bg-rose-50 p-5">
      <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 text-rose-600" /><div><h2 className="font-semibold text-rose-900">数据彻底删除</h2><p className="mt-1 text-sm leading-6 text-rose-700">仅系统管理员可操作。删除会清理业务对象及其专属关联数据，完成后不可恢复。</p></div></div>
    </Card>
    <Card className="p-5">
      <div className="grid gap-3 md:grid-cols-[180px_1fr_auto]">
        <select aria-label="删除对象类型" className="input" value={resourceType} onChange={event => { setResourceType(event.target.value as PermanentDeletionResourceType); setResults([]) }}>
          {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input aria-label="搜索删除对象" className="input" value={query} placeholder="输入完整或部分名称，也可以输入 ID" onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void search() }} />
        <Button loading={searching} disabled={!query.trim()} onClick={() => void search()}><Search className="h-4 w-4" />搜索</Button>
      </div>
      <div className="mt-5 divide-y divide-slate-100">
        {results.map(target => <div key={target.id} className="flex flex-wrap items-center gap-3 py-4">
          <div className="min-w-0 flex-1"><strong className="block truncate text-sm text-slate-800">{target.name}</strong><span className="font-mono text-xs text-slate-400">{target.id}</span></div>
          <Badge>{target.status}</Badge><Button variant="danger" loading={previewing === target.id} onClick={() => void openPreview(target)}><Trash2 className="h-4 w-4" />查看删除影响</Button>
        </div>)}
        {!searching && query.trim() && results.length === 0 && <p className="py-8 text-center text-sm text-slate-400">没有匹配的数据</p>}
      </div>
    </Card>
    <Modal open={Boolean(preview)} title={`彻底删除：${preview?.resourceName ?? ''}`} width="max-w-2xl" onClose={close} footer={<>
      <Button variant="secondary" disabled={deleting} onClick={step === 1 ? close : () => setStep((step - 1) as 1 | 2)}>取消 / 返回</Button>
      {step === 1 && !blocked && <Button variant="danger" onClick={() => setStep(2)}>我确认继续</Button>}
      {step === 2 && <Button variant="danger" disabled={resourceName !== preview?.resourceName} onClick={() => setStep(3)}>确认名称并继续</Button>}
      {step === 3 && <Button variant="danger" loading={deleting} disabled={riskText !== ADMIN_PERMANENT_DELETION_RISK_TEXT} onClick={() => void permanentlyDelete()}>永久删除</Button>}
    </>}>
      {preview && <div className="space-y-5">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><strong>删除后不可恢复</strong><p className="mt-2">对象：{labels[preview.resourceType]} · {preview.resourceName}</p><p>关联记录：{preview.impact.relatedRecords}，专属文件：{preview.impact.files}，共享文件：{preview.impact.sharedFiles}</p></div>
        {blocked && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">该线索已经转换为正式项目，请先处理对应正式项目后重新预览。</p>}
        {!blocked && step === 1 && <p className="text-sm leading-6 text-slate-600">第一次确认：请核对对象及影响范围，并确认继续。</p>}
        {!blocked && step === 2 && <label className="block text-sm"><span className="label">第二次确认：输入对象完整名称“{preview.resourceName}”</span><input autoComplete="off" className="input mt-2 w-full" value={resourceName} onChange={event => setResourceName(event.target.value)} /></label>}
        {!blocked && step === 3 && <label className="block text-sm"><span className="label">第三次确认：逐字输入以下内容</span><code className="my-2 block rounded-lg bg-slate-100 p-3 text-slate-700">{ADMIN_PERMANENT_DELETION_RISK_TEXT}</code><textarea autoComplete="off" className="input min-h-24 w-full" value={riskText} onChange={event => setRiskText(event.target.value)} /></label>}
      </div>}
    </Modal>
  </div>
}
