import { useMemo, useState } from 'react'
import {
  BriefcaseBusiness,
  ClipboardCheck,
  FileCheck2,
  HelpCircle,
  Presentation,
  ShieldCheck,
} from 'lucide-react'
import type { Project } from '../types'
import { Button, Modal } from './ui'

export type AiDocumentActionId = 'compliance' | 'proposal' | 'investment_ppt' | 'due_diligence'
export type AiQuickActionId = AiDocumentActionId | 'qa'

export type QaSkillSelection = {
  projectId: string
  category: string
  question: string
  skillName: 'answer-project-qa'
}

export type AiQuickTaskRequest = {
  actionId: AiDocumentActionId
  actionLabel: string
  projectId: string
  projectName: string
  sourceCutoffDate: string
  audience?: string
  length?: string
  template?: string
  pageCount?: string
  language?: string
  diligenceScope?: string
  outputFormat: 'DOCX' | 'PPTX'
}

type ActionConfig = {
  id: AiQuickActionId
  label: string
  description: string
  mode: 'task' | 'question-library'
  icon: typeof ShieldCheck
}

const ACTIONS: ActionConfig[] = [
  { id: 'compliance', label: '合规性说明', description: '基于项目资料生成合规分析初稿', mode: 'task', icon: ShieldCheck },
  { id: 'proposal', label: '投资提案', description: '生成内部立项或项目推介材料', mode: 'task', icon: BriefcaseBusiness },
  { id: 'investment_ppt', label: '投资建议书（PPT）', description: '生成公司模板投资建议书', mode: 'task', icon: Presentation },
  { id: 'due_diligence', label: '尽调报告', description: '梳理事实、风险和资料缺口', mode: 'task', icon: ClipboardCheck },
  { id: 'qa', label: 'Q&A', description: '从项目问题库选择提问', mode: 'question-library', icon: HelpCircle },
]

const QA_GROUPS = [
  { label: '投资亮点', questions: ['请提炼这个项目最值得关注的 3 个投资亮点', '这个项目的核心投资逻辑是否成立？'] },
  { label: '核心风险', questions: ['这个项目最大的风险是什么？', '哪些风险可能直接影响投资决策？'] },
  { label: '财务', questions: ['当前财务数据还存在哪些关键缺口？', '收入质量、现金流和估值依据是否充分？'] },
  { label: '客户', questions: ['客户质量、集中度和回款情况如何？', '现有客户证据能否验证商业化进展？'] },
  { label: '竞争', questions: ['项目所在市场的空间和增长驱动是什么？', '项目相对主要竞争对手的差异化是什么？'] },
  { label: '合规', questions: ['还需要核验哪些法律或合规事项？', '主体、资质、知识产权和治理方面有哪些风险？'] },
  { label: '资料缺口', questions: ['还缺哪些关键尽调资料？', '下一步最优先应补充或访谈哪些证据？'] },
]

const REFERENCE_TEMPLATES: Record<AiDocumentActionId, string> = {
  compliance: '《关于德塔智能项目投资合规性的说明》当前版本样本',
  proposal: '《佳量脑科学项目投资提案》当前版本样本',
  investment_ppt: '《佳量脑科学投资建议书》当前版本 PPT 样本',
  due_diligence: '《佳量脑科学业务尽调报告》当前版本样本',
}

const today = () => new Date().toISOString().slice(0, 10)

export function buildAiQuickTaskPrompt(request: AiQuickTaskRequest): string {
  const common = [
    `【快捷任务】${request.actionLabel}`,
    `【资料截止日】${request.sourceCutoffDate}`,
    `【输出格式】${request.outputFormat}`,
  ]
  if (request.actionId === 'compliance') {
    return [
      ...common,
      '请基于当前项目已授权资料生成合规性说明初稿，固定区分：已核验事实、风险提示、待核验事项、资料缺口和免责声明。',
      '关键判断请注明来源；无充分证据的内容必须标记为“AI 推断”或“待核验”。',
      '文末必须注明：本内容由 AI 辅助生成，不构成正式法律意见。',
    ].join('\n')
  }
  if (request.actionId === 'proposal') {
    return [
      ...common,
      `【目标受众】${request.audience || '内部立项'}`,
      `【篇幅】${request.length || '标准版'}`,
      '请生成投资提案初稿，至少包含项目概览、投资逻辑、市场机会、产品与商业模式、团队、当前进展、核心风险和下一步建议。',
      '请分开呈现事实、投资判断和待核验假设，并注明本材料不替代正式投资建议书。',
    ].join('\n')
  }
  if (request.actionId === 'investment_ppt') {
    return [
      ...common,
      `【模板】${request.template || '公司标准模板'}`,
      `【建议页数】${request.pageCount || '12-15页'}`,
      '请生成投资建议书 PPTX。优先使用可编辑文字、表格、基础图表和形状；复杂装饰与背景可图片化。',
      '内容应覆盖项目概览、投资结论、行业市场、产品技术、商业模式、客户经营、团队、竞争、财务估值、风险、尽调缺口和投资建议。',
    ].join('\n')
  }
  return [
    ...common,
    `【尽调范围】${request.diligenceScope || '商业尽调'}`,
    '请生成尽调报告初稿，覆盖主体、团队、产品、市场、商业模式、财务、客户、竞争、法律合规、风险和资料缺口。',
    '关键结论必须关联来源，并明确区分“已核验事实”“企业自述”“AI 推断”和“待核验”。',
  ].join('\n')
}

export function AiQuickActions({
  disabled,
  projects,
  currentProjectId,
  onRunTask,
  onSelectQuestion,
}: {
  disabled: boolean
  projects: Project[]
  currentProjectId: string
  onRunTask: (request: AiQuickTaskRequest) => Promise<boolean>
  onSelectQuestion: (selection: QaSkillSelection) => void
}) {
  const [activeAction, setActiveAction] = useState<ActionConfig | null>(null)
  const [qaOpen, setQaOpen] = useState(false)
  const [sourceCutoffDate, setSourceCutoffDate] = useState(today)
  const [audience, setAudience] = useState('内部立项')
  const [length, setLength] = useState('标准版')
  const [template, setTemplate] = useState('公司标准模板')
  const [pageCount, setPageCount] = useState('12-15页')
  const [language, setLanguage] = useState('中文')
  const [diligenceScope, setDiligenceScope] = useState('商业尽调')
  const [submitting, setSubmitting] = useState(false)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId),
    [currentProjectId, projects],
  )

  const openAction = (action: ActionConfig) => {
    if (disabled || !selectedProject) return
    if (action.mode === 'question-library') {
      setQaOpen(true)
      return
    }
    setActiveAction(action)
  }

  const submit = async () => {
    if (!activeAction || activeAction.mode !== 'task' || !selectedProject || submitting) return
    setSubmitting(true)
    try {
      const ok = await onRunTask({
        actionId: activeAction.id as AiDocumentActionId,
        actionLabel: activeAction.label,
        projectId: selectedProject.id,
        projectName: selectedProject.name,
        sourceCutoffDate,
        audience,
        length,
        template,
        pageCount,
        language,
        diligenceScope,
        outputFormat: activeAction.id === 'investment_ppt' ? 'PPTX' : 'DOCX',
      })
      if (ok) setActiveAction(null)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="mb-3">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-slate-500">
          <FileCheck2 className="h-3.5 w-3.5 text-brand-600" />
          快捷任务
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {ACTIONS.map((action) => {
            const Icon = action.icon
            return (
              <button
                key={action.id}
                type="button"
                disabled={disabled || !selectedProject}
                title={!selectedProject ? '当前会话未绑定可用项目' : action.description}
                onClick={() => openAction(action)}
                className="group flex min-w-[142px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-brand-200 hover:bg-brand-50/50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand-50 text-brand-600 group-hover:bg-white">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block whitespace-nowrap text-[11px] font-medium text-slate-700">{action.label}</span>
                  <span className="block truncate text-[9px] text-slate-400">{action.mode === 'task' ? '确认参数后执行' : '选择后填入输入框'}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <Modal
        open={!!activeAction}
        title={activeAction ? `生成${activeAction.label}` : '快捷任务'}
        onClose={() => { if (!submitting) setActiveAction(null) }}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setActiveAction(null)} disabled={submitting}>取消</Button>
            <Button onClick={() => { void submit() }} loading={submitting} disabled={!selectedProject}>开始生成</Button>
          </>
        )}
      >
        <div className="space-y-4">
          <p className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
            将参照 docs 中的{activeAction && activeAction.id !== 'qa' ? REFERENCE_TEMPLATES[activeAction.id] : '业务样本'}生成正式初稿。
            任务进度、来源引用、版本和文件质量检查会随任务保存；样本版本及生成结果仍须由业务负责人审核批准。
          </p>
          <label className="block">
            <span className="label">项目（随当前会话固定）</span>
            <div className="input flex items-center bg-slate-50 text-slate-600" aria-label="当前会话项目">
              {selectedProject?.name ?? '未绑定项目'}
            </div>
          </label>
          <label className="block">
            <span className="label">资料截止日</span>
            <input className="input" type="date" value={sourceCutoffDate} max={today()} onChange={(event) => setSourceCutoffDate(event.target.value)} />
          </label>
          {activeAction?.id === 'proposal' && (
            <div className="grid grid-cols-2 gap-4">
              <label><span className="label">目标受众</span><select className="input" value={audience} onChange={(event) => setAudience(event.target.value)}><option>内部立项</option><option>基金内部汇报</option><option>合作方沟通</option></select></label>
              <label><span className="label">篇幅</span><select className="input" value={length} onChange={(event) => setLength(event.target.value)}><option>精简版</option><option>标准版</option><option>详细版</option></select></label>
            </div>
          )}
          {activeAction?.id === 'investment_ppt' && (
            <div className="grid grid-cols-3 gap-4">
              <label><span className="label">模板</span><select className="input" value={template} onChange={(event) => setTemplate(event.target.value)}><option>公司标准模板</option></select></label>
              <label><span className="label">建议页数</span><select className="input" value={pageCount} onChange={(event) => setPageCount(event.target.value)}><option>8-10页</option><option>12-15页</option><option>18-20页</option></select></label>
              <label><span className="label">语言</span><select className="input" value={language} onChange={(event) => setLanguage(event.target.value)}><option>中文</option></select></label>
            </div>
          )}
          {activeAction?.id === 'due_diligence' && (
            <label className="block"><span className="label">尽调范围</span><select className="input" value={diligenceScope} onChange={(event) => setDiligenceScope(event.target.value)}><option>商业尽调</option></select></label>
          )}
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            输出格式：<strong className="text-slate-700">{activeAction?.id === 'investment_ppt' ? 'PPTX' : 'DOCX'}</strong>
          </div>
        </div>
      </Modal>

      <Modal open={qaOpen} title="项目 Q&A 问题库" onClose={() => setQaOpen(false)} width="max-w-2xl">
        <div className="space-y-4">
          <label className="block">
            <span className="label">项目（随当前会话固定）</span>
            <div className="input flex items-center bg-slate-50 text-slate-600" aria-label="当前会话项目">
              {selectedProject?.name ?? '未绑定项目'}
            </div>
          </label>
          <p className="text-xs text-slate-500">选择问题后只会填入输入框，不会立即发送。</p>
          {QA_GROUPS.map((group) => (
            <section key={group.label}>
              <h3 className="mb-2 text-xs font-semibold text-slate-700">{group.label}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.questions.map((question) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => {
                      if (!selectedProject) return
                      onSelectQuestion({
                        projectId: selectedProject.id,
                        category: group.label,
                        question,
                        skillName: 'answer-project-qa',
                      })
                      setQaOpen(false)
                    }}
                    className="rounded-lg border border-slate-200 px-3 py-2.5 text-left text-xs leading-5 text-slate-600 hover:border-brand-200 hover:bg-brand-50/50 hover:text-brand-700"
                  >
                    {question}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Modal>
    </>
  )
}
