export type LeadInvestmentProfileEligibilitySummary = {
  facts: { raw: number; verified: number; evidenceBound: number; httpEligible: number }
  dimensions: Record<string, {
    rawLeadCount: number
    verifiedLeadCount: number
    evidenceBoundLeadCount: number
    httpEligibleLeadCount: number
  }>
}

export function leadInvestmentProfileBackfillQualityFailures(
  eligibility: LeadInvestmentProfileEligibilitySummary,
): string[] {
  const failures: string[] = []
  if (eligibility.facts.raw > 0 && eligibility.facts.httpEligible === 0) {
    failures.push('all investment-profile facts are ineligible for projection')
  }
  for (const [dimension, counts] of Object.entries(eligibility.dimensions)) {
    if (counts.rawLeadCount > 0 && counts.httpEligibleLeadCount === 0) {
      failures.push(`${dimension}: raw facts exist but no verified HTTP(S)-evidence-bound fact is eligible`)
    }
  }
  return failures
}

export function leadInvestmentProfileProjectionQualityFailures(profile: {
  dataStatus?: { verifiedDimensions?: number; status?: string }
} | null | undefined): string[] {
  if (!profile) return ['deterministic projection preview is unavailable']
  const verifiedDimensions = Number(profile.dataStatus?.verifiedDimensions ?? 0)
  const status = String(profile.dataStatus?.status ?? '')
  if (!Number.isInteger(verifiedDimensions) || verifiedDimensions < 1 || status === 'missing') {
    return ['deterministic projection preview has no verified investment-profile dimension']
  }
  return []
}
