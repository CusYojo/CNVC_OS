import { agentConversationRepository, identityRepositories, aiTaskRepository, aiConfigurationRepository } from '../repositories/index.js'
import { MySqlAiEvolutionRepository } from '../repositories/mysql/mysqlAiEvolutionRepository.js'
import { MySqlAiEvolutionCandidateRepository } from '../repositories/mysql/mysqlAiEvolutionCandidateRepository.js'
import { getAccessibleProject } from './projectAccessService.js'
import { AiEvolutionService } from './aiEvolutionService.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'
import type { ClaimedEvolutionRun } from '../runtime/evolution/evolutionRunCoordinator.js'
import path from 'node:path'
import { AiEvolutionArtifactStore } from './aiEvolutionArtifactStore.js'
import { MySqlAiExperienceRepository } from '../repositories/mysql/mysqlAiExperienceRepository.js'
import { AiExperienceApplicationService } from './aiExperienceApplicationService.js'
import { previewEvolutionPatch } from './aiEvolutionPatchPreview.js'
import { evolutionDecisionSchema } from '../schemas/aiEvolutionSchema.js'
import { aiEvolutionRepositoryRegistry } from './aiEvolutionRepositoryRegistry.js'
import { aiEvolutionExecutorRegistry } from './aiEvolutionExecutorRegistry.js'
import { listManagedAiExperiences } from './aiExperienceManagement.js'
import { completeAiExperienceCheck } from './aiExperienceCompletion.js'
import { resolveAiModelById } from './aiModelSettingsService.js'
import { z } from 'zod'
import { AiEvolutionSkillRegistry, loadEvolutionSkillRegistryFile } from './aiEvolutionSkillRegistry.js'
import { createEvolutionSkillBaselineLoader } from './aiEvolutionSkillBaseline.js'
import { previewEvolutionSkillComparison } from './aiEvolutionSkillComparisonPreview.js'
import { readEvolutionSkillCheckpoint } from './aiEvolutionSkillCheckpoint.js'
import { MySqlAiEvolutionSkillVersionRepository } from '../repositories/mysql/mysqlAiEvolutionSkillVersionRepository.js'
import { listEvolutionSkillPackages } from './aiEvolutionSkillPackageList.js'

export const aiEvolutionSkillRegistry = new AiEvolutionSkillRegistry({ load: loadEvolutionSkillRegistryFile,
  actor: userId => identityRepositories.users.findById(userId),
  capability: capabilityId => aiConfigurationRepository.findCapability(capabilityId) })

const loadSkillBaseline = createEvolutionSkillBaselineLoader({ registry: aiEvolutionSkillRegistry,
  capability: id => aiConfigurationRepository.findCapability(id) })

export async function decideAiEvolutionCandidate(userId: string, candidateId: string, input: unknown) {
  assertAiEvolutionEnabled()
  const decision = evolutionDecisionSchema.parse(input)
  // Revalidate actor, proposal sources and scope before recording a human decision.
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  if (decision.decision === 'approved') await aiEvolutionArtifactStore.verifyManifest(candidate.runId, candidate.manifest)
  return new MySqlAiEvolutionCandidateRepository().decide(userId, candidateId, {
    ...decision, expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
}

export async function getAiEvolutionPatchForUser(userId: string, candidateId: string) {
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  const artifact = candidate.manifest.artifacts.find((item) => item.kind === 'patch' && item.sha256 === candidate.manifest.patchHash)
  if (!artifact) throw evolutionError(404, 'EVOLUTION_ARTIFACT_NOT_FOUND', '候选差异不存在')
  return previewEvolutionPatch(await aiEvolutionArtifactStore.read(candidate.runId, artifact), {
    patchHash: candidate.manifest.patchHash, sourceHash: candidate.manifest.sourceHash, baseRef: candidate.baseRef,
  })
}

export async function getAiEvolutionSkillComparisonForUser(userId: string, candidateId: string) {
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  if (candidate.kind !== 'skill') throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '技能对比报告不存在')
  return previewEvolutionSkillComparison(candidate, aiEvolutionArtifactStore)
}

export async function registerAiEvolutionSkillVersionForUser(userId: string, candidateId: string, input: unknown) {
  const { artifactIndex, candidateHash } = z.object({ artifactIndex: z.number().int().min(0),
    candidateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input)
  const authorize = async () => {
    const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
    if (candidate.kind !== 'skill') throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '技能候选不存在')
    if (candidate.contentHash !== candidateHash) throw evolutionError(409, 'EVOLUTION_INPUT_CHANGED', '候选内容已变化')
    return candidate
  }
  const candidate = await authorize()
  const artifact = candidate.manifest.artifacts[artifactIndex]
  if (!artifact || artifact.kind !== 'content') throw evolutionError(404, 'EVOLUTION_ARTIFACT_NOT_FOUND', '技能版本包不存在')
  return new MySqlAiEvolutionSkillVersionRepository().registerCandidatePackage(userId, candidateId, artifact,
    aiEvolutionArtifactStore, async () => { await authorize() })
}

export async function listAiEvolutionSkillPackagesForUser(userId: string, candidateId: string) {
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  if (candidate.kind !== 'skill') throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '技能候选不存在')
  const list = await listEvolutionSkillPackages(candidate, aiEvolutionArtifactStore)
  await getAiEvolutionCandidateForUser(userId, candidateId)
  return { candidateHash: candidate.contentHash, list }
}

async function readSkillRunForUser(userId: string, runId: string, expectedHash?: string) {
  assertAiEvolutionEnabled()
  const run = await aiEvolutionService.authorizeRun(userId, runId)
  if (run.frozenSpec.kind !== 'skill' || run.frozenSpec.target.type !== 'skill') {
    throw evolutionError(404, 'EVOLUTION_REPORT_NOT_FOUND', '技能评测报告不存在')
  }
  return readEvolutionSkillCheckpoint({ runId, baselineHash: run.frozenSpec.target.baseContentHash,
    checkpoint: run.checkpoint, expectedHash }, aiEvolutionArtifactStore)
}

export async function getAiEvolutionSkillRunComparisonForUser(userId: string, runId: string) {
  const { checkpointHash, comparison } = await readSkillRunForUser(userId, runId)
  return { checkpointHash, ...comparison }
}

export async function getAiEvolutionSkillRunArtifactForUser(userId: string, runId: string, index: number, checkpointHash: string) {
  const result = await readSkillRunForUser(userId, runId, checkpointHash)
  const artifact = Number.isInteger(index) && index >= 0 ? result.artifacts[index] : undefined
  if (!artifact) throw evolutionError(404, 'EVOLUTION_ARTIFACT_NOT_FOUND', '评测产物不存在')
  const named = result.comparison.samples.flatMap(sample => sample.sides.flatMap(side => side.downloads))
    .find(item => item.index === index && /^[a-zA-Z0-9_-]+\.(?:pdf|docx|png|json|txt)$/.test(item.label))
  return { filename: named?.label ?? `evolution-${artifact.kind}-${artifact.sha256.slice(0, 12)}.bin`,
    content: await aiEvolutionArtifactStore.read(runId, artifact) }
}

const experienceRepository = new MySqlAiExperienceRepository()
/** Called only with the final output by an authenticated task runtime; no public write endpoint. */
export async function checkCompletedPersonalAiExperience(userId: string, taskId: string, output: string, signal?: AbortSignal) {
  if (process.env.AI_EVOLUTION_ENABLED !== 'true' || !process.env.AI_EXPERIENCE_CHECK_MODEL_ID) return null
  const config = z.object({ modelId: z.string().uuid(), maxTokens: z.coerce.number().int().min(1).max(100_000) }).parse({
    modelId: process.env.AI_EXPERIENCE_CHECK_MODEL_ID, maxTokens: process.env.AI_EXPERIENCE_CHECK_MAX_TOKENS ?? '64000' })
  await assertExperienceActor(userId)
  const user = await identityRepositories.users.findById(userId)
  const route = await resolveAiModelById(config.modelId, user!.role)
  if (!route) throw evolutionError(403, 'EVOLUTION_MODEL_UNAVAILABLE', '经验检查模型不可用')
  return completeAiExperienceCheck({ repository: experienceRepository, userId, taskId, output, route, maxTokens: config.maxTokens, signal,
    assertAuthorized: async () => {
      const { list } = await getPersonalAiExperienceApplication(userId, taskId)
      if (!list.length) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '经验应用记录不可访问')
      const actor = await identityRepositories.users.findById(userId)
      const current = actor && await resolveAiModelById(config.modelId, actor.role)
      if (!current || current.model !== route.model || current.providerId !== route.providerId || current.baseUrl !== route.baseUrl || current.apiKey !== route.apiKey) {
        throw evolutionError(403, 'EVOLUTION_MODEL_UNAVAILABLE', '经验检查模型权限或配置已变化')
      }
    } })
}
const experienceApplications = new AiExperienceApplicationService(experienceRepository, async (userId) => {
  const { list } = await listPersonalAiExperiences(userId)
  return list.map((row) => row.access === 'revoked' ? { access: 'revoked' as const, experienceId: row.id }
    : { experienceId: row.id, versionId: row.versionId, status: row.status, spec: row.spec, contentHash: row.contentHash })
})

export async function freezeChatAiExperiences(userId: string, conversationId: string, messageId: string) {
  if (process.env.AI_EVOLUTION_ENABLED !== 'true') return null
  await assertExperienceActor(userId)
  const chat = await agentConversationRepository.findChatByIdForUser(userId, conversationId)
  if (!chat || (chat.projectId && !await getAccessibleProject(userId, chat.projectId))) {
    throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '无权访问经验应用会话')
  }
  return experienceApplications.freeze({ userId, conversationId, taskId: messageId, taskType: 'chat', businessProjectId: chat.projectId ?? undefined })
}

export async function freezeTaskAiExperiences(userId: string, taskId: string) {
  if (process.env.AI_EVOLUTION_ENABLED !== 'true') return null
  await assertExperienceActor(userId)
  const task = await aiTaskRepository.findTaskById(taskId)
  if (!task || task.userId !== userId || !await getAccessibleProject(userId, task.projectId)) {
    throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '无权访问经验应用任务')
  }
  if (task.retryOfTaskId) {
    const parent = await aiTaskRepository.findTaskById(task.retryOfTaskId)
    if (!parent || parent.userId !== userId || parent.projectId !== task.projectId || parent.type !== task.type
      || parent.conversationId !== task.conversationId) {
      throw evolutionError(409, 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT', '重试任务与原任务范围不一致')
    }
  }
  return experienceApplications.freeze({ userId, taskId: task.id, taskType: task.type,
    conversationId: task.conversationId ?? undefined, businessProjectId: task.projectId }, 8000, task.retryOfTaskId ?? undefined)
}

async function assertExperienceActor(userId: string) {
  assertAiEvolutionEnabled()
  const user = await identityRepositories.users.findById(userId)
  if (user?.status !== '启用') throw evolutionError(403, 'EVOLUTION_USER_DISABLED', '当前账号不可用')
}

export async function savePersonalAiExperience(userId: string, proposalId: string, expectedRevision: number) {
  await assertExperienceActor(userId)
  const proposal = await aiEvolutionService.get(userId, proposalId)
  return experienceRepository.savePersonal(userId, proposalId, expectedRevision, proposal.specHash)
}

export async function listPersonalAiExperiences(userId: string) {
  await assertExperienceActor(userId)
  const rows = await experienceRepository.listPersonal(userId)
  const list = await listManagedAiExperiences(userId, rows, async (proposalId, savedSpec) => {
    await aiEvolutionService.get(userId, proposalId)
    await aiEvolutionService.authorizeSpec(userId, savedSpec)
  })
  return { list }
}

export async function disablePersonalAiExperience(userId: string, id: string, expectedRevision: number) {
  // Owners retain the ability to stop using a rule after its source access is revoked.
  await assertExperienceActor(userId)
  return experienceRepository.disablePersonal(userId, id, expectedRevision)
}

export async function getPersonalAiExperienceApplication(userId: string, taskId: string) {
  await assertExperienceActor(userId)
  const row = await experienceRepository.findApplication(userId, taskId)
  if (!row) return { list: [] }
  if (row.businessProjectId && !await getAccessibleProject(userId, row.businessProjectId)) {
    throw evolutionError(403, 'EVOLUTION_PROJECT_FORBIDDEN', '无权访问关联项目')
  }
  if (row.taskType === 'chat') {
    const chat = row.conversationId ? await agentConversationRepository.findChatByIdForUser(userId, row.conversationId) : null
    if (!chat || (chat.projectId ?? null) !== row.businessProjectId) {
      throw evolutionError(403, 'EVOLUTION_SOURCE_FORBIDDEN', '无权访问原始会话')
    }
  } else {
    const task = await aiTaskRepository.findTaskById(taskId)
    if (!task || task.userId !== userId || task.type !== row.taskType || task.projectId !== row.businessProjectId) {
      throw evolutionError(403, 'EVOLUTION_SOURCE_FORBIDDEN', '无权访问原始任务')
    }
  }
  const application = await experienceApplications.read({ userId, taskId, taskType: row.taskType,
    conversationId: row.conversationId ?? undefined, businessProjectId: row.businessProjectId ?? undefined }, async (versionId, contentHash) => {
    const version = await experienceRepository.findOwnedVersion(userId, versionId)
    if (!version || version.contentHash !== contentHash) throw evolutionError(403, 'EVOLUTION_SOURCE_FORBIDDEN', '历史经验版本不可访问')
    await aiEvolutionService.authorizeSpec(userId, version.spec)
  })
  return { list: application ? [application] : [] }
}

export const aiEvolutionArtifactStore = new AiEvolutionArtifactStore(path.resolve(process.env.AI_EVOLUTION_ARTIFACT_ROOT || 'server/ai-artifacts/evolution'))

export async function getAiEvolutionArtifactForUser(userId: string, candidateId: string, index: number) {
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  if (!Number.isInteger(index) || index < 0 || index >= candidate.manifest.artifacts.length) throw evolutionError(404, 'EVOLUTION_ARTIFACT_NOT_FOUND', '候选产物不存在')
  const artifact = candidate.manifest.artifacts[index]
  let filename = `evolution-${artifact.kind}-${artifact.sha256.slice(0, 12)}.bin`
  if (candidate.kind === 'skill' && artifact.kind !== 'patch') {
    const comparison = await previewEvolutionSkillComparison(candidate, aiEvolutionArtifactStore)
    const named = comparison.samples.flatMap(sample => sample.sides.flatMap(side => side.downloads))
      .find(item => item.index === index && /^[a-zA-Z0-9_-]+\.(?:pdf|docx|png|json|txt)$/.test(item.label))
    if (named) filename = named.label
  }
  return { artifact, filename, content: await aiEvolutionArtifactStore.read(candidate.runId, artifact) }
}

export function assertAiEvolutionEnabled() {
  if (process.env.AI_EVOLUTION_ENABLED !== 'true') {
    throw evolutionError(503, 'EVOLUTION_DISABLED', '自进化尚未启用，请先完成数据库与执行环境配置')
  }
}

export async function getAiEvolutionCandidateForUser(userId: string, candidateId: string) {
  assertAiEvolutionEnabled()
  const result = await new MySqlAiEvolutionCandidateRepository().findForOwner(userId, candidateId)
  if (!result) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '候选不存在或无权访问')
  const run = await aiEvolutionService.authorizeRun(userId, result.candidate.runId)
  return { ...result.candidate, scope: run.frozenSpec.scope, proposalId: result.proposalId, createdAt: result.candidate.createdAt.toISOString(),
    evaluation: { hash: result.evaluation.evaluationHash, report: result.evaluation.report } }
}

export async function authorizeAiEvolutionCodeRun(claimed: ClaimedEvolutionRun) {
  assertAiEvolutionEnabled()
  const run = await aiEvolutionService.authorizeRun(claimed.ownerUserId, claimed.id, true)
  if (run.inputHash !== claimed.inputHash || evolutionContentHash(run.frozenSpec) !== evolutionContentHash(claimed.frozenSpec)) {
    throw evolutionError(409, 'EVOLUTION_INPUT_CHANGED', '执行任务与持久化输入不一致')
  }
  if (run.frozenSpec.target.type !== 'code') throw evolutionError(409, 'EVOLUTION_EXECUTOR_KIND', '执行器仅处理代码进化')
  return aiEvolutionRepositoryRegistry.resolve(run.ownerUserId, run.frozenSpec.target.repositoryId)
}

export async function authorizeAiEvolutionSkillRun(claimed: ClaimedEvolutionRun) {
  assertAiEvolutionEnabled()
  const run = await aiEvolutionService.authorizeRun(claimed.ownerUserId, claimed.id, true)
  if (run.inputHash !== claimed.inputHash || evolutionContentHash(run.frozenSpec) !== evolutionContentHash(claimed.frozenSpec)) {
    throw evolutionError(409, 'EVOLUTION_INPUT_CHANGED', '执行任务与持久化输入不一致')
  }
  if (run.frozenSpec.kind !== 'skill' || run.frozenSpec.target.type !== 'skill') throw evolutionError(409, 'EVOLUTION_EXECUTOR_KIND', '执行器仅处理技能进化')
  return loadSkillBaseline(run.ownerUserId, run.frozenSpec.target.capabilityId)
}

export async function getLatestAiEvolutionCandidate(userId: string, proposalId: string) {
  assertAiEvolutionEnabled()
  await aiEvolutionService.get(userId, proposalId)
  const id = await new MySqlAiEvolutionCandidateRepository().latestIdForProposal(userId, proposalId)
  return { candidate: id ? await getAiEvolutionCandidateForUser(userId, id) : null }
}

export async function getAiEvolutionProposalRuns(userId: string, proposalId: string) {
  assertAiEvolutionEnabled()
  await aiEvolutionService.get(userId, proposalId)
  const rows = await new MySqlAiEvolutionRepository().listProposalRuns(userId, proposalId)
  return { list: await Promise.all(rows.map((row) => aiEvolutionService.run(userId, row.id))) }
}

export const aiEvolutionService = new AiEvolutionService(new MySqlAiEvolutionRepository(), {
  canAccessProject: async (userId, projectId) => Boolean(await getAccessibleProject(userId, projectId)),
  canAccessSource: async (userId, source) => {
    if (source.type === 'message' && source.conversationId) {
      const chat = await agentConversationRepository.findChatByIdForUser(userId, source.conversationId)
      if (!chat || (chat.projectId && !await getAccessibleProject(userId, chat.projectId))) return false
      const message = await agentConversationRepository.findMessageByExternalId(source.conversationId, source.id)
      if (message) return true
      return chat.messages.some((item) => Boolean(item && typeof item === 'object' && 'id' in item && item.id === source.id))
    }
    if (source.type === 'task') {
      const task = await aiTaskRepository.findTaskById(source.id)
      return Boolean(task && task.userId === userId && (!task.projectId || await getAccessibleProject(userId, task.projectId)))
    }
    // Page/feedback require registered source records; arbitrary front-end descriptions cannot authorize them.
    return false
  },
  canManageScope: async (userId, scope, target) => {
    if (scope.type !== 'project' || target.type !== 'skill' || !await getAccessibleProject(userId, scope.key)) return false
    try { await aiEvolutionSkillRegistry.resolvePublication(userId, target.capabilityId, { type: 'project', key: scope.key }); return true }
    catch (error) {
      if (['EVOLUTION_CAPABILITY_FORBIDDEN', 'EVOLUTION_RELEASE_FORBIDDEN'].includes((error as { code?: string }).code ?? '')) return false
      throw error
    }
  },
  canDevelopRepository: (userId, repositoryId) => aiEvolutionRepositoryRegistry.canDevelop(userId, repositoryId),
  canManageCapability: (userId, capabilityId) => aiEvolutionSkillRegistry.canManage(userId, capabilityId),
  codeEnvironmentAvailable: () => aiEvolutionExecutorRegistry.available(),
  budgetLimit: { maxDurationSeconds: 1800, maxModelTokens: 100_000, maxRepairRounds: 3 },
}, async (userId) => {
  const user = await identityRepositories.users.findById(userId)
  return { userId, enabled: user?.status === '启用' }
})
