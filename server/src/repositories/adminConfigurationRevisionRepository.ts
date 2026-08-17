import type { AuditRecord } from './identityRepository.js'
import type { ConfigurationRevisionDomain } from '../security/configurationRevisionCrypto.js'

export const CONFIGURATION_REVISION_RESOURCE_TYPES = [
  'provider', 'model', 'route', 'capability', 'capability_binding',
  'im_bot', 'im_binding', 'im_lead_push_rule',
] as const

export type ConfigurationRevisionResourceType = typeof CONFIGURATION_REVISION_RESOURCE_TYPES[number]

export type AdminConfigurationRevisionMetadata = {
  id: string
  domain: ConfigurationRevisionDomain
  resourceType: ConfigurationRevisionResourceType
  resourceId: string
  operation: string
  sourceVersion: number
  snapshotSha256: string
  snapshotAvailable: boolean
  createdBy: string | null
  createdAt: Date
}

export type AdminConfigurationRollbackResult =
  | { status: 'ok'; record: Record<string, unknown> }
  | { status: 'not_found' | 'resource_not_found' | 'conflict' | 'dependency_invalid' | 'impact_confirmation_required' }

export interface AdminConfigurationRevisionRepository {
  list(input: {
    domain: ConfigurationRevisionDomain
    resourceType: ConfigurationRevisionResourceType
    resourceId: string
    limit?: number
  }): Promise<AdminConfigurationRevisionMetadata[]>
  rollback(input: {
    domain: ConfigurationRevisionDomain
    resourceType: ConfigurationRevisionResourceType
    resourceId: string
    revisionId: string
    expectedVersion: number
    actorUserId: string
    confirmImpact?: boolean
    audit: AuditRecord
    updatedAt: Date
  }): Promise<AdminConfigurationRollbackResult>
}
