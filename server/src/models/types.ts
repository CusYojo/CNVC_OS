export interface MaterialProject {
  id: string
  name: string
  companyName: string
  industry: string
  stage: string
  financing: string
  valuation: string
  summary: string
  businessModel: string
  market: string
  team: string
  riskLevel: string
}

export interface MaterialRequest {
  project: MaterialProject
  type: 'pptx' | 'docx' | 'xlsx' | 'ic'
  outline: string[]
  template: string
  evidenceSources?: { title: string; url: string; category: string; reliability: string }[]
  highlights?: string[]
  risks?: string[]
  missing?: string[]
  files?: string[]
}
