import { useEffect, useRef, useState } from 'react'
import { officeFieldNames, officeKinds, officePolicyConfig, type OfficePolicy } from '../../server/src/contracts/fdeOfficeContract'
import { apiGet, apiPost } from '../lib/api'
import { Badge, Button, Card, Modal } from './ui'
import { useAuthStore } from '../store/useAuthStore'
import { officeWriteResultUnknown } from '../lib/fdeOfficeRecovery'
import { FdeOfficeExecutionPolicyEditor } from './FdeOfficeExecutionPolicyEditor'
import { forgetPolicyPending, policyCommandPath, policyRecoveryKey, policyResolvedResult, policyWriteReceipt, readPolicyPending, rememberPolicyPending, type PolicyPending } from '../lib/fdeOfficePolicyRecovery'

type Version = { id: string; revision: number; version: number; status: string; configuration: OfficePolicy; reason: string }
type Head = { id: string; kind: string; enabled: boolean; version: number; activeVersionId: string | null; versions: Version[] }
type Option = { id: string; name: string; status: string; fdeCategory?: string | null }
const apiRoot = '/system-administration'
const empty = (kind: typeof officeKinds[number]): OfficePolicy => ({ kind, requiredFields: [], attachmentRequired: false, rejectResubmission: false, routes: [{ key: 'default', when: {}, nodes: [{ key: 'review', name: '', roleIds: [], scope: 'applicant_department', mode: '或签', fixedUserIds: [], allowTransfer: false }] }] })
export function FdeOfficePolicyPanel() {
  const userId = useAuthStore(state => state.user?.id ?? ''), identity = useRef({ userId, generation: 0 })
  if (identity.current.userId !== userId) identity.current = { userId, generation: identity.current.generation + 1 }
  const busyRef = useRef(false), loadSequence = useRef(0), generation = identity.current.generation
  const [pending, setPending] = useState<PolicyPending | null>(null), [storageError, setStorageError] = useState(''), [notice, setNotice] = useState(''), [ready, setReady] = useState(false)
  const [visibleFor, setVisibleFor] = useState<string | null>(null)
  const current = () => identity.current.userId === userId && identity.current.generation === generation
  const key = policyRecoveryKey(userId)
  const [heads, setHeads] = useState<Head[]>([]), [roles, setRoles] = useState<Option[]>([]), [departments, setDepartments] = useState<Option[]>([]), [people, setPeople] = useState<{ id: string; name: string; role: string }[]>([])
  const [edit, setEdit] = useState<Version | null>(null), [configuration, setConfiguration] = useState<OfficePolicy>(empty('出差')), [reason, setReason] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ head: Head; version?: Version } | null>(null)
  const refresh = async () => {
    const sequence = ++loadSequence.current
    const [list, admin, userResult] = await Promise.all([apiGet<Head[]>(`${apiRoot}/office-policies`), apiGet<{ roles: Option[]; departments: Option[] }>(apiRoot), apiGet<{ list: { id: string; name: string; role: string }[] }>('/users')])
    if (!current() || sequence !== loadSequence.current) return
    setHeads(list); setRoles(admin.roles.filter(r => r.status === '启用' && r.fdeCategory && r.fdeCategory !== 'system_admin')); setDepartments(admin.departments.filter(d => d.status === '启用')); setPeople(userResult.list)
  }
  const work = async (fn: () => Promise<void>) => { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(''); try { await fn() } catch (e) { if (current()) setError((e as Error).message) } finally { if (current()) { busyRef.current = false; setBusy(false) } } }
  useEffect(() => {
    setVisibleFor(userId)
    setHeads([]); setRoles([]); setPeople([]); setDepartments([]); setEdit(null); setConfirm(null); setPending(null); setNotice(''); setStorageError(''); setReady(false); busyRef.current = false; setBusy(false)
    try { setPending(readPolicyPending(sessionStorage, key)); setReady(true) } catch { setStorageError('无法读取规则恢复标识；请恢复浏览器存储或联系管理员核对，不能直接重新提交。') }
    void work(refresh)
    return () => { ++loadSequence.current }
  }, [userId])
  const blocked = !ready || Boolean(pending) || Boolean(storageError)
  const clear = (marker: PolicyPending) => {
    if (!current()) throw new Error('账号已切换，请在原账号核对规则操作')
    try { forgetPolicyPending(sessionStorage, key, marker); setPending(null) }
    catch (cause) { setStorageError('不能清理恢复标识，请核对原命令后再继续'); throw cause }
  }
  const resolve = async (marker: PolicyPending) => policyResolvedResult(await apiPost(`${apiRoot}/office-policy-commands/resolve`, marker), marker)
  const perform = async (id: string, action: PolicyPending['action'], body: Record<string, unknown>) => {
    if (blocked || readPolicyPending(sessionStorage, key)) throw new Error('请先核对上一笔规则操作')
    const marker = { id, action, clientRequestId: crypto.randomUUID() }
    rememberPolicyPending(sessionStorage, key, marker); setPending(marker); setNotice('')
    try { policyWriteReceipt(await apiPost(policyCommandPath(marker), { ...body, clientRequestId: marker.clientRequestId }), marker) }
    catch (cause) {
      if (officeWriteResultUnknown(cause) || !current()) throw cause
      const result = await resolve(marker)
      if (result.state === 'not_applied') { clear(marker); throw cause }
    }
    clear(marker)
  }
  const recover = () => work(async () => {
    const marker = readPolicyPending(sessionStorage, key)
    if (!marker) throw new Error('未找到恢复标识，请刷新核对')
    const result = await resolve(marker); clear(marker); setEdit(null); setConfirm(null)
    setNotice(result.state === 'committed' ? '原规则操作已提交，未重复执行；当前规则修订号与状态以下方列表为准。' : '原规则操作未提交，旧命令已封闭。请核对最新规则后重新确认。')
    await refresh()
  })
  const open = (version?: Version, kind: typeof officeKinds[number] = '出差', clone = false) => { if (busyRef.current || blocked) return; const config = version ? structuredClone(version.configuration) : empty(kind); setNotice(''); setConfiguration(config); setReason(''); setEdit(version && !clone ? version : { id: crypto.randomUUID(), revision: 0, version: 0, status: 'draft', configuration: config, reason: '' }) }
  const writable = edit?.status === 'draft'
  const routeChange = (i: number, patch: Partial<OfficePolicy['routes'][number]>) => setConfiguration(c => ({ ...c, routes: c.routes.map((r, n) => n === i ? { ...r, ...patch } : r) }))
  if (visibleFor !== userId) return <p className="p-4 text-sm text-slate-500">正在核对当前账号的规则权限…</p>
  return <div className="space-y-4"><Card className="fde-panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">通用 OA 类型与审批规则</h2><div className="flex flex-wrap gap-2">{officeKinds.map(kind => <Button key={kind} variant="secondary" disabled={busy || blocked} onClick={() => open(undefined, kind)}>新建{kind}规则草稿</Button>)}<Button variant="secondary" disabled={busy} onClick={() => void work(refresh)}>刷新</Button></div></div></Card>
    {error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
    {storageError && <p role="alert" className="p-3 text-sm text-red-700">{storageError}</p>}
    {notice && <p role="status" className="p-3 text-sm text-[#315f68]">{notice}</p>}
    {pending && <Card className="p-4"><p className="mb-3 text-sm">上一笔规则操作结果待核对；核对前不能发起新写入，刷新不会丢失原请求编号。</p><Button disabled={busy || Boolean(storageError)} onClick={() => void recover()}>核对上一笔规则操作</Button></Card>}
    {heads.map(head => <Card key={head.id} className="fde-panel p-5"><div className="flex items-center justify-between"><h3 className="font-semibold">{head.kind} <Badge tone={head.enabled ? 'green' : 'slate'}>{head.enabled ? '已启用' : '未启用'}</Badge></h3><Button variant="secondary" disabled={busy || blocked || !head.activeVersionId} onClick={() => { setConfirm({ head }); setReason('') }}>{head.enabled ? '停用新提交' : '启用已发布规则'}</Button></div>{head.versions.map(version => <div key={version.id} className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border p-4"><div className="flex-1"><p className="text-sm">V{version.revision} · {version.status === 'draft' ? '草稿' : version.id === head.activeVersionId ? '当前发布' : '历史发布'}</p><p className="mt-1 text-xs text-slate-500">{version.reason}</p></div><Button variant="secondary" onClick={() => open(version)}>{version.status === 'draft' ? '编辑草稿' : '查看规则'}</Button><Button variant="secondary" onClick={() => open(version, version.configuration.kind, true)}>基于此版新建</Button>{version.status === 'draft' && <Button disabled={busy || blocked} onClick={() => { setConfirm({ head, version }); setReason('') }}>预览并发布</Button>}</div>)}</Card>)}
    <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title={`${configuration.kind}审批规则 · ${writable ? '草稿' : '只读版本'}`} width="max-w-5xl" footer={<><Button variant="secondary" onClick={() => setEdit(null)}>关闭</Button>{writable && <Button disabled={busy || blocked || reason.trim().length < 5} onClick={() => void work(async () => { const config = officePolicyConfig.parse(configuration); await perform(edit!.id, 'save', { expectedVersion: edit!.version, configuration: config, reason }); setEdit(null); await refresh() })}>校验并保存草稿</Button>}</>}>
      {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}<fieldset disabled={!writable || busy || blocked} className="space-y-5"><section><h3 className="text-sm font-semibold">本类型必填字段</h3><div className="mt-3 flex flex-wrap gap-4">{officeFieldNames[configuration.kind].map(key => <label key={key} className="text-sm"><input type="checkbox" checked={configuration.requiredFields.includes(key)} onChange={e => setConfiguration({ ...configuration, requiredFields: e.target.checked ? [...configuration.requiredFields, key] : configuration.requiredFields.filter(k => k !== key) })} /> {{travelerIds: "出差人", startDate: "开始日期", endDate: "结束日期", destination: "目的地", budget: "预算", currency: "币种", entity: "申请主体", sealType: "印章类型", purpose: "用途", copies: "份数", handlerId: "经办人", amount: "金额", items: "费用明细", leaveType: "假别", startAt: "开始时刻", endAt: "结束时刻", hours: "请假小时数", counterparty: "合同相对方", documentVersion: "合同版本"}[key] ?? key}</label>)}</div><div className="mt-4 flex flex-wrap gap-4"><label className="text-sm"><input type="checkbox" checked={configuration.attachmentRequired} onChange={e => setConfiguration({ ...configuration, attachmentRequired: e.target.checked })} /> 必须有送审原件</label><label className="text-sm"><input type="checkbox" checked={configuration.rejectResubmission} onChange={e => setConfiguration({ ...configuration, rejectResubmission: e.target.checked })} /> 拒绝后允许新修订重提</label></div></section>
      <FdeOfficeExecutionPolicyEditor kind={configuration.kind} value={configuration.execution} roles={roles} people={people} onChange={execution => { const next = { ...configuration }; if (execution) next.execution = execution; else delete next.execution; setConfiguration(next) }} />
      <p className="text-xs text-slate-500">路由按显示顺序首条命中；最后一条必须是无条件规则。金额不跨币种换算；同一人不会兼任多个节点，缺岗将阻止提交。</p>
      {configuration.routes.map((route, i) => <section key={i} className="space-y-3 rounded-xl border p-4"><div className="flex gap-3"><label className="flex-1"><span className="label">路由标识</span><input className="input" value={route.key} onChange={e => routeChange(i, { key: e.target.value })} /></label>{i < configuration.routes.length - 1 && <Button variant="secondary" onClick={() => setConfiguration({ ...configuration, routes: configuration.routes.filter((_, n) => n !== i) })}>移除路由</Button>}</div>{i < configuration.routes.length - 1 && <div className="grid gap-3 sm:grid-cols-3">{(['currency', 'minimum', 'maximum'] as const).map(key => <label key={key}><span className="label">{{ currency: '币种', minimum: '最低金额（含）', maximum: '最高金额（含）' }[key]}</span><input className="input" value={route.when[key] ?? ''} onChange={e => { const next = { ...route.when }; if (e.target.value) next[key] = e.target.value; else delete next[key]; routeChange(i, { when: next }) }} /></label>)}<label><span className="label">限定部门（空选不限）</span><select multiple className="input h-24" value={route.when.departmentIds ?? []} onChange={e => { const ids = [...e.target.selectedOptions].map(o => o.value), next = { ...route.when }; if (ids.length) next.departmentIds = ids; else delete next.departmentIds; routeChange(i, { when: next }) }}>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><label><span className="label">紧急程度（空选不限）</span><select multiple className="input h-24" value={route.when.priorities ?? []} onChange={e => { const values = [...e.target.selectedOptions].map(o => o.value) as NonNullable<typeof route.when.priorities>, next = { ...route.when }; if (values.length) next.priorities = values; else delete next.priorities; routeChange(i, { when: next }) }}><option>普通</option><option>重要</option><option>紧急</option></select></label></div>}
        {route.nodes.map((node, ni) => { const update = (patch: Partial<typeof node>) => routeChange(i, { nodes: route.nodes.map((n, k) => k === ni ? { ...n, ...patch } : n) }); return <div key={ni} className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2"><label><span className="label">节点 {ni + 1} 标识</span><input className="input" value={node.key} onChange={e => update({ key: e.target.value })} /></label><label><span className="label">节点名称</span><input className="input" value={node.name} onChange={e => update({ name: e.target.value })} /></label><label><span className="label">有效审批岗位（多选）</span><select multiple className="input h-28" value={node.roleIds} onChange={e => update({ roleIds: [...e.target.selectedOptions].map(o => o.value) })}>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><label><span className="label">限定账号（空选使用有效岗位人员）</span><select multiple className="input h-28" value={node.fixedUserIds} onChange={e => update({ fixedUserIds: [...e.target.selectedOptions].map(o => o.value) })}>{people.map(p => <option key={p.id} value={p.id}>{p.name} · {p.role}</option>)}</select></label><label><span className="label">组织范围</span><select className="input" value={node.scope} onChange={e => update({ scope: e.target.value as typeof node.scope })}><option value="applicant_department">申请人所属部门</option><option value="institution">机构内</option></select></label><label><span className="label">签批方式</span><select className="input" value={node.mode} onChange={e => update({ mode: e.target.value as typeof node.mode })}><option>或签</option><option>会签</option></select></label><label className="text-sm"><input type="checkbox" checked={node.allowTransfer} onChange={e => update({ allowTransfer: e.target.checked })} /> 允许同岗位受控转交</label><Button variant="secondary" disabled={route.nodes.length === 1} onClick={() => routeChange(i, { nodes: route.nodes.filter((_, n) => n !== ni) })}>移除此节点</Button></div> })}<Button variant="secondary" onClick={() => routeChange(i, { nodes: [...route.nodes, { ...empty(configuration.kind).routes[0].nodes[0], key: `review_${route.nodes.length + 1}` }] })}>在末尾增加节点</Button></section>)}
      <Button variant="secondary" onClick={() => setConfiguration({ ...configuration, routes: [...configuration.routes.slice(0, -1), { key: `route_${configuration.routes.length}`, when: { priorities: ['紧急'] }, nodes: structuredClone(empty(configuration.kind).routes[0].nodes) }, configuration.routes.at(-1)!] })}>在默认规则前增加条件路由</Button><label className="block"><span className="label">修改依据与原因（至少五字）</span><textarea className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></label></fieldset>
    </Modal>
    <Modal open={Boolean(confirm)} onClose={() => setConfirm(null)} title={confirm?.version ? '确认发布审批规则' : '确认变更规则启用状态'} footer={<Button disabled={busy || blocked || reason.trim().length < 5} onClick={() => void work(async () => { if (!confirm) return; if (confirm.version) await perform(confirm.version.id, 'publish', { expectedVersion: confirm.version.version, expectedPolicyVersion: confirm.head.version, reason }); else await perform(confirm.head.id, 'enabled', { expectedVersion: confirm.head.version, enabled: !confirm.head.enabled, reason }); setConfirm(null); await refresh() })}>确认操作</Button>}><p className="mb-4 text-sm">本操作只影响下一次明确提交的申请，不改写在途节点、历史批准内容和附件。请核对字段、路由顺序、审批岗位和客户规则后再发布。</p>{confirm?.version?.configuration.routes.map(r => <p key={r.key} className="mb-2 text-sm">{r.key}：{r.nodes.map(n => `${n.name}（${n.mode}）`).join(' → ')}</p>)}{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<textarea className="textarea" aria-label="发布或启停依据" value={reason} onChange={e => setReason(e.target.value)} /></Modal>
  </div>
}
