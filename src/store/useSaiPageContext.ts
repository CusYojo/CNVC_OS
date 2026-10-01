import { create } from 'zustand'

type SaiPageContextState = {
  discoverySnapshot: string
  setDiscoverySnapshot: (snapshot: string) => void
  reviewSnapshot: string
  setReviewSnapshot: (snapshot: string) => void
  knowledgeSnapshot: string
  setKnowledgeSnapshot: (snapshot: string) => void
  institutionSnapshot: string
  institutionName: string
  setInstitutionContext: (snapshot: string, name: string) => void
  dueDiligenceSnapshot: string
  dueDiligenceProject: { id: string; name: string } | null
  setDueDiligenceContext: (snapshot: string, project: { id: string; name: string } | null) => void
}

export const useSaiPageContext = create<SaiPageContextState>((set) => ({
  discoverySnapshot: '',
  setDiscoverySnapshot: (discoverySnapshot) => set({ discoverySnapshot }),
  reviewSnapshot: '',
  setReviewSnapshot: (reviewSnapshot) => set({ reviewSnapshot }),
  knowledgeSnapshot: '',
  setKnowledgeSnapshot: (knowledgeSnapshot) => set({ knowledgeSnapshot }),
  institutionSnapshot: '',
  institutionName: '',
  setInstitutionContext: (institutionSnapshot, institutionName) => set({ institutionSnapshot, institutionName }),
  dueDiligenceSnapshot: '',
  dueDiligenceProject: null,
  setDueDiligenceContext: (dueDiligenceSnapshot, dueDiligenceProject) => set({ dueDiligenceSnapshot, dueDiligenceProject }),
}))
