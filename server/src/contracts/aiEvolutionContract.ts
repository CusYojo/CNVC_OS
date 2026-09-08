/** Shared browser-safe vocabulary. Identity and authorization are never supplied by these inputs. */
export const EVOLUTION_KINDS = ['experience', 'skill', 'code'] as const
export type EvolutionKind = typeof EVOLUTION_KINDS[number]
export type PersonalAiExperience = {
  id: string; revision: number; status: string; updatedAt: string
} & ({ access: 'available'; versionId: string; contentHash: string; spec: EvolutionSpec }
  | { access: 'revoked'; versionId: null; contentHash: null; spec: null })
export const EVOLUTION_PROPOSAL_STATUSES = ['draft', 'needs_input', 'ready', 'approved', 'rejected', 'superseded'] as const
export type EvolutionProposalStatus = typeof EVOLUTION_PROPOSAL_STATUSES[number]
export const EVOLUTION_RUN_STATUSES = ['queued', 'preparing', 'executing', 'evaluating', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const
export type EvolutionRunStatus = typeof EVOLUTION_RUN_STATUSES[number]
export const EVOLUTION_RELEASE_STATUSES = ['candidate', 'awaiting_approval', 'approved', 'activating', 'active', 'failed', 'rolled_back', 'retired'] as const
export type EvolutionReleaseStatus = typeof EVOLUTION_RELEASE_STATUSES[number]
export type EvolutionVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN' | 'SKIPPED'
export type EvolutionScope = { type: 'user' | 'project' | 'department' | 'organization'; key: string }
export type EvolutionSource = { type: 'message' | 'task' | 'feedback' | 'page'; id: string; conversationId?: string; excerpt?: string }
export type EvolutionBudget = { maxDurationSeconds: number; maxModelTokens: number; maxRepairRounds: number }
export type EvolutionSpec = {
  schemaVersion: 1
  kind: EvolutionKind
  title: string
  objective: string
  sourceRefs: EvolutionSource[]
  businessProjectId?: string
  scope: EvolutionScope
  acceptanceCriteria: string[]
  budget: EvolutionBudget
  questions: { id: string; question: string; options: string[]; answer?: string }[]
  target:
    | { type: 'experience'; rule: string; taskTypes: string[]; exceptions: string[]; expiresAt?: string; replacesVersionIds: string[] }
    | { type: 'skill'; capabilityId: string; baseContentHash: string; sampleIds: string[] }
    | { type: 'code'; repositoryId: string; baseCommit: string; allowedPaths: string[]; databaseChange: boolean; permissionChange: boolean }
}
export type EvolutionProposal = {
  id: string; ownerUserId: string; spec: EvolutionSpec; specHash: string
  status: EvolutionProposalStatus; revision: number; createdAt: string; updatedAt: string
}
export type EvolutionRun = {
  id: string; proposalId: string; inputHash: string; status: EvolutionRunStatus; stage: string
  attempt: number; budget: EvolutionBudget; usage: { modelTokens: number | null; elapsedSeconds: number; repairRounds: number }
  cancelRequestedAt: string | null; error: { code: string; message: string } | null
  createdAt: string; updatedAt: string
}
export type EvolutionEvent = { id: string; runId: string; sequence: number; eventType: string; payload: Record<string, unknown>; createdAt: string }
export type EvolutionCandidate = {
  id: string; runId: string; kind: EvolutionKind; baseRef: string; contentHash: string
  status: EvolutionReleaseStatus; summary: string; artifactIds: string[]; createdAt: string
}

const transitions: Record<EvolutionRunStatus, readonly EvolutionRunStatus[]> = {
  queued: ['preparing', 'cancelled', 'interrupted'],
  preparing: ['executing', 'failed', 'cancelled', 'interrupted'],
  executing: ['evaluating', 'failed', 'cancelled', 'interrupted'],
  evaluating: ['succeeded', 'failed', 'cancelled', 'interrupted'],
  succeeded: [], failed: [], cancelled: [], interrupted: [],
}

/** Repair loops stay within executing; retries create a new fenced attempt, never reopen a terminal run. */
export function canTransitionEvolutionRun(from: EvolutionRunStatus, to: EvolutionRunStatus): boolean {
  return transitions[from]?.includes(to) ?? false
}

export function evolutionProposalReadiness(spec: EvolutionSpec): 'needs_input' | 'ready' {
  return spec.questions.some((question) => !question.answer?.trim()) ? 'needs_input' : 'ready'
}
