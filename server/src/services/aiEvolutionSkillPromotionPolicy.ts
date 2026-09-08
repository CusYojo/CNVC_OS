import { z } from 'zod'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'

const targetSchema = z.object({ bindingId: z.string().uuid(), versionId: z.string().uuid(),
  fallbackVersionId: z.string().uuid(), capabilityId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  scope: z.object({ type: z.enum(['user', 'project']), key: z.string().uuid() }).strict(),
}).strict()

/** Promotion has a distinct approval digest; a trial approval cannot authorize permanent use. */
export function evolutionSkillPromotionTarget(raw: unknown) {
  const target = targetSchema.parse(raw)
  if (target.versionId === target.fallbackVersionId) throw evolutionError(409, 'EVOLUTION_NO_CHANGE', '正式版本必须不同于回退版本')
  return { ...target, environment: `skill-promotion:${evolutionContentHash(target)}` }
}

export function assertEvolutionSkillPromotionBinding(input: {
  target: ReturnType<typeof evolutionSkillPromotionTarget>
  binding: { id: string; capabilityId: string; scopeType: string; scopeKey: string; revision: number;
    activeVersionId: string; fallbackVersionId: string | null; trialExpiresAt: Date | null }
  now: Date
}) {
  const { environment, ...raw } = input.target
  const target = evolutionSkillPromotionTarget(raw)
  const binding = input.binding
  if (environment !== target.environment || !Number.isFinite(input.now.getTime())
    || binding.id !== target.bindingId || binding.capabilityId !== target.capabilityId
    || binding.scopeType !== target.scope.type || binding.scopeKey !== target.scope.key
    || binding.revision !== target.expectedRevision || binding.activeVersionId !== target.versionId
    || binding.fallbackVersionId !== target.fallbackVersionId || !binding.trialExpiresAt
    || !Number.isFinite(binding.trialExpiresAt.getTime()) || binding.trialExpiresAt <= input.now) {
    throw evolutionError(409, 'EVOLUTION_PROMOTION_BINDING', '仅能确认当前范围内尚未到期且版本未变化的试用')
  }
}
