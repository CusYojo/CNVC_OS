import { z } from 'zod'
import { evolutionSkillPromotionTarget, assertEvolutionSkillPromotionBinding } from './aiEvolutionSkillPromotionPolicy.js'
import { aiEvolutionSkillRegistry, aiEvolutionService, aiEvolutionArtifactStore, getAiEvolutionCandidateForUser } from './aiEvolutionApplicationService.js'
import { evolutionSkillTrialTarget } from './aiEvolutionSkillTrialPolicy.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'
import { getAccessibleProject } from './projectAccessService.js'
import { MySqlAiEvolutionSkillBindingRepository } from '../repositories/mysql/mysqlAiEvolutionSkillBindingRepository.js'
import { MySqlAiEvolutionSkillVersionRepository } from '../repositories/mysql/mysqlAiEvolutionSkillVersionRepository.js'
import { MySqlAiEvolutionCandidateRepository } from '../repositories/mysql/mysqlAiEvolutionCandidateRepository.js'

export async function getAiEvolutionSkillTrialStatus(userId: string, candidateId: string) {
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  const run = await aiEvolutionService.authorizeRun(userId, candidate.runId)
  if (run.frozenSpec.target.type !== 'skill') throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '技能候选不存在')
  const scope = z.object({ type: z.enum(['user', 'project']), key: z.string().uuid() }).parse(candidate.scope)
  const binding = await new MySqlAiEvolutionSkillBindingRepository().findForScope(run.frozenSpec.target.capabilityId, scope)
  if (!binding) return { candidateHash: candidate.contentHash, binding: null }
  const version = await new MySqlAiEvolutionSkillVersionRepository().findForOwner(userId, binding.activeVersionId)
  const matchesCandidate = version?.contentHash === candidate.manifest.sourceHash
  let canRollback = false
  if (matchesCandidate && binding.updatedBy === userId && binding.fallbackVersionId) {
    try {
      await authorizeTrial(userId, candidateId, { capabilityId: binding.capabilityId, scope })
      canRollback = true
    } catch (error) {
      if (!['EVOLUTION_RELEASE_FORBIDDEN', 'EVOLUTION_CAPABILITY_FORBIDDEN', 'EVOLUTION_SCOPE_FORBIDDEN'].includes((error as { code?: string }).code ?? '')) throw error
    }
  }
  await getAiEvolutionCandidateForUser(userId, candidateId)
  return { candidateHash: candidate.contentHash, binding: { bindingId: binding.id, revision: binding.revision,
    matchesCandidate, canRollback, trialExpiresAt: binding.trialExpiresAt?.toISOString() ?? null,
    expired: binding.trialExpiresAt !== null && binding.trialExpiresAt.getTime() <= Date.now() } }
}

export async function planAiEvolutionSkillTrial(userId: string, candidateId: string, raw: unknown) {
  const input = z.object({ versionId: z.string().uuid(), fallbackVersionId: z.string().uuid(),
    durationSeconds: z.number().int().min(60).max(2592000) }).strict().parse(raw)
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  const run = await aiEvolutionService.authorizeRun(userId, candidate.runId)
  if (run.frozenSpec.target.type !== 'skill' || !['user', 'project'].includes(candidate.scope.type)) {
    throw evolutionError(409, 'EVOLUTION_RELEASE_KIND', '候选不支持技能限时试用')
  }
  const scope = z.object({ type: z.enum(['user', 'project']), key: z.string().uuid() }).parse(candidate.scope)
  const capabilityId = run.frozenSpec.target.capabilityId
  const grant = await authorizeTrial(userId, candidateId, { capabilityId, scope })
  if (input.durationSeconds > grant.maxTrialSeconds) throw evolutionError(409, 'EVOLUTION_SKILL_TRIAL_BINDING', '试用时长超过授权上限')
  const repository = new MySqlAiEvolutionSkillVersionRepository()
  const version = await repository.findForOwner(userId, input.versionId)
  const fallback = await repository.findForOwner(userId, input.fallbackVersionId)
  if (!version || !fallback || version.capabilityId !== capabilityId || fallback.capabilityId !== capabilityId
    || version.contentHash !== candidate.manifest.sourceHash || fallback.contentHash !== candidate.baseRef) {
    throw evolutionError(409, 'EVOLUTION_SKILL_TRIAL_BINDING', '版本与候选基线不一致')
  }
  const binding = await new MySqlAiEvolutionSkillBindingRepository().findForScope(capabilityId, scope)
  if (binding && (binding.activeVersionId !== fallback.id || binding.trialExpiresAt !== null)) {
    throw evolutionError(409, 'EVOLUTION_REVISION_CONFLICT', '当前范围已有其他版本或试用，请先处理现有试用')
  }
  const target = evolutionSkillTrialTarget({ versionId: version.id, fallbackVersionId: fallback.id, capabilityId,
    scope, expectedRevision: binding?.revision ?? 0, trialExpiresAt: new Date(Date.now() + input.durationSeconds * 1000).toISOString() })
  const current = await authorizeTrial(userId, candidateId, target)
  if (current.authorizationHash !== grant.authorizationHash) throw evolutionError(409, 'EVOLUTION_INPUT_CHANGED', '技能发布授权已变化')
  const { environment: _environment, ...publicTarget } = target
  return { target: publicTarget, candidateHash: candidate.contentHash, evaluationHash: candidate.evaluation.hash,
    maxTrialSeconds: grant.maxTrialSeconds }
}

export async function activateAiEvolutionSkillTrial(userId: string, candidateId: string, raw: unknown, idempotencyKey: unknown) {
  const input = z.object({ target: z.unknown(), approvalId: z.string().uuid() }).strict().parse(raw)
  const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(idempotencyKey)
  const target = evolutionSkillTrialTarget(input.target)
  const authorize = () => authorizeTrial(userId, candidateId, target)
  const grant = await authorize()
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  await aiEvolutionArtifactStore.verifyManifest(candidate.runId, candidate.manifest)
  const current = await authorize()
  if (current.authorizationHash !== grant.authorizationHash) throw evolutionError(409, 'EVOLUTION_INPUT_CHANGED', '技能发布授权已变化')
  return new MySqlAiEvolutionSkillBindingRepository().activateTrial({ target, approvalId: input.approvalId,
    idempotencyKey: key, expectedCandidateId: candidateId, maxTrialSeconds: current.maxTrialSeconds,
    actor: { userId, enabled: true, targetEnvironmentGrant: true } }, aiEvolutionArtifactStore)
}

async function authorizeTrial(userId: string, candidateId: string, target: Pick<ReturnType<typeof evolutionSkillTrialTarget>, 'capabilityId' | 'scope'>) {
    const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
    const run = await aiEvolutionService.authorizeRun(userId, candidate.runId)
    if (run.frozenSpec.target.type !== 'skill' || run.frozenSpec.target.capabilityId !== target.capabilityId
      || evolutionContentHash(candidate.scope) !== evolutionContentHash(target.scope)) {
      throw evolutionError(403, 'EVOLUTION_RELEASE_FORBIDDEN', '试用范围与目标技能候选不一致')
    }
    if (target.scope.type === 'user' ? target.scope.key !== userId : !await getAccessibleProject(userId, target.scope.key)) {
      throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '无权发布到目标范围')
    }
    return aiEvolutionSkillRegistry.resolvePublication(userId, target.capabilityId, target.scope)
}

export async function rollbackAiEvolutionSkillTrial(userId: string, candidateId: string, raw: unknown, idempotencyKey: unknown) {
  const input = z.object({ bindingId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict().parse(raw)
  const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(idempotencyKey)
  const repository = new MySqlAiEvolutionSkillBindingRepository()
  const binding = await repository.findForPublisher(userId, input.bindingId)
  if (!binding) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '技能绑定不存在或无权回退')
  const scope = z.object({ type: z.enum(['user', 'project']), key: z.string().uuid() }).parse({ type: binding.scopeType, key: binding.scopeKey })
  await authorizeTrial(userId, candidateId, { capabilityId: binding.capabilityId, scope })
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  return repository.rollbackTrial({ ...input, idempotencyKey: key, expectedActiveHash: candidate.manifest.sourceHash,
    actor: { userId, enabled: true, targetEnvironmentGrant: true } }, aiEvolutionArtifactStore)
}

export async function approveAiEvolutionSkillTrial(userId: string, candidateId: string, raw: unknown) {
  const input = z.object({ target: z.unknown(), candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
    evaluationHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw)
  const target = evolutionSkillTrialTarget(input.target)
  const grant = await authorizeTrial(userId, candidateId, target)
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  const repository = new MySqlAiEvolutionSkillVersionRepository()
  const version = await repository.findForOwner(userId, target.versionId)
  const fallback = await repository.findForOwner(userId, target.fallbackVersionId)
  const remaining = new Date(target.trialExpiresAt).getTime() - Date.now()
  if (!version || !fallback || version.capabilityId !== target.capabilityId || fallback.capabilityId !== target.capabilityId
    || version.contentHash !== candidate.manifest.sourceHash || fallback.contentHash !== candidate.baseRef
    || remaining <= 0 || remaining > grant.maxTrialSeconds * 1000) {
    throw evolutionError(409, 'EVOLUTION_SKILL_TRIAL_BINDING', '试用版本、回退版本或期限不符合发布要求')
  }
  await aiEvolutionArtifactStore.verifyManifest(candidate.runId, candidate.manifest)
  const current = await authorizeTrial(userId, candidateId, target)
  if (current.authorizationHash !== grant.authorizationHash) throw evolutionError(409, 'EVOLUTION_INPUT_CHANGED', '技能发布授权已变化')
  return new MySqlAiEvolutionCandidateRepository().recordReleaseApproval(candidateId, {
    actor: { userId, enabled: true, targetEnvironmentGrant: true }, currentBaseRef: fallback.contentHash,
    candidateHash: input.candidateHash, evaluationHash: input.evaluationHash, scope: target.scope,
    targetEnvironment: target.environment, expiresAt: new Date(Math.min(Date.now() + 3600000, new Date(target.trialExpiresAt).getTime())),
  })
}

export async function planAiEvolutionSkillPromotion(userId: string, candidateId: string, raw: unknown) {
  const { bindingId } = z.object({ bindingId: z.string().uuid() }).strict().parse(raw)
  const binding = await new MySqlAiEvolutionSkillBindingRepository().findForPublisher(userId, bindingId)
  if (!binding || !binding.fallbackVersionId) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '没有可确认的试用')
  const target = evolutionSkillPromotionTarget({ bindingId, capabilityId: binding.capabilityId,
    versionId: binding.activeVersionId, fallbackVersionId: binding.fallbackVersionId, expectedRevision: binding.revision,
    scope: { type: binding.scopeType, key: binding.scopeKey } })
  await authorizeTrial(userId, candidateId, target)
  assertEvolutionSkillPromotionBinding({ target, binding, now: new Date() })
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  const version = await new MySqlAiEvolutionSkillVersionRepository().findForOwner(userId, target.versionId)
  if (version?.contentHash !== candidate.manifest.sourceHash) throw evolutionError(409, 'EVOLUTION_PROMOTION_BINDING', '当前试用与候选不一致')
  const { environment: _environment, ...publicTarget } = target
  return { target: publicTarget, candidateHash: candidate.contentHash, evaluationHash: candidate.evaluation.hash }
}

export async function approveAiEvolutionSkillPromotion(userId: string, candidateId: string, raw: unknown) {
  const input = z.object({ target: z.unknown(), candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
    evaluationHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw)
  const target = evolutionSkillPromotionTarget(input.target)
  const grant = await authorizeTrial(userId, candidateId, target)
  const binding = await new MySqlAiEvolutionSkillBindingRepository().findForPublisher(userId, target.bindingId)
  if (!binding) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '试用绑定不存在')
  assertEvolutionSkillPromotionBinding({ target, binding, now: new Date() })
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  await aiEvolutionArtifactStore.verifyManifest(candidate.runId, candidate.manifest)
  const current = await authorizeTrial(userId, candidateId, target)
  if (current.authorizationHash !== grant.authorizationHash) throw evolutionError(409, 'EVOLUTION_INPUT_CHANGED', '发布授权已变化')
  return new MySqlAiEvolutionCandidateRepository().recordReleaseApproval(candidateId, {
    operation: 'skill_promotion', actor: { userId, enabled: true, targetEnvironmentGrant: true }, currentBaseRef: candidate.baseRef,
    candidateHash: input.candidateHash, evaluationHash: input.evaluationHash, scope: target.scope, targetEnvironment: target.environment,
    expiresAt: new Date(Math.min(Date.now() + 3600000, binding.trialExpiresAt!.getTime())),
  })
}

export async function promoteAiEvolutionSkillTrial(userId: string, candidateId: string, raw: unknown, idempotencyKey: unknown) {
  const input = z.object({ target: z.unknown(), approvalId: z.string().uuid() }).strict().parse(raw)
  const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(idempotencyKey)
  const target = evolutionSkillPromotionTarget(input.target)
  const grant = await authorizeTrial(userId, candidateId, target)
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  await aiEvolutionArtifactStore.verifyManifest(candidate.runId, candidate.manifest)
  const current = await authorizeTrial(userId, candidateId, target)
  if (current.authorizationHash !== grant.authorizationHash) throw evolutionError(409, 'EVOLUTION_INPUT_CHANGED', '发布授权已变化')
  return new MySqlAiEvolutionSkillBindingRepository().promoteTrial({ target, approvalId: input.approvalId,
    expectedCandidateId: candidateId, idempotencyKey: key, actor: { userId, enabled: true, targetEnvironmentGrant: true } }, aiEvolutionArtifactStore)
}
