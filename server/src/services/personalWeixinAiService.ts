import type { PersonalWeixinAiView } from '../contracts/personalWeixinAiContract.js'
import { publicPersonalWeixinConfig } from '../contracts/personalWeixinAiContract.js'
import type { ImActor } from './imIntegrationService.js'

export type PersonalWeixinAiRecord = {
  botId: string
  version: number
  enabled: boolean
  config: Record<string, unknown>
  lastConnectedAt: Date | null
}

export type PersonalWeixinCredentials = {
  accountId: string
  accountUserId: string
  botToken: string
  baseUrl: string
}

export interface PersonalWeixinAiRepository {
  eligibility(userId: string): Promise<{ eligible: boolean; reason: string | null }>
  findForUser(userId: string): Promise<PersonalWeixinAiRecord | null>
  connect(input: PersonalWeixinCredentials & { actor: ImActor }): Promise<PersonalWeixinAiRecord>
  disconnect(input: { actor: ImActor; expectedVersion: number }): Promise<'not_found' | 'conflict' | { status: 'ok'; record: PersonalWeixinAiRecord }>
}

function serviceError(message: string, code: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}

async function defaultRepository(): Promise<PersonalWeixinAiRepository> {
  const module = await import('../repositories/mysql/mysqlPersonalWeixinAiRepository.js')
  return module.mysqlPersonalWeixinAiRepository
}

function view(
  eligibility: { eligible: boolean; reason: string | null },
  record: PersonalWeixinAiRecord | null,
): PersonalWeixinAiView {
  const safe = record ? publicPersonalWeixinConfig(record.config) : null
  return {
    connected: Boolean(record?.enabled),
    eligible: eligibility.eligible,
    botId: record?.botId ?? null,
    version: record?.version ?? null,
    lastConnectedAt: record?.lastConnectedAt?.toISOString() ?? (safe?.connectedAt || null),
    accountHint: safe?.accountHint ?? '',
    reason: eligibility.reason,
  }
}

async function requireEligible(actor: ImActor, repository: PersonalWeixinAiRepository) {
  const eligibility = await repository.eligibility(actor.userId)
  if (!eligibility.eligible) {
    throw serviceError(eligibility.reason || '当前账号不可连接微信 AI', 'PERSONAL_WEIXIN_FORBIDDEN', 403)
  }
  return eligibility
}

export async function getPersonalWeixinAi(
  actor: ImActor,
  repository?: PersonalWeixinAiRepository,
): Promise<PersonalWeixinAiView> {
  const target = repository ?? await defaultRepository()
  const eligibility = await target.eligibility(actor.userId)
  const record = await target.findForUser(actor.userId)
  return view(eligibility, record)
}

export async function connectPersonalWeixinAi(
  input: PersonalWeixinCredentials,
  actor: ImActor,
  repository?: PersonalWeixinAiRepository,
): Promise<PersonalWeixinAiView> {
  if (!input.accountUserId.trim()) {
    throw serviceError('微信登录未返回用户身份，请重新扫码', 'PERSONAL_WEIXIN_IDENTITY_MISSING', 502)
  }
  const target = repository ?? await defaultRepository()
  const eligibility = await requireEligible(actor, target)
  const record = await target.connect({ ...input, actor })
  return view(eligibility, record)
}

export async function disconnectPersonalWeixinAi(
  actor: ImActor,
  expectedVersion: number,
  repository?: PersonalWeixinAiRepository,
): Promise<PersonalWeixinAiView> {
  const target = repository ?? await defaultRepository()
  const eligibility = await requireEligible(actor, target)
  const result = await target.disconnect({ actor, expectedVersion })
  if (result === 'not_found') throw serviceError('尚未连接微信 AI', 'PERSONAL_WEIXIN_NOT_FOUND', 404)
  if (result === 'conflict') throw serviceError('连接状态已发生变化，请刷新后重试', 'PERSONAL_WEIXIN_VERSION_CONFLICT', 409)
  return view(eligibility, result.record)
}
