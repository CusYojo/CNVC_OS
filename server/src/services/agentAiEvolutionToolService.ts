import { agentConversationRepository } from '../repositories/index.js'
import { aiEvolutionService, assertAiEvolutionEnabled, getAiEvolutionCandidateForUser } from './aiEvolutionApplicationService.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'
import { evolutionSpecSchema } from '../schemas/aiEvolutionSchema.js'

export async function proposeAgentEvolution(userId: string, conversationId: string, input: unknown) {
  assertAiEvolutionEnabled()
  const chat = await agentConversationRepository.findChatByIdForUser(userId, conversationId)
  if (!chat) throw evolutionError(403, 'EVOLUTION_CONVERSATION_FORBIDDEN', '无权访问当前会话')
  const spec = evolutionSpecSchema.parse(input)
  const projectScope = spec.scope.type === 'project' && spec.target.type === 'skill'
    && Boolean(chat.projectId) && spec.scope.key === chat.projectId
  if (spec.scope.type !== 'user' && !projectScope) throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '共享技能提案必须绑定当前项目会话并取得明确授权')
  if (!spec.sourceRefs.length || spec.sourceRefs.some((source) => source.type !== 'message' || source.conversationId !== conversationId)) {
    throw evolutionError(403, 'EVOLUTION_SOURCE_FORBIDDEN', '助手提案必须引用当前会话的真实消息')
  }
  let hasUserSource = false
  for (const source of spec.sourceRefs) {
    const message = await agentConversationRepository.findMessageByExternalId(conversationId, source.id)
    const legacy = chat.messages.find(item => item && typeof item === 'object' && 'id' in item && item.id === source.id)
    const role = message?.role ?? (legacy && typeof legacy === 'object' && 'role' in legacy ? legacy.role : undefined)
    if (role === 'user') hasUserSource = true
  }
  if (!hasUserSource) throw evolutionError(403, 'EVOLUTION_SOURCE_FORBIDDEN', '进化提案必须包含用户消息，不能仅将助手回复视为用户要求')
  // Scope and business project come from the owned conversation, never from model authority claims.
  const boundSpec = { ...spec, scope: projectScope ? { type: 'project' as const, key: chat.projectId! }
    : { type: 'user' as const, key: userId }, businessProjectId: chat.projectId ?? undefined }
  const key = evolutionContentHash({ conversationId, spec: boundSpec })
  return aiEvolutionService.create(userId, { spec: boundSpec }, `agent:${key}`)
}

export async function getAgentEvolutionStatus(userId: string, conversationId: string, proposalId: string) {
  assertAiEvolutionEnabled()
  if (!await agentConversationRepository.findChatByIdForUser(userId, conversationId)) {
    throw evolutionError(403, 'EVOLUTION_CONVERSATION_FORBIDDEN', '无权访问当前会话')
  }
  const proposal = await aiEvolutionService.get(userId, proposalId)
  if (!proposal.spec.sourceRefs.some((source) => source.conversationId === conversationId)) {
    throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '当前会话不存在此提案')
  }
  return proposal
}

export async function cancelAgentEvolution(userId: string, conversationId: string, runId: string) {
  assertAiEvolutionEnabled()
  const run = await aiEvolutionService.run(userId, runId)
  await getAgentEvolutionStatus(userId, conversationId, run.proposalId)
  return aiEvolutionService.cancel(userId, runId)
}

export async function getAgentEvolutionResult(userId: string, conversationId: string, candidateId: string) {
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  await getAgentEvolutionStatus(userId, conversationId, candidate.proposalId)
  return candidate
}
