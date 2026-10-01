import { create } from 'zustand'

type SaiPageContextState = {
  discoverySnapshot: string
  setDiscoverySnapshot: (snapshot: string) => void
}

export const useSaiPageContext = create<SaiPageContextState>((set) => ({
  discoverySnapshot: '',
  setDiscoverySnapshot: (discoverySnapshot) => set({ discoverySnapshot }),
}))
