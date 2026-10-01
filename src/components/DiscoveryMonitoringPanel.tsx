import { LoaderCircle, Settings2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { DiscoveryMonitoringPlan } from '../../server/src/contracts/discoveryMonitoringContract'
import { isSystemAdminRole } from '../../server/src/contracts/adminRoleContract'
import { apiGet, apiPatch } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { Modal } from './ui'
import './DiscoveryMonitoringPanel.css'

export function DiscoveryMonitoringPanel() {
  const role = useAuthStore((state) => state.user?.role || '')
  const canManage = isSystemAdminRole(role)
  const [plans, setPlans] = useState<DiscoveryMonitoringPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await apiGet<{ plans: DiscoveryMonitoringPlan[] }>('/discovery/monitoring')
      setPlans(response.plans)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '监测计划读取失败')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const togglePlan = async (plan: DiscoveryMonitoringPlan) => {
    if (busy || !canManage || !plan.ready) return
    setBusy(plan.key)
    setError('')
    try {
      await apiPatch(`/discovery/monitoring/${plan.key}`, { enabled: !plan.enabled })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '监测开关保存失败')
    } finally { setBusy('') }
  }

  const toggleSource = async (id: string, enabled: boolean) => {
    if (busy || !canManage) return
    setBusy(id)
    setError('')
    try {
      await apiPatch(`/operations/radar/sources/${encodeURIComponent(id)}`, { enabled })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '来源开关保存失败')
    } finally { setBusy('') }
  }

  const selectedPlan = plans.find((plan) => plan.key === selected)
  return <section className="discovery-monitoring" aria-label="监测类型与开关">
    <div className="discovery-monitoring-heading">
      <h2><Settings2 aria-hidden="true" />四类监测计划</h2>
      <p>公开来源可按计划运行；未接入连接器保持关闭。总开关会批量修改本类可运行来源，状态保存在服务器。</p>
    </div>
    {error && <p className="discovery-monitoring-error" role="alert">{error} <button type="button" onClick={() => void refresh()}>重试</button></p>}
    {loading ? <p className="discovery-monitoring-loading"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取监测配置…</p> : <div className="discovery-monitoring-grid">
      {plans.map((plan) => <article className="discovery-monitoring-card" key={plan.key}>
        <div className="discovery-monitoring-card-title"><h3>{plan.title}</h3><span className={plan.enabled ? 'is-on' : ''}>{plan.enabled ? '开启' : '关闭'}</span></div>
        <p>{plan.description}</p>
        <div className="discovery-monitoring-schedule">{!plan.schedulerEnabled ? 'Radar 自动调度已暂停' : plan.schedule} · {plan.sourceIds.length ? `${plan.activeSourceCount}/${plan.sourceIds.length} 个来源开启` : '暂无可运行来源'}</div>
        <div className="discovery-monitoring-actions">
          <button type="button" onClick={() => setSelected(plan.key)} aria-label={`配置${plan.title}`}>配置</button>
          <button type="button" className="discovery-monitoring-toggle" aria-pressed={plan.enabled} disabled={!canManage || !plan.ready || Boolean(busy)} onClick={() => void togglePlan(plan)}>
            {busy === plan.key ? '保存中…' : plan.enabled ? '停用' : '启用'}
          </button>
        </div>
      </article>)}
    </div>}
    <Modal open={Boolean(selectedPlan)} title={selectedPlan ? `${selectedPlan.title} · 来源配置` : '来源配置'} onClose={() => setSelected(null)}>
      {selectedPlan && <div className="discovery-monitoring-config">
        <p>{selectedPlan.readinessNote}</p>
        {selectedPlan.sources.length ? <ul>{selectedPlan.sources.map((source) => <li key={source.id}>
          <div><strong>{source.name}</strong><small>{source.config.type} · {source.group}</small></div>
          <button type="button" disabled={!canManage || !selectedPlan.schedulerEnabled || Boolean(busy) || !selectedPlan.sourceIds.includes(source.id)} onClick={() => void toggleSource(source.id, !source.enabled)}>{busy === source.id ? '保存中…' : source.enabled ? '停用' : '启用'}</button>
        </li>)}</ul> : <p className="discovery-monitoring-empty">此类监测尚无已接入的公开来源。</p>}
        {!canManage && <p>仅系统管理员可以修改监测开关。</p>}
      </div>}
    </Modal>
  </section>
}
