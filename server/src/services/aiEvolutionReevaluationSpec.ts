import { evolutionSpecSchema } from '../schemas/aiEvolutionSchema.js'
import { evolutionError } from './aiEvolutionPolicyService.js'

/** New execution retains the original requirements and gates, never prior acceptance or approval. */
export function createEvolutionReevaluationSpec(original: unknown, baseCommit: string) {
  const spec = evolutionSpecSchema.parse(original)
  if (spec.kind !== 'code' || spec.target.type !== 'code') throw evolutionError(409, 'EVOLUTION_RELEASE_KIND', '重新基线评估仅适用于代码进化')
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw evolutionError(400, 'EVOLUTION_BASE_INVALID', '重新评估需要固定 Git 提交')
  if (spec.target.baseCommit === baseCommit) throw evolutionError(409, 'EVOLUTION_BASE_UNCHANGED', '基线未变化，请使用原候选流程')
  return evolutionSpecSchema.parse({ ...spec, target: { ...spec.target, baseCommit } })
}
