import type { EvolutionCandidateManifest } from '../contracts/aiEvolutionEvaluationContract.js'
import type { AiEvolutionArtifactStore } from './aiEvolutionArtifactStore.js'
import { reconstructEvolutionSkillRuntime } from '../runtime/evolution/evolutionSkillPackage.js'
import { evolutionError } from './aiEvolutionPolicyService.js'

export async function listEvolutionSkillPackages(candidate: { runId: string; baseRef: string;
  manifest: EvolutionCandidateManifest }, store: Pick<AiEvolutionArtifactStore, 'read'>) {
  const list: { side: 'baseline' | 'candidate'; artifactIndex: number; contentHash: string; packageHash: string }[] = []
  let total = 0
  for (const [artifactIndex, artifact] of candidate.manifest.artifacts.entries()) {
    if (artifact.kind !== 'content') continue
    total += artifact.bytes
    if (total > 64 * 1024 * 1024) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '候选版本包读取总量超限')
    const bytes = await store.read(candidate.runId, artifact)
    let raw: unknown
    try { raw = JSON.parse(bytes.toString('utf8')) } catch { continue }
    if (!raw || typeof raw !== 'object' || !('runtimeSnapshot' in raw)) continue
    const runtime = reconstructEvolutionSkillRuntime(raw)
    const side = runtime.contentHash === candidate.baseRef ? 'baseline'
      : runtime.contentHash === candidate.manifest.sourceHash ? 'candidate' : null
    if (!side) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '技能包与候选版本不一致')
    if (list.some(item => item.side === side)) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '候选包含重复版本包')
    list.push({ side, artifactIndex, contentHash: runtime.contentHash, packageHash: runtime.packageHash })
  }
  return list
}
