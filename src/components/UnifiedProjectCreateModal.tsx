import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Briefcase, FolderOpen, UsersRound } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore } from '../store/useAuthStore'
import { apiGet, apiPost } from '../lib/api'
import type { ProjectStage, RiskLevel } from '../types'
import { useToast } from './Toast'
import { Button, Modal } from './ui'
import { typeRegistrationCommand } from '../../server/src/contracts/fdeTypeRegistrationContract'
import { forgetRegistrationPending, readRegistrationPending, registrationMarker, rememberRegistrationPending, typeRegistrationPendingKey, validateRegistrationReceipt, validateRegistrationRecovery, type TypeRegistrationPending } from '../lib/fdeTypeRegistrationRecovery'
import { editRegistrationDraft, emptyRegistrationDraft, initialRegistrationDraft, invalidateRegistrationDraft, readRegistrationRecheck, settleRegistrationRecheck, beginRegistrationRecheck, type RegistrationDraft, type RegistrationDraftState } from '../lib/fdeTypeRegistrationDraft'
import { DEFAULT_PROJECT_INDUSTRY, PROJECT_INDUSTRIES } from '../lib/projectIndustries'

// ========== 类型定义 ==========

type CreationPerson = {
  id: string
  name: string
  department: string
  role: string
  capabilities: {
    canOwn: boolean
    canBoss: boolean
    canProjectManager: boolean
    canLegal: boolean
    canFinance: boolean
  }
}

type RequiredDuty = 'boss' | 'project_manager' | 'legal' | 'finance'

type ProjectCategory = 'investment' | 'non-investment'

type TypePolicy = {
  policyId: string
  versionId: string
  policyVersion: number
  sha256: string
  name: string
  configuration: {
    cycleDays: number[]
    registration?: {
      classification?: string
      ruleReference?: string
    }
  }
}

type CreateStep = 'select-type' | 'fill-form'

// ========== 子组件：人员选择器 ==========

function PeoplePicker({ label, hint, people, value, onChange }: {
  label: string
  hint: string
  people: CreationPerson[]
  value: string[]
  onChange: (ids: string[]) => void
}) {
  return (
    <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
      <legend className="px-1 text-sm font-semibold text-slate-800">{label} <b className="text-rose-500">*</b></legend>
      <p className="mb-2 text-[11px] leading-5 text-slate-400">{hint}</p>
      <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
        {people.map((person) => {
          const checked = value.includes(person.id)
          return <label key={person.id} className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${checked ? 'bg-brand-50 text-brand-800' : 'hover:bg-slate-50'}`}>
            <input type="checkbox" checked={checked} onChange={() => onChange(checked ? value.filter((id) => id !== person.id) : [...value, person.id])} />
            <span className="font-medium">{person.name}</span><span className="ml-auto text-slate-400">{person.department}</span>
          </label>
        })}
        {!people.length && <p className="py-3 text-center text-xs text-rose-500">没有符合岗位条件的启用账号，请先在系统管理中配置岗位。</p>}
      </div>
    </fieldset>
  )
}

// ========== 主组件 ==========

export function UnifiedProjectCreateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const addProject = useAppStore((state) => state.addProject)
  const hydrateFromServer = useAppStore((state) => state.hydrateFromServer)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const navigate = useNavigate()
  const { showToast } = useToast()

  // 步骤状态
  const [step, setStep] = useState<CreateStep>('select-type')
  const [category, setCategory] = useState<ProjectCategory>('investment')

  // 投资项目状态
  const [people, setPeople] = useState<CreationPerson[]>([])
  const [rosterLoading, setRosterLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ownerUserId, setOwnerUserId] = useState('')
  const [duties, setDuties] = useState<Record<RequiredDuty, string[]>>({ boss: [], project_manager: [], legal: [], finance: [] })
  const [form, setForm] = useState({
    name: '', companyName: '', industry: DEFAULT_PROJECT_INDUSTRY, round: 'A 轮', stage: '立项' as ProjectStage,
    source: '手工录入', financing: '未披露，待核验', valuation: '未披露，待核验', riskLevel: '低' as RiskLevel, summary: '',
  })

  // 非投资项目状态
  const [policies, setPolicies] = useState<TypePolicy[]>([])
  const [policiesLoading, setPoliciesLoading] = useState(false)
  const [selectedPolicy, setSelectedPolicy] = useState('')
  const [nonInvestForm, setNonInvestForm] = useState({ name: '', cycleDays: 0, targetDate: '', reason: '', ack: false })
  const [nonInvestBusy, setNonInvestBusy] = useState(false)
  const [nonInvestPending, setNonInvestPending] = useState<TypeRegistrationPending | null>(null)
  const [nonInvestPhase, setNonInvestPhase] = useState<'checking' | 'ready' | 'blocked'>('checking')
  const uid = currentUser.id
  const pendingKey = typeRegistrationPendingKey(uid)
  const pendingRef = useRef<TypeRegistrationPending | null>(null)

  // ========== 初始化：加载数据 ==========

  useEffect(() => {
    if (!open) return
    let cancelled = false

    // 加载投资项目人员
    setRosterLoading(true)
    void apiGet<{ people: CreationPerson[] }>('/projects/creation-roster')
      .then((result) => {
        if (cancelled) return
        setPeople(result.people)
        const current = result.people.find((person) => person.id === currentUser.id && person.capabilities.canOwn)
        const owner = current ?? result.people.find((person) => person.capabilities.canOwn)
        setOwnerUserId((value) => value || owner?.id || '')
        if (current?.capabilities.canProjectManager) setDuties((value) => value.project_manager.length ? value : { ...value, project_manager: [current.id] })
      })
      .catch((error) => showToast(`加载人员失败：${(error as Error).message}`, 'error'))
      .finally(() => { if (!cancelled) setRosterLoading(false) })

    // 加载非投资项目模板
    setPoliciesLoading(true)
    setNonInvestPhase('checking')
    void apiGet<{ policies: TypePolicy[] }>('/fde-type-registration/options')
      .then((result) => {
        if (cancelled) return
        setPolicies(result.policies ?? [])
        setNonInvestPhase('ready')
      })
      .catch(() => { if (!cancelled) setNonInvestPhase('ready') })
      .finally(() => { if (!cancelled) setPoliciesLoading(false) })

    // 检查是否有待恢复的登记
    try {
      const pending = readRegistrationPending(localStorage, pendingKey)
      setNonInvestPending(pending)
      pendingRef.current = pending
    } catch {}

    return () => { cancelled = true }
  }, [open, currentUser.id, showToast, pendingKey])

  // ========== 投资项目相关 ==========

  const candidates = useMemo(() => ({
    boss: people.filter((person) => person.capabilities.canBoss),
    project_manager: people.filter((person) => person.capabilities.canProjectManager),
    legal: people.filter((person) => person.capabilities.canLegal),
    finance: people.filter((person) => person.capabilities.canFinance),
  }), [people])

  const submitInvestment = async () => {
    if (!form.name.trim()) return showToast('请填写项目名称', 'error')
    if (!ownerUserId) return showToast('请选择项目负责人', 'error')
    const missing = ([['boss', '老板'], ['project_manager', '项目经理'], ['legal', '法务'], ['finance', '财务']] as const).find(([duty]) => duties[duty].length === 0)
    if (missing) return showToast(`请至少选择 1 位${missing[1]}`, 'error')
    const owner = people.find((person) => person.id === ownerUserId)
    setSaving(true)
    try {
      const assignments = (Object.entries(duties) as Array<[RequiredDuty, string[]]>).flatMap(([duty, ids]) => ids.map((userId) => ({ duty, userId })))
      const project = await addProject({
        ...form,
        name: form.name.trim(),
        companyName: form.companyName.trim(),
        owner: owner?.name ?? currentUser.name,
        collaborators: [],
        tags: [form.industry, form.round],
        businessModel: '', market: '', team: '', summary: form.summary.trim(),
        governance: { ownerUserId, assignments },
      })
      showToast(`项目"${project.name}"已创建，成员和审批职责已同步`)
      handleClose()
      await hydrateFromServer()
      navigate(`/projects/${project.id}`)
    } catch (error) {
      showToast(`创建项目失败：${(error as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  // ========== 非投资项目相关 ==========

  const selectedPolicyObj = policies.find(p => p.policyId === selectedPolicy)

  const recoverPending = async () => {
    if (!nonInvestPending) return
    setNonInvestBusy(true)
    try {
      const response = validateRegistrationRecovery(await apiPost('/fde-type-registration/commands/recover', { commandId: nonInvestPending.commandId }), nonInvestPending)
      forgetRegistrationPending(localStorage, pendingKey, nonInvestPending)
      setNonInvestPending(null)
      pendingRef.current = null
      if (response.receipt?.projectId) {
        showToast('已找回登记结果')
        handleClose()
        navigate(`/projects/${response.receipt.projectId}?tab=workflow`)
      }
    } catch (e) {
      showToast(`恢复失败：${(e as Error).message}`, 'error')
    } finally {
      setNonInvestBusy(false)
    }
  }

  const submitNonInvestment = async () => {
    if (!selectedPolicyObj || !nonInvestForm.name.trim() || !nonInvestForm.cycleDays || !nonInvestForm.targetDate || nonInvestForm.reason.trim().length < 5 || !nonInvestForm.ack) {
      showToast('请完整填写所有必填项', 'error')
      return
    }
    const command = typeRegistrationCommand.parse({
      commandId: crypto.randomUUID(),
      policyId: selectedPolicyObj.policyId,
      versionId: selectedPolicyObj.versionId,
      expectedPolicyVersion: selectedPolicyObj.policyVersion,
      expectedSha256: selectedPolicyObj.sha256,
      name: nonInvestForm.name.trim(),
      targetDate: nonInvestForm.targetDate,
      cycleDays: nonInvestForm.cycleDays,
      reason: nonInvestForm.reason.trim(),
    })
    const marker = registrationMarker(command)
    try { rememberRegistrationPending(localStorage, pendingKey, marker) } catch (e) { showToast(`存储错误：${(e as Error).message}`, 'error'); return }
    setNonInvestPending(marker)
    pendingRef.current = marker
    setNonInvestBusy(true)
    try {
      const receipt = validateRegistrationReceipt(await apiPost('/fde-type-registration/commands', command), marker)
      forgetRegistrationPending(localStorage, pendingKey, marker)
      setNonInvestPending(null)
      pendingRef.current = null
      showToast('非投资项目已登记，请配置职责和编制计划')
      handleClose()
      await hydrateFromServer()
      navigate(`/projects/${receipt.projectId}?tab=workflow`)
    } catch (e) {
      showToast(`登记失败：${(e as Error).message}`, 'error')
    } finally {
      setNonInvestBusy(false)
    }
  }

  // ========== 关闭与重置 ==========

  const handleClose = () => {
    setStep('select-type')
    setCategory('investment')
    setSelectedPolicy('')
    setNonInvestForm({ name: '', cycleDays: 0, targetDate: '', reason: '', ack: false })
    setForm({ name: '', companyName: '', industry: DEFAULT_PROJECT_INDUSTRY, round: 'A 轮', stage: '立项', source: '手工录入', financing: '未披露，待核验', valuation: '未披露，待核验', riskLevel: '低', summary: '' })
    setDuties({ boss: [], project_manager: [], legal: [], finance: [] })
    setOwnerUserId('')
    onClose()
  }

  const goBack = () => {
    setStep('select-type')
    setSelectedPolicy('')
  }

  // ========== 渲染 ==========

  const renderStep1 = () => (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">请选择要创建的项目类型：</p>
      <div className="grid grid-cols-2 gap-4">
        {/* 投资项目卡片 */}
        <button
          className="flex flex-col items-start gap-3 rounded-xl border-2 border-slate-200 p-5 text-left transition hover:border-brand-400 hover:bg-brand-50"
          onClick={() => { setCategory('investment'); setStep('fill-form') }}
        >
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-brand-100 text-brand-700"><Briefcase className="h-5 w-5" /></span>
          <div>
            <h3 className="text-sm font-semibold text-slate-800">投资项目</h3>
            <p className="mt-1 text-xs text-slate-500">标准投资流程：立项 → 尽调 → 内核 → 投决 → 打款</p>
          </div>
          <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-medium text-brand-700">默认</span>
        </button>

        {/* 非投资项目卡片 */}
        <button
          className={`flex flex-col items-start gap-3 rounded-xl border-2 p-5 text-left transition ${policies.length ? 'border-slate-200 hover:border-emerald-400 hover:bg-emerald-50' : 'border-slate-100 bg-slate-50 opacity-60 cursor-not-allowed'}`}
          onClick={() => { if (policies.length) { setCategory('non-investment'); setStep('fill-form') } }}
          disabled={!policies.length}
        >
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-100 text-emerald-700"><FolderOpen className="h-5 w-5" /></span>
          <div>
            <h3 className="text-sm font-semibold text-slate-800">非投资项目</h3>
            <p className="mt-1 text-xs text-slate-500">基金募资、LP关系、政府合作等专项登记</p>
          </div>
          {!policies.length && <span className="text-[10px] text-slate-400">暂无可登记的非投资类型模板</span>}
        </button>
      </div>

      {/* 待恢复提示 */}
      {nonInvestPending && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-800">有一笔非投资登记尚待核对。</p>
          <Button variant="secondary" className="mt-2" disabled={nonInvestBusy} onClick={recoverPending}>核对原登记结果</Button>
        </div>
      )}
    </div>
  )

  const renderInvestmentForm = () => (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <label><span className="label">项目名称 <b className="text-rose-500">*</b></span><input className="input" placeholder="例如：新锐硬科技项目" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label><span className="label">公司名称</span><input className="input" placeholder="公司工商全称" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} /></label>
        <label><span className="label">所属行业 <b className="text-rose-500">*</b></span><select className="input" value={form.industry} onChange={(event) => setForm({ ...form, industry: event.target.value })}>{PROJECT_INDUSTRIES.map((industry) => <option key={industry} value={industry}>{industry}</option>)}</select></label>
        <label><span className="label">融资轮次</span><select className="input" value={form.round} onChange={(event) => setForm({ ...form, round: event.target.value })}><option>天使轮</option><option>Pre-A</option><option>A 轮</option><option>B 轮</option><option>C 轮</option><option>Pre-IPO</option></select></label>
        <label><span className="label">项目来源</span><select className="input" value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })}><option>手工录入</option><option>机构推荐</option><option>FA</option><option>BP 邮箱</option><option>行业会议</option><option>产业方推荐</option></select></label>
        <label><span className="label">项目负责人 <b className="text-rose-500">*</b></span><select className="input" value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)} disabled={rosterLoading}><option value="">请选择负责人</option>{people.filter((person) => person.capabilities.canOwn).map((person) => <option key={person.id} value={person.id}>{person.name} · {person.department}</option>)}</select></label>
        <label><span className="label">计划融资</span><input className="input" value={form.financing} onChange={(event) => setForm({ ...form, financing: event.target.value })} /></label>
        <label><span className="label">投前估值</span><input className="input" value={form.valuation} onChange={(event) => setForm({ ...form, valuation: event.target.value })} /></label>
      </div>

      <section className="rounded-2xl bg-slate-50 p-4">
        <div className="mb-3 flex items-start gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-100 text-brand-700"><UsersRound className="h-4 w-4" /></span><div><h3 className="text-sm font-semibold text-slate-800">项目人员与强制职责</h3><p className="mt-1 text-xs text-slate-500">可一人兼任多个角色。创建成功后会原子写入项目库、成员关系和审批职责。</p></div></div>
        <div className="grid gap-3 md:grid-cols-2">
          <PeoplePicker label="老板" hint="至少 1 人，仅董事长或总裁。" people={candidates.boss} value={duties.boss} onChange={(ids) => setDuties({ ...duties, boss: ids })} />
          <PeoplePicker label="项目经理" hint="至少 1 人，可与项目负责人为同一人。" people={candidates.project_manager} value={duties.project_manager} onChange={(ids) => setDuties({ ...duties, project_manager: ids })} />
          <PeoplePicker label="法务" hint="至少 1 人，仅展示具备法务岗位的启用账号。" people={candidates.legal} value={duties.legal} onChange={(ids) => setDuties({ ...duties, legal: ids })} />
          <PeoplePicker label="财务" hint="至少 1 人，展示可承担专业复核的启用账号。" people={candidates.finance} value={duties.finance} onChange={(ids) => setDuties({ ...duties, finance: ids })} />
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4">
        <label><span className="label">初始阶段</span><input className="input" value="普通项目 · 立项" readOnly /></label>
        <label><span className="label">初始风险等级</span><select className="input" value={form.riskLevel} onChange={(event) => setForm({ ...form, riskLevel: event.target.value as RiskLevel })}><option>低</option><option>中</option><option>高</option></select></label>
        <label className="col-span-2"><span className="label">项目简介</span><textarea className="textarea min-h-20" placeholder="一句话描述产品、客户和价值主张" value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></label>
      </div>
    </div>
  )

  const renderNonInvestmentForm = () => (
    <div className="space-y-4">
      {nonInvestPending && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-800">有一笔登记尚待核对，新登记已暂停。</p>
          <Button variant="secondary" className="mt-2" disabled={nonInvestBusy} onClick={recoverPending}>核对原登记结果</Button>
        </div>
      )}
      <label className="block text-sm">已批准模板 <b className="text-rose-500">*</b>
        <select className="input mt-1 w-full" disabled={policiesLoading || nonInvestPhase !== 'ready'} value={selectedPolicy} onChange={e => { setSelectedPolicy(e.target.value); setNonInvestForm({ ...nonInvestForm, cycleDays: 0, ack: false }) }}>
          <option value="">请选择已批准模板</option>
          {policies.map(p => <option key={p.policyId} value={p.policyId}>{p.name}</option>)}
        </select>
      </label>
      {nonInvestPhase === 'checking' && <p className="text-xs text-slate-500">正在核对登记权限与模板版本...</p>}
      {nonInvestPhase === 'ready' && !policies.length && <p className="text-xs text-slate-500">暂无对当前账号开放的已批准登记模板。</p>}
      {selectedPolicyObj && <p className="text-xs leading-6 text-slate-600">登记人担任项目负责人；进入{selectedPolicyObj.configuration.registration?.classification === 'key' ? '重点' : '普通'}项目。规则依据：{selectedPolicyObj.configuration.registration?.ruleReference || '无'}</p>}
      <label className="block text-sm">项目名称 <b className="text-rose-500">*</b>
        <input className="input mt-1 w-full" disabled={nonInvestPhase !== 'ready'} value={nonInvestForm.name} onChange={e => setNonInvestForm({ ...nonInvestForm, name: e.target.value, ack: false })} maxLength={128} placeholder="请输入项目名称" />
      </label>
      <label className="block text-sm">计划周期 <b className="text-rose-500">*</b>
        <select className="input mt-1 w-full" disabled={!selectedPolicyObj} value={nonInvestForm.cycleDays} onChange={e => setNonInvestForm({ ...nonInvestForm, cycleDays: Number(e.target.value), ack: false })}>
          <option value={0}>请选择周期</option>
          {selectedPolicyObj?.configuration.cycleDays.map(d => <option key={d} value={d}>{d} 天</option>)}
        </select>
      </label>
      <label className="block text-sm">目标日期 <b className="text-rose-500">*</b>
        <input type="date" className="input mt-1 w-full" value={nonInvestForm.targetDate} onChange={e => setNonInvestForm({ ...nonInvestForm, targetDate: e.target.value, ack: false })} />
      </label>
      <label className="block text-sm">登记理由 <b className="text-rose-500">*</b>
        <textarea className="input mt-1 min-h-20 w-full" value={nonInvestForm.reason} onChange={e => setNonInvestForm({ ...nonInvestForm, reason: e.target.value, ack: false })} placeholder="至少填写5个字" />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={nonInvestForm.ack} disabled={!selectedPolicyObj} onChange={e => setNonInvestForm({ ...nonInvestForm, ack: e.target.checked })} />
        <span>确认上述精确版本及登记规则。登记后仍须配置真实职责、提交计划并独立审批，不直接生成执行任务。</span>
      </label>
    </div>
  )

  const renderStep2 = () => {
    if (category === 'investment') return renderInvestmentForm()
    return renderNonInvestmentForm()
  }

  const getTitle = () => {
    if (step === 'select-type') return '新建项目'
    return category === 'investment' ? '新建投资项目' : '登记非投资项目'
  }

  const getFooter = () => {
    if (step === 'select-type') return <Button variant="secondary" onClick={handleClose}>取消</Button>
    const backBtn = <Button variant="secondary" onClick={goBack}><ArrowLeft className="mr-1 h-4 w-4" />返回</Button>
    const cancelBtn = <Button variant="secondary" disabled={saving || nonInvestBusy} onClick={handleClose}>取消</Button>
    if (category === 'investment') {
      return <>{backBtn}{cancelBtn}<Button loading={saving} disabled={rosterLoading} onClick={submitInvestment}>创建并进入项目</Button></>
    }
    return <>{backBtn}{cancelBtn}<Button disabled={!selectedPolicyObj || !nonInvestForm.ack || nonInvestBusy || nonInvestPending !== null} loading={nonInvestBusy} onClick={submitNonInvestment}>确认登记</Button></>
  }

  return (
    <Modal open={open} onClose={handleClose} title={getTitle()} width="max-w-5xl" footer={getFooter()}>
      {step === 'select-type' ? renderStep1() : renderStep2()}
    </Modal>
  )
}
