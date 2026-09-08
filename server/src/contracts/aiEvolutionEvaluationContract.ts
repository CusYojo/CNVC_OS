import type { EvolutionKind, EvolutionVerdict } from './aiEvolutionContract.js'

export const EVOLUTION_REQUIRED_CHECKS: Record<EvolutionKind, readonly string[]> = {
  code: ['types', 'permissions', 'contract', 'functional', 'build', 'page'],
  experience: ['source', 'scope', 'conflict', 'version'],
  skill: ['sources', 'required_fields', 'scope', 'render', 'regression'],
}
export type EvolutionEvaluationReport = {
  suiteVersion: string; candidateHash: string; verdict: EvolutionVerdict
  checks: { id: string; verdict: EvolutionVerdict; evidence: string }[]
}
export type EvolutionCandidateManifest = {
  schemaVersion: 1
  sourceHash: string
  patchHash: string
  dependencyLockHash: string
  environment: string
  artifacts: { storageKey: string; sha256: string; bytes: number; kind: 'patch' | 'web' | 'server' | 'screenshot' | 'report' | 'content' }[]
}

export type EvolutionSkillComparisonPreview = {
  sourceHash: string
  runtime: { modelId: string; modelVersion: string; promptHash: string; rendererVersion: string }
  metric: { name: string; direction: 'higher' | 'lower'; minimumImprovement: number }
  samples: { id: string; inputHash: string; sides: {
    side: 'baseline' | 'candidate'; skillHash: string; score: number
    checks: { id: string; verdict: string; evidence: string }[]
    downloads: { label: string; index: number; kind: string; bytes: number }[]
  }[] }[]
}

export function evaluationHasRequiredEvidence(kind: EvolutionKind, report: EvolutionEvaluationReport) {
  if (report.verdict !== 'PASS' || !report.suiteVersion || !report.checks.length) return false
  if (new Set(report.checks.map((check) => check.id)).size !== report.checks.length) return false
  return report.checks.every((check) => check.verdict === 'PASS' && check.evidence.trim())
    && EVOLUTION_REQUIRED_CHECKS[kind].every((id) => report.checks.some((check) => check.id === id))
}
