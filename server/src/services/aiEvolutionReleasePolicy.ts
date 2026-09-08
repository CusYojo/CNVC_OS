import type { EvolutionScope, EvolutionKind } from '../contracts/aiEvolutionContract.js'
import type { EvolutionEvaluationReport } from '../contracts/aiEvolutionEvaluationContract.js'
import { evaluationHasRequiredEvidence } from '../contracts/aiEvolutionEvaluationContract.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'

export type EvolutionReleaseAuthorization = {
  purpose: 'release'; candidateId: string; candidateHash: string; evaluationHash: string;
  actorUserId: string; scope: EvolutionScope; targetEnvironment: string; expiresAt: Date; decision: 'approved' | 'rejected';
}

/** Deployment adapters must call this with current server-owned records immediately before claiming a release. */
export function assertEvolutionReleaseBinding(input: {
  candidate: { id: string; kind: EvolutionKind; status: string; contentHash: string; sourceHash: string; baseRef: string; scope: EvolutionScope };
  evaluation: { candidateHash: string; hash: string; report: EvolutionEvaluationReport };
  authorization: EvolutionReleaseAuthorization;
  actor: { userId: string; enabled: boolean; targetEnvironmentGrant: boolean };
  targetEnvironment: string; currentBaseRef: string; now: Date;
  operation?: 'skill_promotion';
}) {
  const { candidate, evaluation, authorization, actor } = input
  if (!actor.enabled || !actor.targetEnvironmentGrant || actor.userId !== authorization.actorUserId) {
    throw evolutionError(403, 'EVOLUTION_RELEASE_FORBIDDEN', '缺少当前目标环境的明确发布授权')
  }
  if (authorization.purpose !== 'release' || authorization.decision !== 'approved'
    || !Number.isFinite(authorization.expiresAt.getTime()) || !Number.isFinite(input.now.getTime()) || authorization.expiresAt <= input.now) {
    throw evolutionError(409, 'EVOLUTION_RELEASE_APPROVAL_REQUIRED', '需要仍在有效期内的明确发布批准')
  }
  const validStatus = input.operation === 'skill_promotion'
    ? candidate.kind === 'skill' && candidate.status === 'active' && /^skill-promotion:[a-f0-9]{64}$/.test(input.targetEnvironment)
    : candidate.status === 'approved'
  if (!validStatus || authorization.candidateId !== candidate.id || authorization.candidateHash !== candidate.contentHash
    || evaluation.candidateHash !== candidate.contentHash || authorization.evaluationHash !== evaluation.hash
    || authorization.targetEnvironment !== input.targetEnvironment || !input.targetEnvironment.trim()
    || evolutionContentHash(authorization.scope) !== evolutionContentHash(candidate.scope)
    || evaluation.report.candidateHash !== candidate.sourceHash || !evaluationHasRequiredEvidence(candidate.kind, evaluation.report)) {
    throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '候选、验收、作用域或目标环境与发布批准不一致')
  }
  if (candidate.baseRef !== input.currentBaseRef || !input.currentBaseRef.trim()) {
    throw evolutionError(409, 'EVOLUTION_REEVALUATION_REQUIRED', '当前基线已变化，需要合并后重新评估并取得新的发布批准')
  }
}
