export const LEAD_RESEARCH_PROFILE_SCHEMA_VERSION = 'lead-research-profile-v1' as const
export const LEAD_RESEARCH_PROFILE_PROJECTION_VERSION = 'lead-research-profile-projection-v1' as const

export type LeadResearchProfileStatus = 'verified' | 'partial' | 'missing' | 'conflicted' | 'stale'

export type LeadResearchProfileSummary = {
  schemaVersion: typeof LEAD_RESEARCH_PROFILE_SCHEMA_VERSION
  projectionVersion: typeof LEAD_RESEARCH_PROFILE_PROJECTION_VERSION
  subject: {
    leadId: string
    type: 'research'
    name: string
    title?: string
    provider?: string
    providerIds: Record<string, string>
  }
  direction: {
    categories: string[]
    researchProblem?: string
    methods: string[]
  }
  team: {
    authors: Array<{ name: string; role?: string; openAlexAuthorId?: string; orcid?: string }>
    affiliations: string[]
  }
  progress: {
    venue?: string
    publishedAt?: string
    resourceType?: string
    codeUrl?: string
    datasetUrl?: string
    modelUrl?: string
    reproducibility?: string
  }
  valueAndTransfer: {
    applicationScenarios: string[]
    trl?: string
    prototype?: string
    validation?: string
    commercialization?: string
    transferStatus?: string
    spinOff?: string
    partners: string[]
  }
  rights: {
    articleLicense?: string
    datasetLicense?: string
    codeLicense?: string
    modelLicense?: string
    patents: string[]
    intellectualProperty?: string
  }
  latestDevelopments: Array<{ title: string; occurredAt?: string; sourceUrl?: string }>
  dataStatus: {
    status: LeadResearchProfileStatus
    verifiedDimensions: number
    applicableDimensions: number
    conflictCount: number
    source: 'paper_metadata' | 'snapshot' | 'paper_metadata+snapshot'
    updatedAt?: string
  }
  sourceFactIds: string[]
}
