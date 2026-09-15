import { useCallback, useEffect, useState } from 'react'
import { FilePlus2, LockKeyhole, RefreshCw, Save } from 'lucide-react'
import { fdeWorkflowPolicySchema, type FdeWorkflowPolicyConfig } from '../../server/src/contracts/fdeWorkflowPolicyContract'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { formatShanghaiDateTime } from '../lib/dateTime'
import { useToast } from './Toast'
import { Badge, Button, Card, Modal } from './ui'

type PolicyVersion = { id: string; revision: number; status: string; version: number; reason: string; configuration: FdeWorkflowPolicyConfig; configurationValid: boolean; sha256: string; boundProjects: number; publishedAt: string | null }
type Policy = { id: string; name: string; code: string; activeVersionId: string | null; version: number; enabled: boolean; versions: PolicyVersion[] }
type Action = { kind: 'clone' | 'publish' | 'toggle'; policy: Policy; version?: PolicyVersion }

export function FdePolicyPanel() {
  const { showToast } = useToast()
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<PolicyVersion | null>(null)
  const [configuration, setConfiguration] = useState<FdeWorkflowPolicyConfig | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [reason, setReason] = useState('')
  const [selectedStage, setSelectedStage] = useState(0)
  const refresh = useCallback(async () => {
    setLoading(true)
    try { const rows = await apiGet<Policy[]>('/system-administration/fde-policies'); setPolicies(rows); setError(''); return rows }
    catch (cause) { setError((cause as Error).message); return [] }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const open = (version: PolicyVersion) => { setEditing(version); setConfiguration(structuredClone(version.configuration)); setSelectedStage(0); setReason(version.reason) }
  const editable = editing?.status === 'draft'
  const updateStage = (patch: Partial<FdeWorkflowPolicyConfig['stages'][number]>) => {
    if (!configuration) return
    setConfiguration({ ...configuration, stages: configuration.stages.map((stage, index) => index === selectedStage ? { ...stage, ...patch } : stage) })
  }
  const save = async () => {
    if (!configuration || !editing) return
    const parsed = fdeWorkflowPolicySchema.safeParse(configuration)
    if (!parsed.success) { showToast(parsed.error.issues.map((issue) => issue.message).join('；'), 'error'); return }
    setBusy(true)
    try {
      await apiPatch(`/system-administration/fde-policy-versions/${editing.id}`, { configuration: parsed.data, reason, expectedVersion: editing.version })
      setEditing(null); await refresh(); showToast('草稿已保存；未发布前不影响项目')
    } catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }
  const execute = async () => {
    if (!action) return
    setBusy(true)
    try {
      if (action.kind === 'clone') {
        const created = await apiPost<{ id: string }>(`/system-administration/fde-policies/${action.policy.id}/drafts`, { sourceVersionId: action.version!.id, expectedVersion: action.policy.version, reason })
        const rows = await refresh()
        const draft = rows.flatMap((policy) => policy.versions).find((version) => version.id === created.id)
        if (draft) open(draft)
      } else if (action.kind === 'publish') {
        await apiPost(`/system-administration/fde-policies/${action.policy.id}/publish`, { versionId: action.version!.id, expectedPolicyVersion: action.policy.version, expectedDraftVersion: action.version!.version, reason })
        await refresh(); showToast('新版本已发布；仅用于之后创建的项目，在途项目保持原版本')
      } else {
        await apiPatch(`/system-administration/fde-policies/${action.policy.id}`, { enabled: !action.policy.enabled, expectedVersion: action.policy.version, reason })
        await refresh(); showToast('模板状态已更新，在途项目不受影响')
      }
      setAction(null)
    } catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }
  const stage = configuration?.stages[selectedStage]
  return <div className="space-y-4">
    <div className="flex justify-end"><Button variant="secondary" loading={loading} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" />刷新规则</Button></div>
    {error && <Card className="p-5 text-sm text-red-600">规则读取失败：{error}</Card>}
    {!loading && !error && !policies.length && <Card className="p-5 text-sm text-slate-500">暂无规则模板</Card>}
    {policies.map((policy) => <Card className="fde-panel p-5" key={policy.id}>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{policy.name} <Badge tone={policy.enabled ? 'green' : 'slate'}>{policy.enabled ? '启用' : '停用'}</Badge></h2><p className="mt-2 text-xs text-slate-500">生效版本 V{policy.versions.find((version) => version.id === policy.activeVersionId)?.revision ?? '—'} · {policy.code}</p></div><Button variant="secondary" onClick={() => { setReason(''); setAction({ kind: 'toggle', policy }) }}>{policy.enabled ? '停用新项目使用' : '启用模板'}</Button></div>
      <div className="mt-5 space-y-3">{policy.versions.map((version) => <div key={version.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-4"><div className="min-w-0 flex-1"><p className="text-sm font-medium">V{version.revision} <Badge tone={version.status === 'draft' ? 'amber' : 'green'}>{version.status === 'draft' ? '草稿' : version.id === policy.activeVersionId ? '当前发布' : '历史发布'}</Badge>{!version.configurationValid && <Badge tone="amber">旧格式，仅审计</Badge>}</p><p className="mt-2 text-xs text-slate-500">{version.reason}</p><p className="mt-1 text-xs text-slate-400">绑定项目 {version.boundProjects} 个{version.publishedAt ? ` · ${formatShanghaiDateTime(version.publishedAt)}` : ''}</p></div><Button variant="secondary" disabled={!version.configurationValid} onClick={() => open(version)}>{version.status === 'draft' ? '编辑草稿' : '查看规则'}</Button><Button variant="secondary" disabled={!version.configurationValid} onClick={() => { setReason(''); setAction({ kind: 'clone', policy, version }) }}><FilePlus2 className="h-4 w-4" />基于此版新建</Button>{version.status === 'draft' && <Button disabled={!version.configurationValid} onClick={() => { setReason(''); setAction({ kind: 'publish', policy, version }) }}>预览并发布</Button>}</div>)}</div>
    </Card>)}
    <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`投资流程规则 V${editing?.revision ?? ''}${editable ? ' · 草稿' : ' · 只读'}`} width="max-w-5xl" footer={<><Button variant="secondary" onClick={() => setEditing(null)}>关闭</Button>{editable && <Button loading={busy} disabled={reason.trim().length < 5} onClick={() => void save()}><Save className="h-4 w-4" />保存草稿</Button>}</>}>
      {configuration && stage && <div className="space-y-5">
        {!editable && <p className="flex items-center gap-2 text-xs text-slate-500"><LockKeyhole className="h-4 w-4" />已发布版本不可直接修改，请基于此版本新建草稿。</p>}
        <div><span className="label">允许的倒排周期</span><div className="flex gap-5">{([15, 30, 40] as const).map((days) => <label key={days} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!editable} checked={configuration.cycleDays.includes(days)} onChange={() => setConfiguration({ ...configuration, cycleDays: configuration.cycleDays.includes(days) ? configuration.cycleDays.filter((value) => value !== days) : [...configuration.cycleDays, days].sort((a, b) => a - b) })} />{days} 天</label>)}</div></div>
        <div className="fde-workspace-tabs">{configuration.stages.map((item, index) => <button key={item.stage} className={selectedStage === index ? 'active' : ''} onClick={() => setSelectedStage(index)}>{item.stage}</button>)}</div>
        <div className="flex flex-wrap gap-6"><label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!editable} checked={stage.allowWaiver} onChange={(event) => updateStage({ allowWaiver: event.target.checked })} />允许负责人填写材料免传说明</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!editable || stage.stage === '内核'} checked={stage.requiresFund} onChange={(event) => updateStage({ requiresFund: event.target.checked })} />必须明确投资基金</label></div>
        <section><h3 className="mb-3 text-sm font-semibold">必需材料</h3>{stage.materials.map((material, index) => <div key={index} className="mb-2 grid gap-2 sm:grid-cols-2"><input className="input" aria-label="材料编号" disabled={!editable} value={material.key} onChange={(event) => updateStage({ materials: stage.materials.map((item, i) => i === index ? { ...item, key: event.target.value } : item) })} /><input className="input" aria-label="材料名称" disabled={!editable} value={material.label} onChange={(event) => updateStage({ materials: stage.materials.map((item, i) => i === index ? { ...item, label: event.target.value } : item) })} /></div>)}{editable && <Button variant="secondary" onClick={() => updateStage({ materials: [...stage.materials, { key: `extra_material_${stage.materials.length + 1}`, label: '新增必需材料' }] })}>新增材料要求</Button>}<p className="mt-2 text-xs text-slate-400">基线材料编号不可移除；名称及新增材料按发布版本生效。</p></section>
        <section><h3 className="mb-3 text-sm font-semibold">审批节点（顺序执行，节点内按会签/或签处理）</h3>{stage.approvals.map((node, index) => <div key={node.duty} className="mb-2 flex flex-wrap items-center gap-2"><Badge>{index + 1} · {node.duty}</Badge><input className="input min-w-48 flex-1" aria-label="审批节点名称" disabled={!editable} value={node.name} onChange={(event) => updateStage({ approvals: stage.approvals.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} /><select className="input w-28" aria-label="审批方式" disabled={!editable} value={node.mode} onChange={(event) => updateStage({ approvals: stage.approvals.map((item, i) => i === index ? { ...item, mode: event.target.value as '会签' | '或签' } : item) })}><option>会签</option><option>或签</option></select></div>)}{!stage.approvals.length && <p className="text-xs text-slate-500">本阶段不单独配置审批人；计划审核沿用制定提交时冻结的节点。</p>}</section>
        {editable && <label className="block"><span className="label">修订理由</span><textarea className="textarea min-h-20" value={reason} onChange={(event) => setReason(event.target.value)} /></label>}
      </div>}
    </Modal>
    <Modal open={Boolean(action)} onClose={() => setAction(null)} title={action?.kind === 'publish' ? '发布影响预览与确认' : action?.kind === 'clone' ? '创建新规则草稿' : '变更模板启用状态'} footer={<><Button variant="secondary" onClick={() => setAction(null)}>取消</Button><Button loading={busy} disabled={reason.trim().length < 5} onClick={() => void execute()}>确认{action?.kind === 'publish' ? '发布' : action?.kind === 'clone' ? '创建' : '变更'}</Button></>}>
      <div className="mb-4 rounded-lg bg-amber-50 p-4 text-sm leading-6 text-amber-900">{action?.kind === 'publish' ? `将 V${action.version?.revision} 设为新项目默认规则；现有 ${action.policy.versions.reduce((total, version) => total + version.boundProjects, 0)} 个已绑定项目不迁移、不重算。发布后此版本不可再修改。` : action?.kind === 'toggle' ? '停用将阻止新项目使用此模板，已有项目仍按原版本推进。' : '新草稿不会自动启用，需要校验和单独发布。'}</div>
      {action?.kind === 'publish' && <div className="mb-4 space-y-2 text-xs text-slate-600">{action.version?.configuration.stages.map((item) => <p key={item.stage}>{item.stage}：{item.materials.length} 项必需材料 · {item.allowWaiver ? '可免传' : '不可免传'} · {item.approvals.map((node) => `${node.name}(${node.mode})`).join(' → ') || '无独立审批节点'}</p>)}</div>}
      <label><span className="label">变更理由（至少 5 字）</span><textarea className="textarea min-h-24" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    </Modal>
  </div>
}
