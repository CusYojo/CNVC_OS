import { redactSensitiveText } from '../security/redactSecrets.js'

export type LeadEnrichmentSnapshotPostCommitStep =
  | 'enrichment_projection'
  | 'investment_profile_projection'
  | 'research_profile_projection'
  | 'rating_queue'
  | 'failure_receipt'

export type LeadEnrichmentSnapshotPostCommitFailure = {
  step: LeadEnrichmentSnapshotPostCommitStep
  message: string
}

type LeadEnrichmentSnapshotPostCommitTasks = {
  refreshEnrichmentProjection: () => Promise<unknown>
  refreshInvestmentProfileProjection: () => Promise<unknown>
  refreshResearchProfileProjection?: () => Promise<unknown>
  enqueueRating: () => Promise<boolean>
  recordFailures: (failures: LeadEnrichmentSnapshotPostCommitFailure[]) => Promise<void>
  reportFailure?: (failure: LeadEnrichmentSnapshotPostCommitFailure) => void
}

function failureReceipt(step: LeadEnrichmentSnapshotPostCommitStep, error: unknown) {
  return {
    step,
    message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1_000),
  }
}

/**
 * The snapshot is already durable when this reconciliation starts. Isolating
 * each downstream read model prevents a projection failure from turning a
 * completed topic into a misleading retry. A failed investment profile stays
 * stale and is picked up by the guarded rebuild path.
 */
export async function runLeadEnrichmentSnapshotPostCommit(input: {
  enqueueRating: boolean
  projectionTarget?: 'investment' | 'research'
}, tasks: LeadEnrichmentSnapshotPostCommitTasks) {
  const failures: LeadEnrichmentSnapshotPostCommitFailure[] = []
  const report = (failure: LeadEnrichmentSnapshotPostCommitFailure) => {
    try { tasks.reportFailure?.(failure) } catch { /* reporting must not reopen a frozen snapshot */ }
  }
  const attempt = async <T>(
    step: Exclude<LeadEnrichmentSnapshotPostCommitStep, 'failure_receipt'>,
    task: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await task()
    } catch (error) {
      const failure = failureReceipt(step, error)
      failures.push(failure)
      report(failure)
      return undefined
    }
  }

  await attempt('enrichment_projection', tasks.refreshEnrichmentProjection)
  const researchTarget = input.projectionTarget === 'research'
  const investmentProfile = researchTarget ? undefined : await attempt(
    'investment_profile_projection', tasks.refreshInvestmentProfileProjection,
  )
  const researchProfile = researchTarget && tasks.refreshResearchProfileProjection
    ? await attempt('research_profile_projection', tasks.refreshResearchProfileProjection)
    : undefined
  const ratingQueued = input.enqueueRating
    ? await attempt('rating_queue', tasks.enqueueRating)
    : false

  if (failures.length) {
    try {
      await tasks.recordFailures(failures)
    } catch (error) {
      const failure = failureReceipt('failure_receipt', error)
      failures.push(failure)
      report(failure)
    }
  }

  return {
    enrichmentProjectionRefreshed: !failures.some((item) => item.step === 'enrichment_projection'),
    investmentProfileRefreshed: investmentProfile !== undefined,
    researchProfileRefreshed: researchProfile !== undefined,
    autoScoreEnqueued: ratingQueued === true,
    failures,
  }
}
