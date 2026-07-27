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

export type AiDocumentActionId = 'compliance' | 'proposal' | 'investment_ppt' | 'due_diligence' | 'qa'
export type AiQuickActionId = AiDocumentActionId

export type AiQuickTaskRequest = {
  actionId: AiDocumentActionId
  actionLabel: string
  projectId: string
  projectName: string
  sourceCutoffDate: string
  audience?: string
  length?: string
  userInstructions?: string
  template?: string
  pageCount?: string
  language?: string
  diligenceScope?: string
  qaMode?: string
  questionDepth?: string
  outputFormat: 'DOCX' | 'PPTX' | 'DOCX+PDF'
}

type ActionConfig = {
  id: AiQuickActionId
  label: string
  description: string
  mode: 'task'
  icon: typeof ShieldCheck
}

const ACTIONS: ActionConfig[] = [
  { id: 'compliance', label: '合规性说明', description: '基于项目资料生成合规分析初稿', mode: 'task', icon: ShieldCheck },
  { id: 'proposal', label: '投资提案', description: '按核心规范生成内部立项或投委会材料', mode: 'task', icon: BriefcaseBusiness },
  { id: 'investment_ppt', label: '投资建议书（PPT）', description: '生成公司模板投资建议书', mode: 'task', icon: Presentation },
  { id: 'due_diligence', label: '尽调报告', description: '梳理事实、风险和资料缺口', mode: 'task', icon: ClipboardCheck },
  { id: 'qa', label: 'Q&A', description: '自动生成投资委员会或尽调 Q&A，并输出 Word/PDF', mode: 'task', icon: HelpCircle },
]

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
      ...(request.userInstructions?.trim() ? [`【用户补充输入】${request.userInstructions.trim()}`] : []),
      '请读取投资提案核心规范及 docs/投资提案 模板共性，按标准 17 节结构、投委会书面语、原生财务/交易表格和黑白公文版式生成投资提案。',
      '正文固定覆盖基本情况简介、交易条件、公司业务计划、项目亮点总结、风险提示与对策及条件式结论；不得按单份模板差异扩章。',
      '按“我的明确输入、项目结构化数据、截止日前授权证据、审慎分析”的优先级取值；请分开呈现资料记载、分析判断、待核验和资料缺口，不得复制模板项目事实。',
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
  if (request.actionId === 'qa') {
    return [
      ...common,
      `【Q&A 类型】${request.qaMode || '投资委员会 Q&A'}`,
      `【问题深度】${request.questionDepth || '标准版'}`,
      '仅基于当前项目资料，自动完成 Template Parser、Question Generator、Duplicate Checker、Answer Generator、Reviewer 与 Formatter。',
      '覆盖企业介绍、商业模式、产品能力、团队、市场、竞争、财务、融资、风险、合规、知识产权、客户、行业、运营和未来规划。',
      '每一个非空回答必须引用当前项目资料；资料不足时必须明确写“暂无相关资料。”；最终同时输出可编辑 Word 和版式一致的 PDF。',
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
}: {
  disabled: boolean
  projects: Project[]
  currentProjectId: string
  onRunTask: (request: AiQuickTaskRequest) => Promise<boolean>
}) {
  const [activeAction, setActiveAction] = useState<ActionConfig | null>(null)
  const [sourceCutoffDate, setSourceCutoffDate] = useState(today)
  const [audience, setAudience] = useState('内部立项')
  const [length, setLength] = useState('标准版')
  const [proposalInstructions, setProposalInstructions] = useState('')
  const [template, setTemplate] = useState('公司标准模板')
  const [pageCount, setPageCount] = useState('12-15页')
  const [language, setLanguage] = useState('中文')
  const [diligenceScope, setDiligenceScope] = useState('商业尽调')
  const [qaMode, setQaMode] = useState('投资委员会 Q&A')
  const [questionDepth, setQuestionDepth] = useState('标准版')
  const [submitting, setSubmitting] = useState(false)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId),
    [currentProjectId, projects],
  )

  const openAction = (action: ActionConfig) => {
    if (disabled || !selectedProject) return
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
        userInstructions: proposalInstructions.trim(),
        template,
        pageCount,
        language,
        diligenceScope,
        qaMode,
        questionDepth,
        outputFormat: activeAction.id === 'investment_ppt'
          ? 'PPTX'
          : activeAction.id === 'qa'
            ? 'DOCX+PDF'
            : 'DOCX',
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
                  <span className="block truncate text-[9px] text-slate-400">确认参数后执行</span>
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
            <>
              <div className="grid grid-cols-2 gap-4">
                <label><span className="label">目标受众</span><select className="input" value={audience} onChange={(event) => setAudience(event.target.value)}><option>内部立项</option><option>基金内部汇报</option><option>合作方沟通</option></select></label>
                <label><span className="label">篇幅</span><select className="input" value={length} onChange={(event) => setLength(event.target.value)}><option>精简版</option><option>标准版</option><option>详细版</option></select></label>
              </div>
              <label className="block">
                <span className="label">补充项目数据或写作要求（可选）</span>
                <textarea
                  className="input min-h-24 resize-y"
                  value={proposalInstructions}
                  maxLength={2000}
                  placeholder="例如：本轮拟投资金额、投资主体、需重点说明的交易安排；与项目资料冲突时系统会标记为待核验。"
                  onChange={(event) => setProposalInstructions(event.target.value)}
                />
                <span className="mt-1 block text-right text-[10px] text-slate-400">{proposalInstructions.length}/2000</span>
              </label>
            </>
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
          {activeAction?.id === 'qa' && (
            <div className="grid grid-cols-2 gap-4">
              <label>
                <span className="label">Q&amp;A 类型</span>
                <select className="input" value={qaMode} onChange={(event) => setQaMode(event.target.value)}>
                  <option>投资委员会 Q&amp;A</option>
                  <option>尽调 Q&amp;A</option>
                </select>
              </label>
              <label>
                <span className="label">问题深度</span>
                <select className="input" value={questionDepth} onChange={(event) => setQuestionDepth(event.target.value)}>
                  <option>标准版</option>
                  <option>深度版</option>
                </select>
              </label>
            </div>
          )}
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            输出格式：<strong className="text-slate-700">{activeAction?.id === 'investment_ppt' ? 'PPTX' : activeAction?.id === 'qa' ? 'DOCX + PDF' : 'DOCX'}</strong>
          </div>
        </div>
      </Modal>

    </>
  )
}
