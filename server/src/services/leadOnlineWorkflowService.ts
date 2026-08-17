import type { PublicIntelResult } from './leadPublicIntelService.js'
import { buildLeadResearchHostPackage } from './leadResearchToolService.js'
import { executeLeadWorkflowStage } from './leadWorkflowPipelineService.js'
import type { LeadWorkflowAgentQueryFactory } from './leadWorkflowAgentService.js'
import { transitionLeadPipelineItem } from './leadPipelineEventService.js'
import { openLeadPipelineReview } from './leadPipelineAuditService.js'
import { redactSensitiveText } from '../security/redactSecrets.js'

type LeadWorkflowSubjectType = 'company' | 'project' | 'team' | 'lab' | 'paper'

function stagePrompt(base: string, label: string, priorOutput: Record<string, unknown>) {
  return `${base}\n\n【${label}，同样属于宿主输入】\n${JSON.stringify(priorOutput)}`
}

export async function runPublicIntelIntakeAgents(input: {
  eventId: string
  company: string
  intel: PublicIntelResult
  model?: string
}, options: {
  researchQueryFactory?: LeadWorkflowAgentQueryFactory
  screeningQueryFactory?: LeadWorkflowAgentQueryFactory
} = {}) {
  const host = await buildLeadResearchHostPackage({
    eventId: input.eventId,
    company: input.company,
    providedPublicIntel: input.intel,
  })
  const common = {
    eventId: input.eventId,
    subjectType: 'company' as const,
    subjectName: input.company,
    model: input.model,
  }
  const research = await executeLeadWorkflowStage({
    ...common,
    profile: 'lead-research-agent',
    idempotencyKey: `${input.eventId}:lead-research-agent:intake:v1`,
    prompt: host.prompt,
    hostToolCalls: host.hostToolCalls,
  }, { queryFactory: options.researchQueryFactory })
  const screening = await executeLeadWorkflowStage({
    ...common,
    profile: 'lead-screening-agent',
    idempotencyKey: `${input.eventId}:lead-screening-agent:v1`,
    prompt: stagePrompt(host.prompt, '研究事实包', research.decision.output),
  }, { queryFactory: options.screeningQueryFactory })
  return { host, research, screening }
}

export async function runPublicIntelEnrichmentAgents(input: {
  eventId: string
  leadId: string
  company: string
  intel: PublicIntelResult
  model?: string
}, options: {
  researchQueryFactory?: LeadWorkflowAgentQueryFactory
  enrichmentQueryFactory?: LeadWorkflowAgentQueryFactory
} = {}) {
  const host = await buildLeadResearchHostPackage({
    eventId: input.eventId,
    company: input.company,
    leadId: input.leadId,
    providedPublicIntel: input.intel,
  })
  const common = {
    eventId: input.eventId,
    subjectType: 'company' as const,
    subjectName: input.company,
    model: input.model,
  }
  const research = await executeLeadWorkflowStage({
    ...common,
    profile: 'lead-research-agent',
    idempotencyKey: `${input.eventId}:lead-research-agent:enrichment:v1`,
    prompt: host.prompt,
    hostToolCalls: host.hostToolCalls,
  }, { queryFactory: options.researchQueryFactory })
  const enrichment = await executeLeadWorkflowStage({
    ...common,
    profile: 'lead-enrichment-agent',
    idempotencyKey: `${input.eventId}:lead-enrichment-agent:v1`,
    prompt: stagePrompt(host.prompt, '研究事实包', research.decision.output),
  }, { queryFactory: options.enrichmentQueryFactory })
  return { host, research, enrichment }
}

export async function runRadarIntakeAgents(input: {
  eventId: string
  subjectType: LeadWorkflowSubjectType
  subjectName: string
  legalName?: string
  model?: string
  providedPublicIntel?: PublicIntelResult
  attempt?: number
}, options: {
  researchQueryFactory?: LeadWorkflowAgentQueryFactory
  screeningQueryFactory?: LeadWorkflowAgentQueryFactory
} = {}) {
  const host = await buildLeadResearchHostPackage({
    eventId: input.eventId,
    company: input.subjectName,
    topics: ['主体核验', '融资与商业化', '团队与技术', '风险与冲突'],
    providedPublicIntel: input.providedPublicIntel,
    publicSearchPerformed: input.providedPublicIntel ? false : undefined,
  })
  const common = {
    eventId: input.eventId,
    subjectType: input.subjectType,
    subjectName: input.subjectName,
    legalName: input.legalName,
    model: input.model,
    attempt: input.attempt,
  }
  const attempt = Math.max(1, Math.round(input.attempt || 1))
  const research = await executeLeadWorkflowStage({
    ...common,
    profile: 'lead-research-agent',
    idempotencyKey: `${input.eventId}:lead-research-agent:radar-intake:attempt:${attempt}:v1`,
    prompt: host.prompt,
    hostToolCalls: host.hostToolCalls,
  }, { queryFactory: options.researchQueryFactory })
  const screening = await executeLeadWorkflowStage({
    ...common,
    profile: 'lead-screening-agent',
    idempotencyKey: `${input.eventId}:lead-screening-agent:radar-intake:attempt:${attempt}:v1`,
    prompt: stagePrompt(host.prompt, '研究事实包', research.decision.output),
  }, { queryFactory: options.screeningQueryFactory })
  return { host, research, screening }
}

export async function evaluateRadarIntakeWorkflow(input: {
  eventId: string
  subjectType: LeadWorkflowSubjectType
  subjectName: string
  legalName?: string
  subjectEvidence?: unknown[]
  subjectConfidence?: number
  model?: string
  providedPublicIntel?: PublicIntelResult
  attempt?: number
}, options: {
  researchQueryFactory?: LeadWorkflowAgentQueryFactory
  screeningQueryFactory?: LeadWorkflowAgentQueryFactory
} = {}) {
  const attempt = Math.max(1, Math.round(input.attempt || 1))
  if (attempt > 1) {
    await transitionLeadPipelineItem(input.eventId, {
      status: 'discovered',
      reason: `retry Radar research and screening with attempt ${attempt}`,
      evidence: input.subjectEvidence ?? [],
      confidence: input.subjectConfidence ?? 0,
      actorType: 'system',
      actorId: 'radar-workflow-retry',
    })
  }
  let stages: Awaited<ReturnType<typeof runRadarIntakeAgents>>
  try {
    stages = await runRadarIntakeAgents(input, options)
  } catch (error) {
    const safeError = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 8_000)
    await transitionLeadPipelineItem(input.eventId, {
      status: 'failed',
      reason: 'radar research or screening Agent failed',
      evidence: input.subjectEvidence ?? [],
      confidence: input.subjectConfidence ?? 0,
      error: safeError,
      actorType: 'system',
      actorId: 'radar-workflow-orchestrator',
    })
    return { status: 'failed' as const, stages: null, reviewId: null, error: safeError }
  }
  const outcome = stages.screening.decision.outcome
  if (outcome === 'accept') {
    return { status: 'accept' as const, stages, reviewId: null, error: null }
  }
  const status = outcome === 'reject' ? 'rejected' as const : 'review' as const
  await transitionLeadPipelineItem(input.eventId, {
    status,
    reason: stages.screening.decision.reason,
    evidence: [{
      researchDecisionId: stages.research.decision.id,
      screeningDecisionId: stages.screening.decision.id,
    }],
    confidence: stages.screening.decision.confidence ?? 0,
    actorType: 'agent',
    actorId: stages.screening.decision.actorId,
  })
  let reviewId: string | null = null
  if (status === 'review') {
    const review = await openLeadPipelineReview({
      idempotencyKey: `${input.eventId}:radar-screening-review:v1`,
      eventId: input.eventId,
      triggerDecisionId: stages.screening.decision.id,
      reason: stages.screening.decision.reason,
    })
    reviewId = review.id
  }
  return { status: outcome, stages, reviewId, error: null }
}
