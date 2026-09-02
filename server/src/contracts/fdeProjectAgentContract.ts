import { z } from 'zod'

export const agentDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}, '日期无效')
export const projectAgentConfigSchema = z.object({
  enabled: z.boolean(), analyzeDocuments: z.boolean(), analyzeCommunications: z.boolean(),
  modelEnabled: z.boolean(), confidenceThreshold: z.number().min(0.3).max(0.95),
}).strict()
export type ProjectAgentConfig = z.infer<typeof projectAgentConfigSchema>
export const defaultProjectAgentConfig: ProjectAgentConfig = {
  enabled: true, analyzeDocuments: true, analyzeCommunications: true, modelEnabled: true, confidenceThreshold: 0.65,
}
const command = { clientRequestId: z.string().uuid() }
export const agentConfigInput = z.object({ ...command, expectedVersion: z.number().int().min(0), configuration: projectAgentConfigSchema }).strict()
export const agentRunInput = z.object({ ...command, expectedConfigVersion: z.number().int().min(0) }).strict()
export const agentDecisionInput = z.object({ ...command, expectedVersion: z.number().int().positive(),
  decision: z.enum(['accepted', 'accepted_with_changes', 'rejected', 'dismissed']),
  note: z.string().trim().max(600).default(''), suggestedDate: agentDate.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.decision !== 'accepted' && value.note.length < 6) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: '请填写至少 6 字处理原因' })
  if (value.decision === 'accepted_with_changes' && !value.suggestedDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['suggestedDate'], message: '调整后采纳需要有效日期' })
  if (value.decision !== 'accepted_with_changes' && value.suggestedDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['suggestedDate'], message: '仅调整后采纳允许修改建议日期' })
})
export const agentListInput = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(30).default(10) }).strict()
export const agentReceiptSchema = z.object({ kind: z.enum(['config', 'run', 'decision', 'schedule', 'timeline', 'replan']), id: z.string().uuid(), version: z.number().int().positive() }).strict()
export const agentResolutionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('committed'), receipt: agentReceiptSchema }).strict(),
  z.object({ state: z.literal('closed'), receipt: z.null() }).strict(),
])
export type AgentEvidence = { id: string; kind: 'project' | 'policy' | 'plan' | 'material' | 'file' | 'task' | 'approval' | 'record' | 'leadership'; label: string; version: number; fingerprint: string }
export type ProjectAgentFacts = {
  projectId: string; projectVersion: number; asOfDate: string; stage: string; lifecycle: string;
  targetDate: string | null; currentDate: string | null; dateBasis: 'cycle_projection' | 'approved' | 'none';
  dateWindow?: { minimum: string; maximum: string; available: boolean } | null;
  gateKnown: boolean; gateMissing: string[]; incomplete: boolean;
  tasks: Array<{ id: string; title: string; status: string; overdue: boolean; blocked: boolean }>;
  activeApprovalIds: string[]; pendingExtensionIds: string[];
  evidence: AgentEvidence[];
  observations: Array<{ id: string; text: string }>;
}
export const agentRecommendationSchema = z.object({
  action: z.enum(['keep', 'advance', 'delay', 'pause', 'escalate', 'information_required']),
  health: z.enum(['on_track', 'needs_information', 'blocked', 'at_risk', 'waiting_approval', 'overdue']),
  title: z.string().trim().min(1).max(160), summary: z.string().trim().min(1).max(800), rationale: z.string().trim().min(1).max(1600),
  severity: z.enum(['info', 'warning', 'critical']), confidence: z.number().min(0).max(1),
  currentDate: agentDate.nullable(), suggestedDate: agentDate.nullable(),
  evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(12), missingInformation: z.array(z.string().max(300)).max(50),
}).strict()
export type AgentRecommendation = z.infer<typeof agentRecommendationSchema>
export type AgentScheduleDraft = {
  status: 'awaiting_submission'; stage: string; currentDate: string; suggestedDate: string;
  dateBasis: 'cycle_projection' | 'approved'; projectVersion: number; inputHash: string;
}
export type ProjectAgentDashboard = {
  projectId: string; config: { configuration: ProjectAgentConfig; version: number; mode: string; cadence: string; autoApply: boolean };
  capabilities: { run: boolean; configure: boolean }; total: number; page: number; pageSize: number;
  runs: Array<{ id: string; status: string; provider: string; fallbackReason: string | null; startedAt: string; completedAt: string | null;
    readable: boolean; stale: boolean; dateBasis: string; canDecide: boolean; canSubmitSchedule: boolean;
    recommendation: (AgentRecommendation & { id: string; version: number; status: string }) | null;
    decision: { id: string; decision: string; note: string; scheduleDraft: AgentScheduleDraft | null; createdAt: string } | null;
    evidence: Array<Omit<AgentEvidence, 'fingerprint'>> }>
}

export function agentDayOffset(date: string, offset: number) {
  return new Date(new Date(`${agentDate.parse(date)}T00:00:00Z`).getTime() + offset * 86400000).toISOString().slice(0, 10)
}
// Reference stagePlannedDate: a projection, never an invented approval or actual completion date.
export function projectedAgentStageDate(stage: string, targetDate: string | null, cycleDays: number): string | null {
  const positions: Record<string, number> = { 入库: 0, 立项: .10, 尽调计划制定: .18, 尽调计划审核: .22, 启动尽调: .58, 内核: .75, 投决: .90, 打款: 1 }
  if (!(stage in positions) || !agentDate.safeParse(targetDate).success || ![15, 30, 40].includes(cycleDays)) return null
  return agentDayOffset(targetDate!, -Math.round((1 - positions[stage]) * cycleDays))
}

export function evaluateProjectAgentRules(facts: ProjectAgentFacts): AgentRecommendation {
  const base: AgentRecommendation = { action: 'keep', health: 'on_track', title: `${facts.stage}按当前计划推进`,
    summary: '当前可见的材料、行动和审批未发现需要改期的硬信号；正式推进仍须通过业务审批。',
    rationale: '研判只提供建议，不修改阶段、任务、日程或责任记录。', severity: 'info', confidence: .82,
    currentDate: facts.currentDate, suggestedDate: null, evidenceIds: [facts.evidence.find(e => e.kind === 'project')!.id], missingInformation: [] }
  const cite = (ids: string[]) => [...new Set([...base.evidenceIds, ...ids])].slice(0, 12)
  if (!facts.gateKnown || facts.incomplete || facts.lifecycle !== 'active') return { ...base, action: 'information_required', health: 'needs_information', severity: 'warning', confidence: .96,
    title: '先核对完整且有效的项目事实', summary: '项目状态、阶段或授权来源不完整，不能据局部事实认定具备推进条件。', missingInformation: ['有效项目、阶段及完整授权来源'] }
  // An in-flight stage/date decision or extension cannot be bypassed by a new date proposal.
  if (facts.activeApprovalIds.length || facts.pendingExtensionIds.length) return { ...base, health: 'waiting_approval', confidence: .9,
    title: '等待当前审批处理', summary: '当前存在未完成审批或延期申请，批准前维持现有节点日期。',
    evidenceIds: cite([...facts.activeApprovalIds, ...facts.pendingExtensionIds]) }
  if (facts.gateMissing.length) {
    const nearNodeDate = !facts.currentDate || facts.currentDate <= agentDayOffset(facts.asOfDate, 5)
    if (!nearNodeDate) return { ...base, confidence: .86, title: `${facts.stage}正常准备中`,
      summary: `当前有 ${facts.gateMissing.length} 项阶段材料正在准备，距离节点日期仍有处理空间，暂未判断为改期风险。`,
      evidenceIds: cite(facts.evidence.filter(e => e.kind === 'material' || e.kind === 'policy').map(e => e.id)), missingInformation: facts.gateMissing }
    return { ...base, action: 'pause', health: 'blocked', severity: 'warning', confidence: .98,
      title: `${facts.stage}临近节点，材料仍待补齐`, summary: `当前阶段有 ${facts.gateMissing.length} 项材料未完成，请优先补齐或按规定办理免传。`,
      evidenceIds: cite(facts.evidence.filter(e => e.kind === 'material' || e.kind === 'policy').map(e => e.id)), missingInformation: facts.gateMissing }
  }
  const affected = facts.tasks.filter(task => task.overdue || task.blocked)
  if (affected.length) {
    const suggestedDate = facts.currentDate ? agentDayOffset(facts.currentDate > facts.asOfDate ? facts.currentDate : facts.asOfDate, Math.min(10, Math.max(3, affected.length * 2))) : null
    if (facts.dateWindow && (!facts.dateWindow.available || suggestedDate && suggestedDate > facts.dateWindow.maximum)) return { ...base, action: 'escalate', health: 'at_risk', severity: 'warning', confidence: .95, title: '节点没有可用延期空间，请复核整体计划', summary: '行动存在阻塞，但延期会越过后续节点或最终目标日；本次不生成可直接提交的日期草案。', evidenceIds: cite(affected.map(t => t.id)) }
    return { ...base, action: 'delay', health: 'at_risk', severity: 'warning', confidence: .9,
    title: '先处理行动阻塞，再确认节点日期', summary: `${affected.filter(t => t.overdue).length} 项行动逾期，${affected.filter(t => t.blocked).length} 项行动存在阻塞；请负责人核对调整方案。`,
    suggestedDate,
    evidenceIds: cite(affected.map(t => t.id)), missingInformation: facts.currentDate ? [] : ['当前阶段日期基准'] }
  }
  if (facts.targetDate && facts.targetDate < facts.asOfDate) return { ...base, action: 'escalate', health: 'overdue', severity: 'critical', confidence: .99,
    title: '项目目标日期已过，请领导重新确认基准', summary: '目标日期失效，不能继续以原时间线推断项目正常；应按正式变更流程处理。' }
  let advanceDate = agentDayOffset(facts.asOfDate, 2)
  if (facts.dateWindow && advanceDate < facts.dateWindow.minimum) advanceDate = facts.dateWindow.minimum
  if (facts.currentDate && facts.currentDate > agentDayOffset(facts.asOfDate, 3) && advanceDate < facts.currentDate && (!facts.dateWindow || facts.dateWindow.available && advanceDate <= facts.dateWindow.maximum)) return { ...base, action: 'advance', title: `${facts.stage}可考虑提前复核`,
    summary: '当前未发现硬阻塞，可由项目责任人核对提前复核方案；采纳仅形成草案，不改变正式日期。', suggestedDate: advanceDate }
  return base
}

export function projectAgentModelPacket(facts: ProjectAgentFacts, config: ProjectAgentConfig) {
  const excluded = new Set<string>()
  if (!config.analyzeDocuments) ['file', 'material'].forEach(kind => excluded.add(kind))
  if (!config.analyzeCommunications) ['record', 'leadership', 'approval'].forEach(kind => excluded.add(kind))
  const evidence = facts.evidence.filter(item => !excluded.has(item.kind))
  const ids = new Set(evidence.map(item => item.id))
  // Only permitted, bounded evidence and observations; no source snapshots or raw file bytes.
  return { projectId: facts.projectId, stage: facts.stage, asOfDate: facts.asOfDate, currentDate: facts.currentDate,
    targetDate: facts.targetDate, dateWindow: facts.dateWindow ?? null, evidence, observations: facts.observations.filter(item => ids.has(item.id)) }
}

export function mergeProjectAgentModel(facts: ProjectAgentFacts, config: ProjectAgentConfig, raw: unknown) {
  const rules = evaluateProjectAgentRules(facts), parsed = agentRecommendationSchema.safeParse(raw)
  const fail = (reason: string) => ({ recommendation: rules, usedModel: false, fallbackReason: reason })
  if (!parsed.success) return fail('MODEL_SCHEMA_INVALID')
  const result = parsed.data, allowed = new Set(projectAgentModelPacket(facts, config).evidence.map(e => e.id))
  if (result.evidenceIds.some(id => !allowed.has(id))) return fail('MODEL_EVIDENCE_INVALID')
  if (rules.health !== 'on_track') return fail('DETERMINISTIC_GATE_PREVAILS')
  if (result.confidence < config.confidenceThreshold) return fail('MODEL_CONFIDENCE_LOW')
  if (result.currentDate !== facts.currentDate || result.suggestedDate && (!facts.currentDate || !['advance', 'delay'].includes(result.action) || result.suggestedDate <= facts.asOfDate)) return fail('MODEL_DATE_INVALID')
  if (result.action === 'advance' && (!result.suggestedDate || result.suggestedDate >= facts.currentDate!)) return fail('MODEL_DATE_INVALID')
  if (result.action === 'delay' && (!result.suggestedDate || result.suggestedDate <= facts.currentDate!)) return fail('MODEL_DATE_INVALID')
  if (result.suggestedDate && facts.dateWindow && (!facts.dateWindow.available || result.suggestedDate < facts.dateWindow.minimum || result.suggestedDate > facts.dateWindow.maximum)) return fail('MODEL_DATE_INVALID')
  return { recommendation: result, usedModel: true, fallbackReason: null }
}

export function agentSourcesStillCurrent(snapshot: AgentEvidence[], current: AgentEvidence[]) {
  const map = new Map(current.map(e => [e.id, e]))
  return snapshot.every(item => map.get(item.id)?.fingerprint === item.fingerprint)
}
