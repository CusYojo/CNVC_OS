import { aiConfigurationRepository, aiTaskRepository, agentConversationRepository, identityRepositories } from '../repositories/index.js'
import { MySqlAiEvolutionSkillApplicationRepository } from '../repositories/mysql/mysqlAiEvolutionSkillApplicationRepository.js'
import { MySqlAiEvolutionSkillBindingRepository } from '../repositories/mysql/mysqlAiEvolutionSkillBindingRepository.js'
import { createEvolutionSkillApplicationService } from './aiEvolutionSkillApplicationService.js'
import { aiEvolutionArtifactStore, aiEvolutionService, assertAiEvolutionEnabled } from './aiEvolutionApplicationService.js'
import { evolutionError } from './aiEvolutionPolicyService.js'
import { getAccessibleProject } from './projectAccessService.js'
import { captureEvolutionSkill } from '../runtime/evolution/evolutionSkillSnapshot.js'
import { saveEvolutionSkillPackage, reconstructEvolutionSkillRuntime } from '../runtime/evolution/evolutionSkillPackage.js'
import { getAiSkillDirectory, getAiSkillRoot } from './aiSkillService.js'
import { assertEvolutionSkillRuntimePermissions } from './aiEvolutionSkillRuntimePolicy.js'

type Context = Parameters<MySqlAiEvolutionSkillApplicationRepository['read']>[0]
const denied = () => evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '无权使用任务技能快照')

async function authorizeSavedSource(context: Context, source: Parameters<Parameters<MySqlAiEvolutionSkillApplicationRepository['read']>[1]>[0]) {
  await authorizeContext(context, [source.capabilityId])
  const run = await aiEvolutionService.authorizeRun(source.ownerUserId, source.runId)
  if (run.frozenSpec.target.type !== 'skill' || run.frozenSpec.target.capabilityId !== source.capabilityId) throw denied()
  const scope = run.frozenSpec.scope
  if (scope.type === 'user' ? scope.key !== context.ownerUserId || source.ownerUserId !== context.ownerUserId
    : scope.type !== 'project' || scope.key !== context.businessProjectId) throw denied()
}

/** Read-only retry preflight: never creates a missing parent snapshot. */
export async function readExistingTaskSkillSnapshot(userId: string, taskId: string, expected: {
  taskType: string; projectId: string; conversationId?: string; capabilityId: string
}) {
  if (process.env.AI_EVOLUTION_ENABLED !== 'true') return false
  const context: Context = { ownerUserId: userId, taskId, taskType: expected.taskType,
    businessProjectId: expected.projectId, conversationId: expected.conversationId ?? null }
  await authorizeContext(context, [expected.capabilityId])
  const saved = await new MySqlAiEvolutionSkillApplicationRepository().read(context,
    source => authorizeSavedSource(context, source), aiEvolutionArtifactStore)
  if (!saved) return false
  if (saved.packages.length !== 1 || saved.packages[0].bundle.version.capabilityId !== expected.capabilityId) throw denied()
  const version = saved.packages[0].bundle.version
  reconstructEvolutionSkillRuntime(saved.packages[0].bundle)
  const capability = await aiConfigurationRepository.findCapability(expected.capabilityId)
  if (!capability) throw denied()
  assertEvolutionSkillRuntimePermissions(version, capability)
  await authorizeContext(context, [expected.capabilityId])
  return saved.packages[0]
}

export async function validateExistingTaskSkillSnapshot(...args: Parameters<typeof readExistingTaskSkillSnapshot>) {
  return Boolean(await readExistingTaskSkillSnapshot(...args))
}

async function authorizeContext(context: Context, capabilityIds: string[]) {
  assertAiEvolutionEnabled()
  const user = await identityRepositories.users.findById(context.ownerUserId)
  if (!user || user.status !== '启用') throw denied()
  if (context.taskType === 'chat') {
    const chat = context.conversationId && await agentConversationRepository.findChatByIdForUser(context.ownerUserId, context.conversationId)
    if (!chat || (chat.projectId ?? null) !== context.businessProjectId) throw denied()
  } else {
    const task = await aiTaskRepository.findTaskById(context.taskId)
    if (!task || task.userId !== context.ownerUserId || task.type !== context.taskType
      || task.projectId !== context.businessProjectId || (task.conversationId ?? null) !== context.conversationId) throw denied()
  }
  if (context.businessProjectId && !await getAccessibleProject(context.ownerUserId, context.businessProjectId)) throw denied()
  for (const id of capabilityIds) {
    const capability = await aiConfigurationRepository.findCapability(id)
    if (!capability || capability.kind !== 'skill' || !capability.enabled
      || (capability.allowedRoles.length && !capability.allowedRoles.includes(user.role))) throw denied()
  }
}

const apply = createEvolutionSkillApplicationService({
  applications: new MySqlAiEvolutionSkillApplicationRepository(), bindings: new MySqlAiEvolutionSkillBindingRepository(),
  store: aiEvolutionArtifactStore, authorizeContext,
  captureBaseline: async (context, capabilityId) => {
    await authorizeContext(context, [capabilityId])
    const capability = await aiConfigurationRepository.findCapability(capabilityId)
    if (!capability || capability.source !== 'builtin') throw denied()
    const snapshot = await captureEvolutionSkill({ capabilityId, capabilityKey: capability.capabilityKey,
      directory: getAiSkillDirectory(capability.capabilityKey), allowedRoot: getAiSkillRoot(),
      toolNames: capability.toolNames, dependencyNames: capability.dependencyNames, config: capability.config })
    const saved = await saveEvolutionSkillPackage({ runId: context.taskId, snapshot, version: snapshot.version }, aiEvolutionArtifactStore)
    await authorizeContext(context, [capabilityId])
    return { capabilityId, status: 'baseline', ownerUserId: context.ownerUserId, sourceTaskId: context.taskId,
      contentHash: saved.contentHash, packageHash: saved.packageHash, artifact: { ...saved.artifact, kind: 'content' } }
  },
  authorizeSource: authorizeSavedSource,
  authorizeRetry: async (context, original) => {
    const task = await aiTaskRepository.findTaskById(context.taskId)
    if (!task || task.retryOfTaskId !== original.taskId) throw denied()
    await authorizeContext(original, [])
  },
})

/** capabilityIds must come from the host's resolved task capabilities, never directly from an HTTP body. */
export async function freezeTaskAiEvolutionSkills(userId: string, taskId: string, capabilityIds: string[]) {
  if (process.env.AI_EVOLUTION_ENABLED !== 'true') return null
  const task = await aiTaskRepository.findTaskById(taskId)
  if (!task || task.userId !== userId) throw denied()
  const context: Context = { ownerUserId: userId, taskId, taskType: task.type,
    conversationId: task.conversationId ?? null, businessProjectId: task.projectId }
  // A project binding is more specific; personal binding is used if none exists.
  const application = await apply(context, capabilityIds, [{ type: 'project', key: task.projectId }, { type: 'user', key: userId }], task.retryOfTaskId ?? undefined)
  await authorizeContext(context, capabilityIds)
  for (const selected of application.packages) {
    const current = await aiConfigurationRepository.findCapability(selected.bundle.version.capabilityId)
    if (!current) throw denied()
    assertEvolutionSkillRuntimePermissions(selected.bundle.version, current)
  }
  return application
}
