import { useEffect, useRef, useState } from 'react'
import { FileSearch, RefreshCw, Settings2, Sparkles } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { Button, Card, Modal } from './ui'
import { useToast } from './Toast'
import type { ProjectAgentConfig, ProjectAgentDashboard } from '../../server/src/contracts/fdeProjectAgentContract'
import { agentReceiptSchema, agentResolutionSchema } from '../../server/src/contracts/fdeProjectAgentContract'
import './fde-workspace.css'
import { FdeAgentSchedulePanel } from './FdeAgentSchedulePanel'
import { shortProjectDate } from '../lib/projectDetailPresentation'
import type { AgentScheduleDashboard } from '../../server/src/contracts/fdeAgentScheduleContract'

type Dashboard = ProjectAgentDashboard
type AgentRun = Dashboard['runs'][number]
const statuses: Record<string, string> = { running: '研判中', succeeded: '已完成研判', stale: '来源已变化', failed: '研判未完成', open: '待人工确认', accepted: '已采纳', accepted_with_changes: '调整后采纳', rejected: '不采用', dismissed: '已忽略' }
const health: Record<string, string> = { on_track: '按计划推进', needs_information: '待补信息', blocked: '暂缓推进', at_risk: '建议复核日期', waiting_approval: '等待审批', overdue: '重新确认目标日' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function FdeProjectAgentPanel({ projectId, onChanged }: { projectId: string; onChanged?: () => Promise<void> }) {
  const userId = useAuthStore(state => state.user?.id ?? '')
  return <AgentPanel key={`${userId}:${projectId}`} projectId={projectId} userId={userId} onChanged={onChanged} />
}
function AgentPanel({ projectId, userId, onChanged }: { projectId: string; userId: string; onChanged?: () => Promise<void> }) {
  const { showToast } = useToast(), endpoint = `/projects/${projectId}/project-agent`
  const recoveryKey = `fde-project-agent:v1:${userId}:${projectId}`
  const [data, setData] = useState<Dashboard | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [schedule, setSchedule] = useState<AgentScheduleDashboard | null>(null)
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [pending, setPending] = useState('')
  const [settings, setSettings] = useState<ProjectAgentConfig | null>(null), [evidenceRun, setEvidenceRun] = useState<AgentRun | null>(null)
  const [decision, setDecision] = useState<{ run: AgentRun; kind: 'accepted' | 'accepted_with_changes' | 'rejected' } | null>(null)
  const [note, setNote] = useState(''), [suggestedDate, setSuggestedDate] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const sync = () => { try { const value = localStorage.getItem(recoveryKey); setPending(value && uuid.test(value) ? value : '') } catch { setError('无法读取恢复标识；请启用此站点的本地存储后再操作') } }
    sync(); window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync)
  }, [recoveryKey])
  useEffect(() => {
    let cancelled = false
    setData(null); setSchedule(null); setError(''); setEvidenceRun(null); setSettings(null); setDecision(null)
    void Promise.all([apiGet<Dashboard>(`${endpoint}?page=${page}&pageSize=10`), apiGet<AgentScheduleDashboard>(`${endpoint}/schedules`)]).then(([value, dates]) => { if (!cancelled) { setData(value); setSchedule(dates) } }).catch(cause => { if (!cancelled) setError((cause as Error).message) })
    return () => { cancelled = true }
  }, [endpoint, page, refresh])
  const clearPending = (id: string) => { if (localStorage.getItem(recoveryKey) === id) localStorage.removeItem(recoveryKey); if (alive.current) setPending('') }
  const perform = async (path: string, body: object) => {
    if (busy || pending) return
    const id = crypto.randomUUID()
    setBusy(true)
    try {
      if (localStorage.getItem(recoveryKey)) throw new Error('存在待核对请求，请先刷新并核对上次操作')
      localStorage.setItem(recoveryKey, id); setPending(id)
      const receipt = agentReceiptSchema.parse(await apiPost(`${endpoint}${path}`, { ...body, clientRequestId: id }))
      const expectedKind = path.includes('/schedule') ? 'schedule' : path === '/config' ? 'config' : path === '/runs' ? 'run' : 'decision'
      if (receipt.kind !== expectedKind || receipt.kind === 'config' && receipt.id !== projectId) throw new Error('响应与操作不匹配，保留请求标识等待核对')
      clearPending(id)
      try { await onChanged?.() } catch { if (alive.current) showToast('操作已保存，但其他项目摘要刷新失败，请刷新页面核对', 'error') }
      if (alive.current) { setRefresh(value => value + 1); window.dispatchEvent(new CustomEvent('fde-timeline-updated', { detail: projectId })); showToast('处理结果已保存，请核对当前审批和有效节点日期') }
    } catch (cause) { if (alive.current) { setError(`${(cause as Error).message}。如已发送请求，请先核对结果，不要重复提交。`); setData(null); setSchedule(null); setEvidenceRun(null); setDecision(null); setSettings(null) } }
    finally { if (alive.current) setBusy(false) }
  }
  const resolve = async (id: string) => {
    setBusy(true)
    try {
      const result = agentResolutionSchema.parse(await apiPost(`${endpoint}/resolve-command`, { clientRequestId: id }))
      clearPending(id)
      try { await onChanged?.() } catch { if (alive.current) showToast('原操作已核对，但其他项目摘要刷新失败，请刷新页面核对', 'error') }
      if (alive.current) { setRefresh(value => value + 1); showToast(result.state === 'committed' ? '已找到原操作，请查看最新记录' : '原请求未提交且已封闭，可重新确认操作') }
    } catch (cause) { if (alive.current) { setError((cause as Error).message); setData(null); setSchedule(null); setEvidenceRun(null); setDecision(null); setSettings(null) } }
    finally { if (alive.current) setBusy(false) }
  }
  const latest = data?.runs[0], rec = latest?.recommendation
  return <Card className="fde-workspace fde-detail-agent min-w-0 border-[#dfe6e4] p-5" data-testid="fde-project-agent">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-[#315f68]" /><h2 className="font-semibold">推进研判</h2></div><div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
      {data?.capabilities.configure && <Button variant="secondary" disabled={busy || Boolean(pending)} onClick={() => setSettings({ ...data.config.configuration })}><Settings2 className="h-3.5 w-3.5" />设置</Button>}
      {data?.capabilities.run && <Button disabled={busy || Boolean(pending)} onClick={() => void perform('/runs', { expectedConfigVersion: data.config.version })}>{latest ? '重新研判' : '立即研判'}</Button>}
    </div></div>
    {pending && <div role="status" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">有一笔操作需要核对结果。<Button variant="secondary" disabled={busy} onClick={() => void resolve(pending)}>核对上次操作</Button></div>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {!data && !error && <p className="mt-4 text-sm text-slate-500">正在读取授权研判记录…</p>}
    {data && !latest && <div className="fde-detail-agent-empty"><Sparkles className="h-5 w-5" /><strong>尚未研判</strong></div>}
    {latest && <div className="mt-4 space-y-3">
      <p className="text-xs text-slate-500">{statuses[latest.status]} · {latest.provider === 'model' ? '模型增强' : '确定性规则'} · {new Date(String(latest.startedAt)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</p>
      {!latest.readable && <p className="rounded-lg bg-amber-50 p-3 text-sm">来源已变化或不再可见，历史建议及证据不再展示，请重新研判。</p>}
      {latest.stale && latest.readable && <p className="text-sm text-amber-800">此建议的事实或配置基准已过期，不能继续采纳。</p>}
      {rec && <><div className="fde-detail-agent-result"><div><div className="flex flex-wrap gap-2"><span className="rounded-full bg-[#e6f0ef] px-2 py-1 text-xs text-[#315f68]">{health[rec.health]}</span><span className="text-xs text-slate-500">{statuses[rec.status]}</span></div><h3>{rec.title}</h3><p>{rec.summary}</p>{rec.missingInformation.length > 0 && <p className="fde-detail-agent-blockers">待处理：{rec.missingInformation.join('、')}</p>}</div><aside className="fde-detail-agent-next">{rec.currentDate && <div className="fde-detail-agent-dates"><div><span>当前计划</span><strong>{shortProjectDate(rec.currentDate)}</strong></div><b>→</b><div><span>建议日期</span><strong>{shortProjectDate(rec.suggestedDate || rec.currentDate)}</strong></div></div>}<span>下一步</span><strong>{latest.stale ? '来源已变化，请重新研判' : latest.decision?.scheduleDraft ? '发起节点改期审批' : rec.status === 'open' ? '人工确认研判建议' : health[rec.health]}</strong><small>{latest.dateBasis === 'approved' ? '当前节点日期已获批准' : '当前节点日期按周期推算'}</small></aside></div>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setEvidenceRun(latest)}><FileSearch className="h-3.5 w-3.5" />查看证据</Button>
          {latest.canDecide && !pending && !busy && <>{(['accepted', ...(rec.suggestedDate && rec.suggestedDate !== rec.currentDate ? ['accepted_with_changes'] : []), 'rejected'] as Array<'accepted' | 'accepted_with_changes' | 'rejected'>).map(kind => <Button key={kind} variant="secondary" onClick={() => { setDecision({ run: latest, kind }); setNote(''); setSuggestedDate(rec.suggestedDate ?? '') }}>{kind === 'accepted' ? '采纳建议' : kind === 'accepted_with_changes' ? '调整方案' : '不采用'}</Button>)}</>}
        </div>
      </>}
      {latest.fallbackReason && <p className="text-xs text-slate-500">{latest.fallbackReason === 'SOURCE_CHANGED' ? '运行期间来源发生变化，未发布可执行建议。' : latest.fallbackReason === 'DETERMINISTIC_GATE_PREVAILS' ? '确定性门禁优先，模型不能覆盖。' : latest.status === 'failed' ? '本次运行未完成，可重新发起；没有改变业务状态。' : '模型增强未采用，保留确定性规则结果。'}</p>}
      {latest.decision?.scheduleDraft && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"><strong>已采纳改期草案：{latest.decision.scheduleDraft.suggestedDate}</strong><p className="mt-1">草案不直接改期；提交及批准状态请查看下方节点改期审批。</p></div>}
    </div>}
    {schedule && <FdeAgentSchedulePanel key={refresh} data={schedule} disabled={busy || Boolean(pending)} perform={perform} />}
    {data && data.total > 1 && <details className="mt-4 text-sm"><summary className="cursor-pointer">运行记录（共 {data.total} 条）</summary><div className="mt-2 space-y-2">{data.runs.map(run => <button key={run.id} disabled={!run.readable || !run.recommendation} className="block w-full rounded-lg border p-2 text-left disabled:text-slate-400" onClick={() => setEvidenceRun(run)}>{statuses[run.status]} · {run.recommendation?.title ?? '当前无可见建议'}{run.stale ? ' · 已过期' : ''}</button>)}</div></details>}
    {data && data.total > 10 && <div className="mt-3 flex gap-2"><Button variant="secondary" disabled={page === 1 || busy} onClick={() => setPage(value => value - 1)}>上一页</Button><span>第 {page} 页</span><Button variant="secondary" disabled={page * 10 >= data.total || busy} onClick={() => setPage(value => value + 1)}>下一页</Button></div>}
    {settings && data && <Modal open title="研判设置" onClose={() => { if (!busy) setSettings(null) }}><form className="space-y-4" onSubmit={event => { event.preventDefault(); void perform('/config', { expectedVersion: data.config.version, configuration: settings }) }}>
      {([['enabled', '启用项目研判'], ['analyzeDocuments', '模型可分析授权文件元数据'], ['analyzeCommunications', '模型可分析授权沟通记录'], ['modelEnabled', '启用模型增强（使用现有受控模型配置）']] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings[key]} disabled={busy} onChange={event => setSettings({ ...settings, [key]: event.target.checked })} />{label}</label>)}
      <Button disabled={busy || Boolean(pending)} type="submit">保存设置</Button>
    </form></Modal>}
    {evidenceRun && <Modal open title="研判依据" onClose={() => setEvidenceRun(null)}><p className="mb-3 text-sm">{evidenceRun.recommendation?.rationale}</p><div className="max-h-[60vh] space-y-2 overflow-y-auto">{evidenceRun.evidence.filter(item => evidenceRun.recommendation?.evidenceIds.includes(item.id)).map(item => <div key={item.id} className="rounded-lg border p-3 text-sm"><strong>{item.label}</strong><p className="break-all text-xs text-slate-500">{item.id} · v{item.version}</p></div>)}</div></Modal>}
    {decision && <Modal open title={decision.kind === 'rejected' ? '不采用建议' : decision.kind === 'accepted_with_changes' ? '调整后采纳' : '采纳建议'} onClose={() => { if (!busy) setDecision(null) }}><form className="space-y-4" onSubmit={event => { event.preventDefault(); const rec = decision.run.recommendation!; void perform(`/recommendations/${rec.id}/decision`, { expectedVersion: rec.version, decision: decision.kind, note, ...(decision.kind === 'accepted_with_changes' ? { suggestedDate } : {}) }) }}>
      <p className="text-sm">{decision.run.recommendation?.title}。采纳只记录决定或改期草案，不等于批准。</p>{decision.kind === 'accepted_with_changes' && <label className="block text-sm">调整后的节点日期<input className="mt-1 block w-full rounded border p-2" type="date" required value={suggestedDate} onChange={event => setSuggestedDate(event.target.value)} /></label>}
      <label className="block text-sm">处理说明<textarea className="mt-1 block w-full rounded border p-2" required={decision.kind !== 'accepted'} minLength={decision.kind === 'accepted' ? 0 : 6} maxLength={600} value={note} onChange={event => setNote(event.target.value)} /></label><Button type="submit" disabled={busy || Boolean(pending)}>确认</Button>
    </form></Modal>}
  </Card>
}
