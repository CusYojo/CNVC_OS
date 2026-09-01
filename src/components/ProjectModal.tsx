import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UsersRound } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore } from '../store/useAuthStore'
import { apiGet } from '../lib/api'
import type { ProjectStage, RiskLevel } from '../types'
import { useToast } from './Toast'
import { Button, Modal } from './ui'

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

export function ProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const addProject = useAppStore((state) => state.addProject)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [people, setPeople] = useState<CreationPerson[]>([])
  const [rosterLoading, setRosterLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ownerUserId, setOwnerUserId] = useState('')
  const [duties, setDuties] = useState<Record<RequiredDuty, string[]>>({ boss: [], project_manager: [], legal: [], finance: [] })
  const [form, setForm] = useState({
    name: '', companyName: '', industry: 'AI 医疗', round: 'A 轮', stage: '立项' as ProjectStage,
    source: '手工录入', financing: '未披露，待核验', valuation: '未披露，待核验', riskLevel: '低' as RiskLevel, summary: '',
  })

  useEffect(() => {
    if (!open) return
    let cancelled = false
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
    return () => { cancelled = true }
  }, [open, currentUser.id, showToast])

  const candidates = useMemo(() => ({
    boss: people.filter((person) => person.capabilities.canBoss),
    project_manager: people.filter((person) => person.capabilities.canProjectManager),
    legal: people.filter((person) => person.capabilities.canLegal),
    finance: people.filter((person) => person.capabilities.canFinance),
  }), [people])

  const submit = async () => {
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
      showToast(`项目“${project.name}”已落库，成员和审批职责已同步`)
      onClose()
      setForm((value) => ({ ...value, name: '', companyName: '', summary: '' }))
      navigate(`/projects/${project.id}`)
    } catch (error) {
      showToast(`创建项目失败：${(error as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="快速新建投资项目" width="max-w-5xl" footer={<><Button variant="secondary" disabled={saving} onClick={onClose}>取消</Button><Button loading={saving} disabled={rosterLoading} onClick={submit}>创建、同步人员并进入项目</Button></>}>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <label><span className="label">项目名称 <b className="text-rose-500">*</b></span><input className="input" placeholder="例如：新锐 AI 医疗项目" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label><span className="label">公司名称</span><input className="input" placeholder="公司工商全称" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} /></label>
          <label><span className="label">所属行业 <b className="text-rose-500">*</b></span><select className="input" value={form.industry} onChange={(event) => setForm({ ...form, industry: event.target.value })}><option>AI 医疗</option><option>工业软件</option><option>具身智能</option><option>新能源</option><option>合成生物</option><option>企业服务</option><option>消费科技</option></select></label>
          <label><span className="label">融资轮次</span><select className="input" value={form.round} onChange={(event) => setForm({ ...form, round: event.target.value })}><option>天使轮</option><option>Pre-A</option><option>A 轮</option><option>B 轮</option><option>C 轮</option><option>Pre-IPO</option></select></label>
          <label><span className="label">项目来源</span><select className="input" value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })}><option>手工录入</option><option>机构推荐</option><option>FA</option><option>BP 邮箱</option><option>行业会议</option><option>产业方推荐</option></select></label>
          <label><span className="label">项目负责人 <b className="text-rose-500">*</b></span><select className="input" value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)} disabled={rosterLoading}><option value="">请选择负责人</option>{people.filter((person) => person.capabilities.canOwn).map((person) => <option key={person.id} value={person.id}>{person.name} · {person.department}</option>)}</select><span className="mt-1 block text-[10px] text-slate-400">负责人与项目经理可选择同一人。</span></label>
          <label><span className="label">计划融资</span><input className="input" value={form.financing} onChange={(event) => setForm({ ...form, financing: event.target.value })} /></label>
          <label><span className="label">投前估值</span><input className="input" value={form.valuation} onChange={(event) => setForm({ ...form, valuation: event.target.value })} /></label>
        </div>

        <section className="rounded-2xl bg-slate-50 p-4">
          <div className="mb-3 flex items-start gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-100 text-brand-700"><UsersRound className="h-4 w-4" /></span><div><h3 className="text-sm font-semibold text-slate-800">项目人员与强制职责</h3><p className="mt-1 text-xs text-slate-500">可一人兼任多个角色。创建成功后会原子写入项目库、成员关系和审批职责，并同步到每位成员账号。</p></div></div>
          <div className="grid gap-3 md:grid-cols-2">
            <PeoplePicker label="老板" hint="至少 1 人，仅董事长陈斌或总裁黄昕。" people={candidates.boss} value={duties.boss} onChange={(ids) => setDuties({ ...duties, boss: ids })} />
            <PeoplePicker label="项目经理" hint="至少 1 人，可与项目负责人为同一人。" people={candidates.project_manager} value={duties.project_manager} onChange={(ids) => setDuties({ ...duties, project_manager: ids })} />
            <PeoplePicker label="法务" hint="至少 1 人，仅展示具备法务岗位的启用账号。" people={candidates.legal} value={duties.legal} onChange={(ids) => setDuties({ ...duties, legal: ids })} />
            <PeoplePicker label="财务" hint="至少 1 人，展示可承担专业复核的启用账号。" people={candidates.finance} value={duties.finance} onChange={(ids) => setDuties({ ...duties, finance: ids })} />
          </div>
        </section>

        <div className="grid grid-cols-2 gap-4">
          <label><span className="label">初始阶段</span><input className="input" value="普通项目 · 立项" readOnly /><span className="mt-1 block text-[10px] text-slate-400">快速新建完成强制组织配置后直接进入正式项目库。</span></label>
          <label><span className="label">初始风险等级</span><select className="input" value={form.riskLevel} onChange={(event) => setForm({ ...form, riskLevel: event.target.value as RiskLevel })}><option>低</option><option>中</option><option>高</option></select></label>
          <label className="col-span-2"><span className="label">项目简介</span><textarea className="textarea min-h-20" placeholder="一句话描述产品、客户和价值主张" value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></label>
        </div>
      </div>
    </Modal>
  )
}
