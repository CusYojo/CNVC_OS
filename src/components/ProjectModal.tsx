import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/useAuthStore'
import type { ProjectStage, RiskLevel } from '../types'
import { useToast } from './Toast'
import { Button, Modal } from './ui'

export function ProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const addProject = useAppStore((state) => state.addProject)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [form, setForm] = useState({
    name: '',
    companyName: '',
    industry: 'AI 医疗',
    round: 'A 轮',
    stage: '入库' as ProjectStage,
    source: '手工录入',
    financing: '未披露，待核验',
    valuation: '未披露，待核验',
    riskLevel: '低' as RiskLevel,
    summary: '',
  })

  const submit = async () => {
    if (!form.name.trim()) {
      showToast('请填写项目名称', 'error')
      return
    }
    try {
      const project = await addProject({
        ...form,
        companyName: form.companyName.trim(),
        owner: currentUser.name,
        collaborators: [],
        tags: [form.industry, form.round],
        businessModel: '',
        market: '',
        team: '',
        summary: form.summary.trim(),
      })
      showToast(`项目“${project.name}”已创建`)
      onClose()
      setForm((value) => ({ ...value, name: '', companyName: '', summary: '' }))
      navigate(`/projects/${project.id}`)
    } catch (err) {
      showToast(`创建项目失败：${(err as Error).message}`, 'error')
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创建投资项目"
      width="max-w-2xl"
      footer={<><Button variant="secondary" onClick={onClose}>取消</Button><Button onClick={submit}>创建并进入项目</Button></>}
    >
      <div className="grid grid-cols-2 gap-4">
        <label><span className="label">项目名称 <b className="text-rose-500">*</b></span><input className="input" placeholder="例如：新锐 AI 医疗项目" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label><span className="label">公司名称</span><input className="input" placeholder="公司工商全称" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} /></label>
        <label><span className="label">所属行业 <b className="text-rose-500">*</b></span><select className="input" value={form.industry} onChange={(event) => setForm({ ...form, industry: event.target.value })}><option>AI 医疗</option><option>工业软件</option><option>具身智能</option><option>新能源</option><option>合成生物</option><option>企业服务</option><option>消费科技</option></select></label>
        <label><span className="label">融资轮次</span><select className="input" value={form.round} onChange={(event) => setForm({ ...form, round: event.target.value })}><option>天使轮</option><option>Pre-A</option><option>A 轮</option><option>B 轮</option><option>C 轮</option><option>Pre-IPO</option></select></label>
        <label><span className="label">初始阶段</span><input className="input" value="项目池 · 入库" readOnly /><span className="mt-1 block text-[10px] text-slate-400">新建项目先进入项目池，完成入库初筛后成为普通项目。</span></label>
        <label><span className="label">项目来源</span><select className="input" value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })}><option>手工录入</option><option>机构推荐</option><option>FA</option><option>BP 邮箱</option><option>行业会议</option><option>产业方推荐</option></select></label>
        <label><span className="label">计划融资</span><input className="input" value={form.financing} onChange={(event) => setForm({ ...form, financing: event.target.value })} /></label>
        <label><span className="label">投前估值</span><input className="input" value={form.valuation} onChange={(event) => setForm({ ...form, valuation: event.target.value })} /></label>
        <label><span className="label">初始风险等级</span><select className="input" value={form.riskLevel} onChange={(event) => setForm({ ...form, riskLevel: event.target.value as RiskLevel })}><option>低</option><option>中</option><option>高</option></select></label>
        <div className="rounded-lg bg-brand-50 p-3 text-xs leading-5 text-brand-700">项目负责人默认为当前用户：<strong>{currentUser.name}</strong>。创建后可在项目详情中补充协作人和资料。</div>
        <label className="col-span-2"><span className="label">项目简介</span><textarea className="textarea min-h-20" placeholder="一句话描述产品、客户和价值主张" value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></label>
      </div>
    </Modal>
  )
}
