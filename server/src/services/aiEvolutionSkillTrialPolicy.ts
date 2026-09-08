import { z } from 'zod'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'
import { assertEvolutionReleaseBinding } from './aiEvolutionReleasePolicy.js'

const schema = z.object({ versionId: z.string().uuid(), fallbackVersionId: z.string().uuid(),
  capabilityId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(),
  scope: z.object({ type: z.enum(['user', 'project']), key: z.string().min(1).max(128) }).strict(),
  trialExpiresAt: z.string().datetime(),
}).strict()

/** This digest is stored in the existing release approval's environment field. */
export function evolutionSkillTrialTarget(input: unknown) {
  const value = schema.parse(input)
  if (value.versionId === value.fallbackVersionId) throw evolutionError(409, 'EVOLUTION_NO_CHANGE', '试用版本必须不同于回退版本')
  return { ...value, environment: `skill-trial:${evolutionContentHash(value)}` }
}

export function assertEvolutionSkillTrial(input: {
  target: ReturnType<typeof evolutionSkillTrialTarget>;
  version: { id: string; capabilityId: string; contentHash: string };
  fallback: { id: string; capabilityId: string; contentHash: string };
  binding: { revision: number; activeVersionId: string; trialExpiresAt: Date | null } | null;
  maxTrialSeconds: number;
  release: Parameters<typeof assertEvolutionReleaseBinding>[0];
}) {
  const target = evolutionSkillTrialTarget({ versionId: input.target.versionId, fallbackVersionId: input.target.fallbackVersionId,
    capabilityId: input.target.capabilityId, expectedRevision: input.target.expectedRevision,
    scope: input.target.scope, trialExpiresAt: input.target.trialExpiresAt })
  const invalid = () => evolutionError(409, 'EVOLUTION_SKILL_TRIAL_BINDING', '技能试用版本、范围或期限与批准不一致')
  const duration = new Date(target.trialExpiresAt).getTime() - input.release.now.getTime()
  if (!Number.isSafeInteger(input.maxTrialSeconds) || input.maxTrialSeconds < 1 || !Number.isFinite(duration)
    || duration <= 0 || duration > input.maxTrialSeconds * 1000) throw invalid()
  if (input.target.environment !== target.environment || input.release.targetEnvironment !== target.environment
    || input.release.candidate.kind !== 'skill' || input.version.id !== target.versionId || input.fallback.id !== target.fallbackVersionId
    || input.version.capabilityId !== target.capabilityId || input.fallback.capabilityId !== target.capabilityId
    || input.version.contentHash !== input.release.candidate.sourceHash || input.fallback.contentHash !== input.release.candidate.baseRef
    || input.release.currentBaseRef !== input.fallback.contentHash
    || evolutionContentHash(target.scope) !== evolutionContentHash(input.release.candidate.scope)) throw invalid()
  if (input.binding ? input.binding.revision !== target.expectedRevision || input.binding.activeVersionId !== target.fallbackVersionId
    || input.binding.trialExpiresAt !== null
    : target.expectedRevision !== 0) {
    throw evolutionError(409, 'EVOLUTION_REVISION_CONFLICT', '技能作用域绑定已变化，请重新确认试用')
  }
  if (!input.release.evaluation.report.checks.some(check => check.id === 'improvement' && check.verdict === 'PASS')) throw invalid()
  assertEvolutionReleaseBinding(input.release)
}
