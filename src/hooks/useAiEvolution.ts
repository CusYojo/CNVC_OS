import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { EvolutionProposal, EvolutionRun } from '../../server/src/contracts/aiEvolutionContract'

import type { PersonalAiExperience } from '../../server/src/contracts/aiEvolutionContract'
export type { PersonalAiExperience } from '../../server/src/contracts/aiEvolutionContract'

export function useAiEvolution(conversationId: string) {
  const [proposals, setProposals] = useState<EvolutionProposal[]>([])
  const [experiences, setExperiences] = useState<PersonalAiExperience[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activity, setActivity] = useState<Record<string, { runStatus?: string; candidateStatus?: string }>>({})
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++generation.current
    try {
      const [result, saved] = await Promise.all([
        api<{ list: EvolutionProposal[]; activity: Record<string, { runStatus?: string; candidateStatus?: string }> }>('/ai/evolution/proposals?limit=100'),
        api<{ list: PersonalAiExperience[] }>('/ai/evolution/experiences'),
      ])
      const visible = result.list.filter((item) => !conversationId || item.spec.sourceRefs.some((source) => source.conversationId === conversationId))
      if (version !== generation.current) return
      setProposals(visible); setActivity(result.activity)
      setExperiences(saved.list)
      setError('')
    } catch (error) {
      if (version !== generation.current) return
      setError(error instanceof Error ? error.message : '读取进化提案失败')
    } finally { if (version === generation.current) setLoading(false) }
  }, [conversationId])

  useEffect(() => {
    setLoading(true); setProposals([]); setExperiences([]); setActivity({}); setError('')
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 10_000)
    return () => { generation.current++; window.clearInterval(timer) }
  }, [refresh])

  const execute = async (proposal: EvolutionProposal) => {
    const run = await api<EvolutionRun>(`/ai/evolution/proposals/${proposal.id}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `execute:${proposal.id}:${proposal.revision}` },
      body: JSON.stringify({ expectedRevision: proposal.revision }),
    })
    await refresh()
    return run
  }
  const saveAnswers = async (proposal: EvolutionProposal, answers: Record<string, string>) => {
    await api(`/ai/evolution/proposals/${proposal.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: proposal.revision, spec: { ...proposal.spec,
        questions: proposal.spec.questions.map((question) => ({ ...question, answer: answers[question.id]?.trim() || question.answer })),
      } }),
    })
    await refresh()
  }
  const saveExperience = async (proposal: EvolutionProposal) => {
    const result = await api<{ experienceId: string; versionId: string; contentHash: string }>(`/ai/evolution/proposals/${proposal.id}/save-experience`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: proposal.revision }),
    })
    await refresh()
    return result
  }
  const disableExperience = async (experience: PersonalAiExperience) => {
    await api(`/ai/evolution/experiences/${experience.id}/disable`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: experience.revision }),
    })
    await refresh()
  }
  return { proposals, experiences, activity, loading, error, refresh, execute, saveExperience, disableExperience, saveAnswers }
}
