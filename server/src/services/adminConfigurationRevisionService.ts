import {
  adminConfigurationRevisionRepository,
  type ConfigurationRevisionResourceType,
} from '../repositories/index.js'
import type { ConfigurationRevisionDomain } from '../security/configurationRevisionCrypto.js'

type RevisionActor = { userId: string; userName: string; ip?: string }

function serviceError(message: string, code: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}

function safeRecord(record: Record<string, unknown>) {
  const {
    credentialCiphertext: _ciphertext,
    credentialFingerprint: _fingerprint,
    credentialHint,
    ...safe
  } = record
  if (_ciphertext === undefined && _fingerprint === undefined && credentialHint === undefined) return safe
  return {
    ...safe,
    hasCredential: Boolean(_ciphertext),
    credentialMasked: typeof credentialHint === 'string' ? credentialHint : null,
  }
}

export async function listConfigurationRevisions(input: {
  domain: ConfigurationRevisionDomain
  resourceType: ConfigurationRevisionResourceType
  resourceId: string
  limit?: number
}) {
  return { revisions: await adminConfigurationRevisionRepository.list(input) }
}

export async function rollbackConfigurationRevision(input: {
  domain: ConfigurationRevisionDomain
  resourceType: ConfigurationRevisionResourceType
  resourceId: string
  revisionId: string
  expectedVersion: number
  confirmImpact?: boolean
  module: string
  action: string
}, actor: RevisionActor) {
  const result = await adminConfigurationRevisionRepository.rollback({
    domain: input.domain,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    expectedVersion: input.expectedVersion,
    actorUserId: actor.userId,
    confirmImpact: input.confirmImpact,
    updatedAt: new Date(),
    audit: {
      userId: actor.userId,
      userName: actor.userName,
      module: input.module,
      action: input.action,
      target: `${input.resourceType}:${input.resourceId}:${input.revisionId}`,
      ip: actor.ip,
    },
  })
  if (result.status === 'not_found') throw serviceError('配置历史版本不存在', 'CONFIGURATION_REVISION_NOT_FOUND', 404)
  if (result.status === 'resource_not_found') throw serviceError('配置资源不存在或不支持该恢复方式', 'CONFIGURATION_RESOURCE_NOT_FOUND', 404)
  if (result.status === 'conflict') throw serviceError('配置已被其他管理员修改，请刷新后重试', 'CONFIGURATION_VERSION_CONFLICT', 409)
  if (result.status === 'dependency_invalid') throw serviceError('历史版本依赖的配置已不存在，无法恢复', 'CONFIGURATION_DEPENDENCY_INVALID', 409)
  if (result.status === 'impact_confirmation_required') {
    throw serviceError('回滚会影响启用绑定或待投递任务，需确认影响后重试', 'CONFIGURATION_ROLLBACK_CONFIRMATION_REQUIRED', 409)
  }
  if (result.status !== 'ok') throw serviceError('配置回滚失败', 'CONFIGURATION_ROLLBACK_FAILED', 409)
  return { ok: true, record: safeRecord(result.record) }
}
