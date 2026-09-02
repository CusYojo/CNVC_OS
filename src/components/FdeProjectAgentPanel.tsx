import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, Sparkles } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { Badge, Button, Card } from './ui'
import { useToast } from './Toast'
import type { ProjectAgentDashboard } from '../../server/src/contracts/fdeProjectAgentContract'
import { shortProjectDate } from '../lib/projectDetailPresentation'
import './fde-workspace.css'

const progressLabels: Record<string, string> = {
  on_track: '正常推进',
  needs_information: '信息待补充',
  blocked: '推进受阻',
  at_risk: '存在改期风险',
  waiting_approval: '等待审批',
  overdue: '已逾期',
}

export function FdeProjectAgentPanel({ projectId, onChanged }: { projectId: string; onChanged?: () => Promise<void> }) {
  const userId = useAuthStore(state => state.user?.id ?? '')
  return <ProgressAssessment key={`${userId}:${projectId}`} projectId={projectId} onChanged={onChanged} />
}

function ProgressAssessment({ projectId, onChanged }: { projectId: string; onChanged?: () => Promise<void> }) {
  const endpoint = `/projects/${projectId}/project-agent`
  const { showToast } = useToast()
  const [data, setData] = useState<ProjectAgentDashboard | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const autoStarted = useRef(false)

  const load = async () => {
    const next = await apiGet<ProjectAgentDashboard>(`${endpoint}?page=1&pageSize=1`)
    setData(next)
    setError('')
    return next
  }

  const assess = async (current: ProjectAgentDashboard, automatic = false) => {
    if (busy || !current.capabilities.run) return
    setBusy(true)
    try {
      await apiPost(`${endpoint}/runs`, { clientRequestId: crypto.randomUUID(), expectedConfigVersion: current.config.version })
      await load()
      await onChanged?.().catch(() => {})
      if (!automatic) showToast('推进风险已更新')
    } catch (cause) {
      const message = (cause as Error).message
      setError(message)
      if (!automatic) showToast(message, 'error')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setData(null); setError(''); autoStarted.current = false
    void apiGet<ProjectAgentDashboard>(`${endpoint}?page=1&pageSize=1`).then(value => {
      if (!cancelled) setData(value)
    }).catch(cause => { if (!cancelled) setError((cause as Error).message) })
    return () => { cancelled = true }
  }, [endpoint])

  useEffect(() => {
    const latest = data?.runs[0]
    if (!data || autoStarted.current || !data.capabilities.run || latest && !latest.stale && latest.status === 'succeeded') return
    autoStarted.current = true
    void assess(data, true)
  }, [data])

  const latest = data?.runs[0]
  const recommendation = latest?.readable ? latest.recommendation : null
  const progress = recommendation ? progressLabels[recommendation.health] ?? '需要关注' : latest?.status === 'running' || busy ? '评估中' : '等待评估'
  const rescheduleRisk = recommendation && (['delay', 'escalate'].includes(recommendation.action) || ['at_risk', 'overdue'].includes(recommendation.health))
  const tone = recommendation?.severity === 'critical' ? 'red' : recommendation?.severity === 'warning' ? 'amber' : recommendation ? 'green' : 'slate'

  return <Card className="fde-workspace fde-detail-agent min-w-0 border-[#dfe6e4]" data-testid="fde-project-agent">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><div className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-[#315f68]" /><h2 className="font-semibold">推进研判</h2></div><p className="mt-1 text-xs text-slate-500">综合阶段、任务、审批和节点日期自动评估</p></div>
      <Button variant="secondary" disabled={busy || !data?.capabilities.run} onClick={() => data && void assess(data)}><RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />更新研判</Button>
    </div>
    {error && <p role="alert" className="text-sm text-red-700">研判暂时不可用：{error}</p>}
    {!data && !error && <p className="text-sm text-slate-500">正在评估项目推进情况…</p>}
    {data && <div className="fde-progress-assessment">
      <section className={`fde-progress-assessment-status ${tone}`}>
        {rescheduleRisk ? <AlertTriangle /> : recommendation ? <CheckCircle2 /> : <RefreshCw className={busy ? 'animate-spin' : ''} />}
        <div><span>当前推进状态</span><strong>{progress}</strong></div>
        <Badge tone={tone}>{rescheduleRisk ? '改期风险较高' : recommendation ? '暂无明显改期风险' : '正在更新'}</Badge>
      </section>
      {recommendation && <div className="fde-progress-assessment-detail">
        <div><span>评估结论</span><strong>{recommendation.title}</strong><p>{recommendation.summary}</p></div>
        <dl>
          <div><dt>当前节点日期</dt><dd>{shortProjectDate(recommendation.currentDate)}</dd></div>
          <div><dt>{rescheduleRisk ? '建议关注日期' : '日期判断'}</dt><dd>{rescheduleRisk && recommendation.suggestedDate ? shortProjectDate(recommendation.suggestedDate) : '维持当前计划'}</dd></div>
          <div><dt>更新时间</dt><dd>{latest?.startedAt ? new Date(latest.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'}</dd></div>
        </dl>
      </div>}
      {data && !recommendation && !busy && !error && <p className="fde-detail-empty">暂无有效研判结果，可点击“更新研判”重新评估。</p>}
    </div>}
  </Card>
}
