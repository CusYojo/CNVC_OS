import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, UserCog } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { FDE_PROJECT_DUTIES, type FdeDutyAssignment, type FdeProjectDuty } from '../../server/src/contracts/fdeGovernanceContract'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { useToast } from './Toast'
import { Badge, Button, Card, Modal } from './ui'
import './fde-workspace.css'

type Person = { id: string; name: string; department: string; categories: string[]; roleCodes: string[] }
type Change = { id: string; status: string; reason: string; requestedBy: string; version: number; requiredConfirmers: string[]; confirmations: Array<{ userId: string; decision: string; comment: string }>; createdAt: string }
type Governance = {
  version: number; ownerUserId: string | null; assignments: FdeDutyAssignment[];
  effectiveLeadership: FdeDutyAssignment[]; roster: Array<{ id: string; name: string; status: string }>;
  eligiblePeople: Person[]; changes: Change[]; capabilities: { canManage: boolean; canSubmitStage: boolean };
}

export function ProjectGovernancePanel({ projectId, onChanged }: { projectId: string; onChanged: () => Promise<void> }) {
  const user = useAuthStore((state) => state.user)
  const { showToast } = useToast()
  const navigate = useNavigate()
  const [data, setData] = useState<Governance | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [ownerId, setOwnerId] = useState('')
  const [assignments, setAssignments] = useState<FdeDutyAssignment[]>([])
  const [reason, setReason] = useState('')
  const [decision, setDecision] = useState<{ change: Change; value: 'confirm' | 'reject' | 'cancel' } | null>(null)
  const [comment, setComment] = useState('')
  const refresh = useCallback(async () => {
    try { setData(await apiGet<Governance>(`/projects/${projectId}/governance`)); setError('') }
    catch (cause) { setError((cause as Error).message) }
  }, [projectId])
  useEffect(() => { void refresh() }, [refresh])
  const name = (id: string) => data?.roster.find((person) => person.id === id)?.name ?? data?.eligiblePeople.find((person) => person.id === id)?.name ?? '账号不可用'
  const pending = data?.changes.find((change) => change.status === 'awaiting_confirmation')
  const openEditor = () => {
    if (!data) return
    setOwnerId(data.ownerUserId ?? '')
    setAssignments(data.assignments.map(({ duty, userId }) => ({ duty, userId })))
    setReason(''); setEditing(true)
  }
  const selectDuty = (duty: FdeProjectDuty, selectedIds: string[]) => {
    setAssignments((current) => {
      const next = [...current.filter((item) => item.duty !== duty), ...selectedIds.filter(Boolean).map((userId) => ({ duty, userId }))]
      if (duty === "executive_lead" && selectedIds[0] && !next.some(item => item.duty === "concerned_leader" && item.userId === selectedIds[0])) {
        next.push({ duty: "concerned_leader", userId: selectedIds[0] })
      }
      return next
    })
  }
  const save = async () => {
    if (!data) return
    setBusy(true)
    try {
      const result = await apiPost<Change>(`/projects/${projectId}/governance/changes`, { ownerUserId: ownerId, assignments, reason, expectedVersion: data.version })
      setEditing(false)
      await onChanged()
      if (result.status === 'applied' && data.ownerUserId === user?.id && ownerId !== user.id && !assignments.some((item) => item.userId === user.id && item.duty !== 'coordinator')) navigate('/projects?view=normal')
      else await refresh()
      showToast(result.status === 'applied' ? '项目职责已保存并写入治理历史' : '已提交相关领导确认；确认前旧参与规则继续有效')
    } catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }
  const decide = async () => {
    if (!decision) return
    setBusy(true)
    try {
      await apiPost(`/projects/${projectId}/governance/changes/${decision.change.id}/decision`, { decision: decision.value, comment, expectedVersion: decision.change.version })
      setDecision(null); await onChanged(); await refresh(); showToast('参与规则决定已记录')
    } catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }

  if (error) return <Card className="p-5 text-sm text-red-600">治理配置加载失败：{error}</Card>
  if (!data) return <Card className="p-5 text-sm text-slate-500">正在读取项目职责与参与规则…</Card>
  return <div className="fde-workspace"><Card className="fde-panel p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">组织与项目职责 <Badge>治理 V{data.version}</Badge></h2>{data.capabilities.canManage && <Button variant="secondary" disabled={Boolean(pending)} onClick={openEditor}><UserCog className="h-4 w-4" />配置项目职责</Button>}</div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><div className="rounded-lg border border-slate-200 p-3"><p className="text-xs text-slate-500">项目负责人</p><p className="mt-2 text-sm font-semibold">{data.ownerUserId ? name(data.ownerUserId) : '未配置'}</p></div>{FDE_PROJECT_DUTIES.map((duty) => {
      const explicit = data.assignments.filter((item) => item.duty === duty.code)
      const effective = explicit.length ? explicit : data.effectiveLeadership.filter((item) => item.duty === duty.code)
      return <div key={duty.code} className="rounded-lg border border-slate-200 p-3"><p className="text-xs text-slate-500">{duty.label}</p><p className="mt-2 text-sm font-medium">{effective.length ? effective.map((item) => name(item.userId)).join('、') : '未配置'}</p>{!explicit.length && effective.length > 0 && <p className="mt-1 text-xs text-slate-400">使用机构角色配置</p>}</div>
    })}</div>
    {pending && <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-amber-700" /><strong className="text-sm text-amber-900">参与规则变更等待确认，旧规则仍有效</strong></div><p className="mt-2 text-xs text-amber-800">{pending.reason}</p><p className="mt-2 text-xs text-amber-800">待确认领导：{pending.requiredConfirmers.filter((id) => !pending.confirmations.some((item) => item.userId === id)).map(name).join('、')}</p><div className="mt-3 flex gap-2">{pending.requiredConfirmers.includes(user?.id ?? '') && !pending.confirmations.some((item) => item.userId === user?.id) && <><Button onClick={() => { setComment(''); setDecision({ change: pending, value: 'confirm' }) }}>确认变更</Button><Button variant="secondary" onClick={() => { setComment(''); setDecision({ change: pending, value: 'reject' }) }}>不同意</Button></>}{pending.requestedBy === user?.id && <Button variant="secondary" onClick={() => { setComment(''); setDecision({ change: pending, value: 'cancel' }) }}>撤回申请</Button>}</div></div>}
    {data.changes.length > 0 && <details className="mt-5 rounded-lg bg-slate-50 p-4"><summary className="cursor-pointer text-sm font-medium">治理与参与规则历史（{data.changes.length}）</summary><div className="mt-3 space-y-3">{data.changes.map((change) => <div key={change.id} className="border-b border-slate-200 pb-3 text-xs last:border-0"><Badge tone={change.status === 'applied' ? 'green' : change.status === 'awaiting_confirmation' ? 'amber' : 'slate'}>{{ applied: '已生效', awaiting_confirmation: '待确认', rejected: '已拒绝', cancelled: '已撤回' }[change.status] ?? change.status}</Badge><p className="mt-2">{change.reason}</p><p className="mt-1 text-slate-500">{name(change.requestedBy)} · {change.createdAt}</p>{change.confirmations.map((item) => <p key={item.userId} className="mt-1 text-slate-500">{name(item.userId)}：{item.comment}</p>)}</div>)}</div></details>}
  </Card>
  <Modal open={editing} onClose={() => setEditing(false)} title="配置项目组织与职责" width="max-w-4xl" footer={<><Button variant="secondary" onClick={() => setEditing(false)}>取消</Button><Button loading={busy} disabled={!ownerId || reason.trim().length < 5} onClick={() => { void save() }}>提交职责变更</Button></>}>
    <p className="mb-4 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">移除已有关注领导、牵头领导、董事长或总裁参与职责时，必须由相关领导确认后生效。仅分配时间协调人不会授予完整项目内容权限。</p>
    <label><span className="label">项目负责人</span><select className="input" value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>{data.eligiblePeople.filter((person) => person.categories.some((category) => ['institution_leader', 'project_lead', 'member'].includes(category))).map((person) => <option key={person.id} value={person.id}>{person.name} · {person.department}</option>)}</select></label>
    <div className="mt-4 space-y-4">{FDE_PROJECT_DUTIES.map((duty) => {
      const candidates = data.eligiblePeople.filter((person) => person.categories.some((category) => (duty.eligible as readonly string[]).includes(category)) && (duty.code !== 'chairman' || person.roleCodes.includes('FDE_CHAIRMAN')) && (duty.code !== 'president' || person.roleCodes.includes('FDE_PRESIDENT')))
      const selectedIds = duty.code === "executive_lead"
        ? assignments.filter(item => item.duty === duty.code).map(item => item.userId)
        : assignments.filter(item => item.duty === duty.code).map(item => item.userId)
      return (
        <fieldset key={duty.code} className="rounded-xl border border-slate-200 bg-white p-3">
          <legend className="px-1 text-sm font-semibold text-slate-800">
            {duty.label}
            <span className="ml-2 text-xs font-normal text-slate-400">
              {duty.code === "executive_lead" ? "单选，同时纳入关注领导" : "可多选"}
            </span>
          </legend>
          {candidates.length === 0 && <p className="py-2 text-xs text-slate-400">暂无符合条件的人员</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {candidates.map((person) => {
              const isSelected = selectedIds.includes(person.id)
              return (
                <label
                  key={person.id}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
                    isSelected ? 'bg-brand-50 text-brand-800 border border-brand-200' : 'bg-slate-50 hover:bg-slate-100 border border-transparent'
                  }`}
                >
                  <input
                    type={duty.code === "executive_lead" ? "radio" : "checkbox"}
                    name={duty.code === "executive_lead" ? duty.code : undefined}
                    checked={isSelected}
                    onChange={() => selectDuty(duty.code, duty.code === "executive_lead"
                      ? [person.id]
                      : isSelected
                        ? selectedIds.filter(id => id !== person.id)
                        : [...selectedIds, person.id]
                    )}
                    className="sr-only"
                  />
                  <span className="font-medium">{person.name}</span>
                  <span className="text-xs text-slate-400">{person.department}</span>
                </label>
              )
            })}
          </div>
        </fieldset>
      )
    })}</div>
    <label className="mt-4 block"><span className="label">变更理由</span><textarea className="textarea min-h-24" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明职责调整和交接安排，至少 5 字" /></label>
  </Modal>
  <Modal open={Boolean(decision)} onClose={() => setDecision(null)} title="确认参与规则决定" footer={<><Button variant="secondary" onClick={() => setDecision(null)}>取消</Button><Button loading={busy} disabled={comment.trim().length < 2} onClick={() => { void decide() }}>记录决定</Button></>}><p className="mb-3 text-sm text-slate-600">{decision?.change.reason}</p><textarea className="textarea min-h-24" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="填写确认、拒绝或撤回理由" /></Modal>
  </div>
}
