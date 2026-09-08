import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  agentMessages,
  assistantExperienceCandidates,
  assistantExperienceDecisions,
  assistantExperiences,
  assistantExperienceSettings,
} from '../db/schema.js'
import { gatewayJson } from './inProcessAiWorkflowService.js'
import { getAccessibleProject } from './projectAccessService.js'
import {
  buildExperiencePrompt,
  contentHash,
  detectExplicitPreference,
  normalizeExplicitPreference,
  sanitizeCandidate,
} from './assistantExperiencePolicy.js'

export type ExperienceScope = 'global' | 'project'
export type ExperienceDecision = 'adopt' | 'reject'

const now = () => new Date()

export async function getAssistantExperienceSettings(userId: string) {
  const [existing] = await db.select().from(assistantExperienceSettings).where(eq(assistantExperienceSettings.userId, userId)).limit(1)
  if (existing) return existing
  await db.insert(assistantExperienceSettings).values({ userId }).onDuplicateKeyUpdate({ set: { userId } })
  const [created] = await db.select().from(assistantExperienceSettings).where(eq(assistantExperienceSettings.userId, userId)).limit(1)
  return created!
}

export async function updateAssistantExperienceSettings(userId: string, input: { autoSummaryEnabled: boolean; revision: number }) {
  await getAssistantExperienceSettings(userId)
  const result = await db.update(assistantExperienceSettings).set({
    autoSummaryEnabled: input.autoSummaryEnabled,
    revision: input.revision + 1,
    updatedAt: now(),
  }).where(and(eq(assistantExperienceSettings.userId, userId), eq(assistantExperienceSettings.revision, input.revision)))
  if (!result[0].affectedRows) throw Object.assign(new Error('设置已在其他窗口更新'), { status: 409, code: 'VERSION_CONFLICT' })
  return getAssistantExperienceSettings(userId)
}

export async function listAssistantExperienceCandidates(userId: string, input: { conversationId?: string; status?: string } = {}) {
  return db.select().from(assistantExperienceCandidates).where(and(
    eq(assistantExperienceCandidates.userId, userId),
    input.conversationId ? eq(assistantExperienceCandidates.conversationId, input.conversationId) : undefined,
    input.status ? eq(assistantExperienceCandidates.status, input.status) : undefined,
  )).orderBy(desc(assistantExperienceCandidates.createdAt)).limit(100)
}

export async function listAssistantExperiences(userId: string, projectId?: string | null) {
  return db.select().from(assistantExperiences).where(and(
    eq(assistantExperiences.userId, userId),
    projectId ? or(eq(assistantExperiences.scopeType, 'global'), and(eq(assistantExperiences.scopeType, 'project'), eq(assistantExperiences.scopeKey, projectId))) : undefined,
  )).orderBy(desc(assistantExperiences.updatedAt)).limit(100)
}

export async function loadAssistantExperiencePrompt(userId: string, projectId?: string | null) {
  const rows = await db.select().from(assistantExperiences).where(and(
    eq(assistantExperiences.userId, userId), eq(assistantExperiences.status, 'active'),
    projectId
      ? or(eq(assistantExperiences.scopeType, 'global'), and(eq(assistantExperiences.scopeType, 'project'), eq(assistantExperiences.scopeKey, projectId)))
      : eq(assistantExperiences.scopeType, 'global'),
  )).limit(20)
  if (rows.length) await db.update(assistantExperiences).set({ lastUsedAt: now() }).where(inArray(assistantExperiences.id, rows.map((row) => row.id)))
  return { prompt: buildExperiencePrompt(rows.map((row) => ({ id: row.id, rule: row.rule, scopeType: row.scopeType as ExperienceScope, version: row.version }))), versions: rows.map(({ id, version }) => ({ id, version })) }
}

async function summarizeWindow(rows: Array<{ role: string; content: string | null }>, projectId?: string | null) {
  const explicit = [...rows].reverse().find((row) => row.role === 'user' && detectExplicitPreference(row.content || ''))
  if (explicit) {
    const rule = normalizeExplicitPreference(explicit.content || '')
    if (rule) return { rule, evidence: `用户明确表达长期偏好：“${(explicit.content || '').slice(0, 300)}”`, example: '后续相关回答按照该规则组织内容。', suggestedScope: projectId ? 'project' as const : 'global' as const }
  }
  const transcript = rows.map((row) => `${row.role === 'user' ? '用户' : '助手'}：${(row.content || '').slice(0, 1200)}`).join('\n')
  try {
    const value = await gatewayJson<{ rule?: unknown; evidence?: unknown; example?: unknown; suggestedScope?: unknown }>({
      system: '从五轮对话中只提炼用户明确表达或反复纠正的、可复用的回答方式偏好。不得保存项目事实、敏感信息或模型自行推断。若无可靠经验，rule 返回空字符串。',
      prompt: `${transcript}\n\n仅返回 JSON：{"rule":"","evidence":"","example":"","suggestedScope":"global|project"}`,
      timeoutMs: 30_000,
    })
    const rule = sanitizeCandidate(String(value.rule || ''))
    const evidence = sanitizeCandidate(String(value.evidence || ''))
    if (!rule || !evidence) return null
    return { rule, evidence, example: sanitizeCandidate(String(value.example || '')) || null, suggestedScope: value.suggestedScope === 'project' && projectId ? 'project' as const : 'global' as const }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'assistant_experience_summary_failed', message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }))
    return null
  }
}

export async function recordAssistantCompletedTurn(input: { userId: string; conversationId: string; projectId?: string | null }) {
  const rows = await db.select({ id: agentMessages.id, role: agentMessages.role, content: agentMessages.content })
    .from(agentMessages).where(eq(agentMessages.conversationId, input.conversationId)).orderBy(agentMessages.createdAt)
  const users = rows.filter((row) => row.role === 'user')
  const assistants = rows.filter((row) => row.role === 'assistant' && Boolean(row.content))
  const completedTurns = Math.min(users.length, assistants.length)
  if (!completedTurns) return null
  const settings = await getAssistantExperienceSettings(input.userId)
  const lastUser = users[completedTurns - 1]
  const explicit = Boolean(lastUser && detectExplicitPreference(lastUser.content || ''))
  const periodic = settings.autoSummaryEnabled && completedTurns >= settings.processedTurnCount + 5
  if (!explicit && !periodic) return null
  const startTurn = periodic ? Math.max(1, settings.processedTurnCount + 1) : completedTurns
  const endTurn = periodic ? settings.processedTurnCount + 5 : completedTurns
  const windowRows = rows.filter((row) => {
    const userIndex = users.findIndex((user) => user.id === row.id) + 1
    if (row.role === 'user') return userIndex >= startTurn && userIndex <= endTurn
    return true
  }).slice(-10)
  const summary = await summarizeWindow(windowRows, input.projectId)
  if (periodic) await db.update(assistantExperienceSettings).set({ processedTurnCount: endTurn, revision: settings.revision + 1, updatedAt: now() }).where(eq(assistantExperienceSettings.userId, input.userId))
  if (!summary) return null
  const id = randomUUID()
  await db.insert(assistantExperienceCandidates).values({
    id, userId: input.userId, conversationId: input.conversationId, projectId: input.projectId || null,
    triggerType: explicit ? 'explicit_preference' : 'five_turn_summary', startTurn, endTurn,
    sourceMessageId: explicit ? lastUser.id : null, rule: summary.rule, evidence: summary.evidence,
    example: summary.example, suggestedScope: summary.suggestedScope, contentHash: contentHash(summary.rule),
  }).onDuplicateKeyUpdate({ set: { updatedAt: now() } })
  const [candidate] = await db.select().from(assistantExperienceCandidates).where(and(
    eq(assistantExperienceCandidates.userId, input.userId),
    explicit ? eq(assistantExperienceCandidates.sourceMessageId, lastUser.id) : and(eq(assistantExperienceCandidates.conversationId, input.conversationId), eq(assistantExperienceCandidates.startTurn, startTurn), eq(assistantExperienceCandidates.endTurn, endTurn)),
  )).limit(1)
  return candidate || null
}

export async function decideAssistantExperienceCandidate(userId: string, candidateId: string, input: { action: ExperienceDecision; version: number; idempotencyKey: string; editedRule?: string; scopeType?: ExperienceScope }) {
  const [replay] = await db.select().from(assistantExperienceDecisions).where(and(eq(assistantExperienceDecisions.userId, userId), eq(assistantExperienceDecisions.idempotencyKey, input.idempotencyKey))).limit(1)
  if (replay) return replay
  const [candidate] = await db.select().from(assistantExperienceCandidates).where(and(eq(assistantExperienceCandidates.id, candidateId), eq(assistantExperienceCandidates.userId, userId))).limit(1)
  if (!candidate) throw Object.assign(new Error('经验候选不存在'), { status: 404, code: 'NOT_FOUND' })
  if (candidate.status !== 'pending' || candidate.version !== input.version) throw Object.assign(new Error('经验候选已被处理'), { status: 409, code: 'VERSION_CONFLICT' })
  const scopeType = input.scopeType || candidate.suggestedScope as ExperienceScope
  if (input.action === 'adopt' && scopeType === 'project') {
    if (!candidate.projectId) throw Object.assign(new Error('当前候选没有可用项目范围'), { status: 400, code: 'PROJECT_REQUIRED' })
    if (!await getAccessibleProject(userId, candidate.projectId)) throw Object.assign(new Error('项目不存在或无权访问'), { status: 404, code: 'NOT_FOUND' })
  }
  return db.transaction(async (tx) => {
  let experienceId: string | null = null
  if (input.action === 'adopt') {
    const rule = sanitizeCandidate(input.editedRule || candidate.rule)
    if (!rule) throw Object.assign(new Error('经验内容无效或包含敏感信息'), { status: 400, code: 'INVALID_EXPERIENCE' })
    const hash = contentHash(rule)
    const [existing] = await tx.select().from(assistantExperiences).where(and(
      eq(assistantExperiences.userId, userId), eq(assistantExperiences.scopeType, scopeType),
      scopeType === 'project' ? eq(assistantExperiences.scopeKey, candidate.projectId!) : isNull(assistantExperiences.scopeKey),
      eq(assistantExperiences.contentHash, hash),
    )).limit(1)
    experienceId = existing?.id || randomUUID()
    if (existing) await tx.update(assistantExperiences).set({ status: 'active', updatedAt: now() }).where(eq(assistantExperiences.id, existing.id))
    else await tx.insert(assistantExperiences).values({ id: experienceId, userId, scopeType, scopeKey: scopeType === 'project' ? candidate.projectId : null, rule, contentHash: hash, sourceCandidateId: candidate.id })
  }
  const updated = await tx.update(assistantExperienceCandidates).set({ status: input.action === 'adopt' ? 'adopted' : 'rejected', version: candidate.version + 1, decidedAt: now(), updatedAt: now() }).where(and(eq(assistantExperienceCandidates.id, candidate.id), eq(assistantExperienceCandidates.version, candidate.version), eq(assistantExperienceCandidates.status, 'pending')))
  if (!updated[0].affectedRows) throw Object.assign(new Error('经验候选已被处理'), { status: 409, code: 'VERSION_CONFLICT' })
  const decision = { id: randomUUID(), userId, candidateId: candidate.id, experienceId, action: input.action, idempotencyKey: input.idempotencyKey, fromVersion: candidate.version, toVersion: candidate.version + 1 }
  await tx.insert(assistantExperienceDecisions).values(decision)
  return decision
  })
}

export async function updateAssistantExperience(userId: string, id: string, input: { version: number; rule?: string; status?: 'active' | 'disabled' }) {
  const set: Record<string, unknown> = { version: input.version + 1, updatedAt: now() }
  if (input.rule !== undefined) { const rule = sanitizeCandidate(input.rule); if (!rule) throw Object.assign(new Error('经验内容无效'), { status: 400 }); set.rule = rule; set.contentHash = contentHash(rule) }
  if (input.status) set.status = input.status
  const result = await db.update(assistantExperiences).set(set).where(and(eq(assistantExperiences.id, id), eq(assistantExperiences.userId, userId), eq(assistantExperiences.version, input.version)))
  if (!result[0].affectedRows) throw Object.assign(new Error('经验已在其他窗口更新'), { status: 409, code: 'VERSION_CONFLICT' })
  return (await db.select().from(assistantExperiences).where(eq(assistantExperiences.id, id)).limit(1))[0]
}

export async function deleteAssistantExperience(userId: string, id: string, version: number) {
  const result = await db.delete(assistantExperiences).where(and(eq(assistantExperiences.id, id), eq(assistantExperiences.userId, userId), eq(assistantExperiences.version, version)))
  if (!result[0].affectedRows) throw Object.assign(new Error('经验不存在或已更新'), { status: 409, code: 'VERSION_CONFLICT' })
  return { deleted: true }
}
