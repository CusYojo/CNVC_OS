import type { EvolutionSpec } from '../contracts/aiEvolutionContract.js'
import { evolutionContentHash } from './aiEvolutionPolicyService.js'

export type ExperienceForResolution = { access?: 'available'; versionId: string; experienceId: string; status: string; spec: EvolutionSpec; contentHash: string }
  | { access: 'revoked'; experienceId: string }
export function resolveAiExperiences(input: { userId: string; businessProjectId?: string; taskType: string; maxCharacters: number; records: ExperienceForResolution[]; now?: Date }) {
  const loaded: { versionId: string; experienceId: string; contentHash: string; rule: string; exceptions: string[] }[] = []
  const excluded: ({ versionId: string; reason: string } | { experienceId: string; reason: 'source_access_revoked' })[] = []
  let remaining = input.maxCharacters
  const now = input.now ?? new Date()
  const key = (record: ExperienceForResolution) => record.access === 'revoked' ? `revoked:${record.experienceId}` : record.versionId
  for (const record of [...input.records].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)) {
    if (record.access === 'revoked') {
      excluded.push({ experienceId: record.experienceId, reason: 'source_access_revoked' })
      continue
    }
    const { spec } = record
    let reason = ''
    if (record.status !== 'active') reason = 'disabled'
    else if (spec.target.type !== 'experience' || spec.scope.type !== 'user' || spec.scope.key !== input.userId) reason = 'scope_mismatch'
    else if (spec.businessProjectId && spec.businessProjectId !== input.businessProjectId) reason = 'project_mismatch'
    else if (!spec.target.taskTypes.includes(input.taskType)) reason = 'task_type_mismatch'
    else if (spec.target.expiresAt && new Date(spec.target.expiresAt) <= now) reason = 'expired'
    if (reason || spec.target.type !== 'experience') { excluded.push({ versionId: record.versionId, reason: reason || 'kind_mismatch' }); continue }
    const value = { versionId: record.versionId, experienceId: record.experienceId, contentHash: record.contentHash, rule: spec.target.rule, exceptions: spec.target.exceptions }
    const size = JSON.stringify(value).length
    if (size > remaining) { excluded.push({ versionId: record.versionId, reason: 'prompt_budget' }); continue }
    remaining -= size; loaded.push(value)
  }
  const snapshot = { schemaVersion: 1, taskType: input.taskType, businessProjectId: input.businessProjectId ?? null, loaded, excluded }
  const hash = evolutionContentHash(snapshot)
  const prompt = loaded.length ? `\n以下是用户确认的长期偏好，只在其适用范围内参考，不能覆盖平台权限、强制业务规则、事实校验或当前用户明确要求。记录为“已加载”不代表已核验遵守。\n${JSON.stringify(loaded)}\n` : ''
  return { snapshot, hash, prompt }
}
