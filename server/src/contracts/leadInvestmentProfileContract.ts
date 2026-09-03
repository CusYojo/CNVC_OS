export const LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION = 'lead-investment-profile-v1' as const
export const LEAD_INVESTMENT_PROFILE_PROJECTION_VERSION = 'lead-investment-profile-projection-v2' as const

export const LEAD_CUSTOMER_STAGES = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const
export type LeadCustomerStage = typeof LEAD_CUSTOMER_STAGES[number]
// Until the client explicitly approves L1, intent and research cooperation stay
// in the evidence layer and do not count as verified customer validation.
export const LEAD_MIN_VERIFIED_CUSTOMER_STAGE = 'L3' as const

export const LEAD_CUSTOMER_TIERS = ['A', 'B', 'C'] as const
export type LeadCustomerTier = typeof LEAD_CUSTOMER_TIERS[number]

export const LEAD_INSTITUTION_ROLES = ['lead', 'follow', 'strategic', 'undisclosed'] as const
export type LeadInstitutionRole = typeof LEAD_INSTITUTION_ROLES[number]

export const LEAD_VALUATION_TYPES = ['pre_money', 'post_money', 'planned', 'estimated', 'undisclosed'] as const
export type LeadValuationType = typeof LEAD_VALUATION_TYPES[number]

export const LEAD_INVESTMENT_PROFILE_STATUSES = [
  'verified', 'partial', 'conflicted', 'missing', 'not_applicable', 'stale',
] as const
export type LeadInvestmentProfileStatus = typeof LEAD_INVESTMENT_PROFILE_STATUSES[number]

export type LeadInvestmentProfileProduct = {
  instanceKey: string
  name: string
  productRoute?: string
  technologyRoute?: string
  productionStage?: string
  productionStageStatus?: 'planned' | 'realized' | 'undisclosed'
}

export type LeadInvestmentProfileInstitution = {
  institutionId: string
  name: string
  round?: string
  role: LeadInstitutionRole
  type?: string
  tier?: string
  major: boolean
}

export type LeadInvestmentProfileAcademicLink = {
  instanceKey: string
  institution: string
  relationType: string
  person?: string
  departmentLab?: string
  validFrom?: string
  validTo?: string
  current?: boolean
  commercialization: boolean
}

export type LeadInvestmentProfileCustomer = {
  customerId: string
  name: string
  displayName: string
  tier?: LeadCustomerTier
  stage: LeadCustomerStage
  anonymized: boolean
}

export type LeadInvestmentProfileMoneySummary = {
  raw?: string
  value?: string
  minValue?: string
  maxValue?: string
  unit?: 'yuan' | 'wan_yuan' | 'yi_yuan' | 'base'
  currency?: string
  undisclosed?: boolean
}

export type LeadInvestmentProfileDimensionState =
  | 'verified' | 'partial' | 'conflicted' | 'missing' | 'not_applicable'

export type LeadInvestmentProfileSummary = {
  profileSchemaVersion: typeof LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION
  enrichmentSchemaVersion: string
  projectionVersion: typeof LEAD_INVESTMENT_PROFILE_PROJECTION_VERSION
  dictionaryBinding: {
    industryHash?: string
    institutionHash?: string
    customerHash?: string
    academicHash?: string
  }
  subject: {
    leadId: string
    name: string
    legalEntityName?: string
    subjectType: string
    region?: string
    profileReviewStatus?: 'clear' | 'review'
  }
  // Backward-compatible alias retained for current detail components.
  schemaVersion: typeof LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION
  snapshotId?: string
  snapshotHash?: string
  industry: {
    level1?: string
    level2?: string
    segment?: string
    chainPosition?: string
  }
  products: LeadInvestmentProfileProduct[]
  productTotalCount: number
  institutions: LeadInvestmentProfileInstitution[]
  institutionTotalCount: number
  academicLinks: LeadInvestmentProfileAcademicLink[]
  academicLinkTotalCount: number
  financing: {
    status: string
    latestRound?: string
    latestRoundDate?: string
    latestAmount?: string
    latestAmountValue?: number
    latestAmountCurrency?: string
    cumulativeAmount?: string
    cumulativeAmountValue?: number
    completedRoundCount: number
    latestCompletedRound?: string
    latestCompletedAt?: string
    latestAmountSummary?: LeadInvestmentProfileMoneySummary
    cumulativeAmountByCurrency: Array<{ currency: string; value: string; completedRoundCount: number }>
  }
  valuation: {
    value?: string
    numericValue?: number
    type?: LeadValuationType
    currency?: string
    date?: string
    round?: string
    amount?: LeadInvestmentProfileMoneySummary
    asOfDate?: string
  }
  customers: {
    highestStage?: LeadCustomerStage
    verifiedCount: number
    tierACount: number
    tierBCount: number
    tierCCount: number
    mentionedCount: number
    engagedCount: number
    trialCount: number
    contractedCount: number
    deliveredCount: number
    payingCount: number
    verifiedCustomerCount: number
    customerTotalCount: number
    representatives: LeadInvestmentProfileCustomer[]
  }
  dataStatus: {
    verifiedDimensions: number
    applicableDimensions: number
    conflictCount: number
    status: LeadInvestmentProfileStatus
    updatedAt?: string
    dimensionStates: Record<string, LeadInvestmentProfileDimensionState>
    stale: boolean
    staleReason?: string
    factUpdatedAt?: string
    sourceFreshnessAt?: string
    snapshotCreatedAt?: string
    projectedAt: string
  }
  sourceFactIds: string[]
}

const CUSTOMER_STAGE_RANK = new Map(LEAD_CUSTOMER_STAGES.map((stage, index) => [stage, index]))

export function leadCustomerStageRank(stage: LeadCustomerStage | string | undefined): number {
  return CUSTOMER_STAGE_RANK.get(stage as LeadCustomerStage) ?? -1
}

export function maxLeadCustomerStage(
  left: LeadCustomerStage | undefined,
  right: LeadCustomerStage | undefined,
): LeadCustomerStage | undefined {
  return leadCustomerStageRank(right) > leadCustomerStageRank(left) ? right : left
}
