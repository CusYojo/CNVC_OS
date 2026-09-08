import type { parseAiEvolutionReleaseTargets } from './aiEvolutionReleaseRegistry.js'
import type { parseEvolutionPublisherLifecycleConfig } from './aiEvolutionPublisherLifecycleRegistry.js'

export const EVOLUTION_RELEASE_JOB_COLUMNS = ['id', 'candidate_id', 'approval_id', 'actor_user_id', 'environment', 'idempotency_key',
  'input_hash', 'status', 'receipt', 'attempt', 'lease_token', 'lease_owner', 'lease_expires_at', 'error', 'created_at', 'updated_at', 'completed_at'] as const
export const EVOLUTION_RELEASE_JOB_INDEXES = ['uq_evo_release_job_request', 'uq_evo_release_job_approval', 'idx_evo_release_job_lease'] as const

export function validateEvolutionPublisherPreflight(input: {
  release: ReturnType<typeof parseAiEvolutionReleaseTargets>;
  lifecycle: ReturnType<typeof parseEvolutionPublisherLifecycleConfig>;
  columns: string[]; indexes: string[]; table: string;
}) {
  if (!input.release.targets.length || new Set(input.release.targets.map(row => row.id)).size !== input.release.targets.length
    || new Set(input.lifecycle.targets.map(row => row.targetId)).size !== input.lifecycle.targets.length
    || input.release.targets.some(target => !input.lifecycle.targets.some(row => row.targetId === target.id))) {
    throw Error('Release and lifecycle target sets do not match')
  }
  for (const column of EVOLUTION_RELEASE_JOB_COLUMNS) if (!input.columns.includes(column)) throw Error(`${input.table} is missing migration 0107 column ${column}`)
  for (const index of EVOLUTION_RELEASE_JOB_INDEXES) if (!input.indexes.includes(index)) throw Error(`${input.table} is missing index ${index}`)
  return { targetIds: input.release.targets.map(row => row.id) }
}
