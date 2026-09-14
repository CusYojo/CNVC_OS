import { z } from 'zod'
import { FDE_PROJECT_DUTIES, type FdeApprovalDuty } from './fdeGovernanceContract.js'

export const FDE_STAGE_REQUIREMENTS = [
  { stage: '入库', materials: [] },
  { stage: '立项', materials: [{ key: 'business_plan', label: '商业计划书' }, { key: 'initial_meeting', label: '初次交流纪要' }] },
  { stage: '尽调计划制定', materials: [] },
  { stage: '尽调计划审核', materials: [] },
  { stage: '启动尽调', materials: [{ key: 'business_dd', label: '业务尽调材料' }, { key: 'financial_dd', label: '财务尽调材料' }, { key: 'legal_dd', label: '法律尽调材料' }] },
  { stage: '内核', materials: [{ key: 'memo_draft', label: '投资说明书初稿' }, { key: 'loi_draft', label: '投资意向书初稿' }] },
  { stage: '投决', materials: [{ key: 'memo_final', label: '投资说明书终稿' }, { key: 'dd_report', label: '尽调报告' }, { key: 'qa', label: '项目 Q&A' }, { key: 'loi_final', label: '投资意向书终稿' }] },
  { stage: '打款', materials: [{ key: 'ic_resolution', label: '投委会决议' }, { key: 'payment_order', label: '打款单' }] },
]

const stageDuties: Record<string, FdeApprovalDuty[]> = {
  入库: ['boss'], 立项: [], 尽调计划制定: ['boss'], 尽调计划审核: [], 启动尽调: ['boss'],
  内核: ['finance', 'legal', 'boss'], 投决: ['chairman', 'president'], 打款: ['finance'],
}
const duty = z.custom<FdeApprovalDuty>((value) => value === 'boss' || FDE_PROJECT_DUTIES.some((item) => item.code === value))
const approvalLabel = (value: FdeApprovalDuty) => value === 'boss' ? '董事长/总裁审批' : FDE_PROJECT_DUTIES.find((item) => item.code === value)!.label
const approvalMode = (value: FdeApprovalDuty) => ['boss', 'finance', 'legal'].includes(value) ? '或签' as const : '会签' as const
export const fdeWorkflowPolicySchema = z.object({
  schemaVersion: z.literal(1),
  cycleDays: z.array(z.union([z.literal(15), z.literal(30), z.literal(40)])).min(1).max(3),
  stages: z.array(z.object({
    stage: z.string().min(1).max(16),
    allowWaiver: z.boolean(), requiresFund: z.boolean(),
    materials: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), label: z.string().trim().min(1).max(100) }).strict()).max(30),
    approvals: z.array(z.object({ duty, name: z.string().trim().min(1).max(100), mode: z.enum(['会签', '或签']) }).strict()).max(12),
  }).strict()).length(8),
}).strict().superRefine((config, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  if (new Set(config.cycleDays).size !== config.cycleDays.length) issue('周期不可重复')
  FDE_STAGE_REQUIREMENTS.forEach((baseline, index) => {
    const stage = config.stages[index]
    if (!stage) { issue('投资模板缺少阶段'); return }
    if (stage.stage !== baseline.stage) issue('当前投资模板必须保留八阶段名称与顺序')
    if (new Set(stage.materials.map((item) => item.key)).size !== stage.materials.length) issue(`${stage.stage}材料编号重复`)
    if (baseline.materials.some((item) => !stage.materials.some((material) => material.key === item.key))) issue(`${stage.stage}不得移除基线必需材料`)
    if (stage.stage === '内核' && !stage.requiresFund) issue('内核必须明确投资基金')
    const expected = stageDuties[stage.stage] ?? []
    if (JSON.stringify(stage.approvals.map((node) => node.duty)) !== JSON.stringify(expected)) issue(`${stage.stage}不得跳过或重排基线审批职责`)
  })
})
export type FdeWorkflowPolicyConfig = z.infer<typeof fdeWorkflowPolicySchema>
export const DEFAULT_FDE_WORKFLOW_POLICY: FdeWorkflowPolicyConfig = {
  schemaVersion: 1, cycleDays: [15, 30, 40],
  stages: FDE_STAGE_REQUIREMENTS.map((stage) => ({ ...stage, allowWaiver: true, requiresFund: stage.stage === '内核', approvals: (stageDuties[stage.stage] ?? []).map((duty) => ({ duty, name: `${approvalLabel(duty)} · ${stage.stage}`, mode: approvalMode(duty) })) })),
}
