import { createHash, randomUUID } from 'node:crypto'
import { adminConfigurationRevisions } from '../../db/schema.js'
import {
  configurationRevisionContext,
  encryptConfigurationRevisionSnapshot,
  type ConfigurationRevisionDomain,
} from '../../security/configurationRevisionCrypto.js'

export type ConfigurationRevisionOperation = 'create' | 'update' | 'delete' | 'rollback'

export function configurationRevisionValues(input: {
  domain: ConfigurationRevisionDomain
  resourceType: string
  resourceId: string
  operation: ConfigurationRevisionOperation
  sourceVersion: number
  snapshot: Record<string, unknown> | null
  createdBy?: string | null
}): typeof adminConfigurationRevisions.$inferInsert {
  const context = configurationRevisionContext(input)
  const sealed = input.snapshot
    ? encryptConfigurationRevisionSnapshot(input.domain, context, input.snapshot)
    : { ciphertext: null, sha256: createHash('sha256').update('null').digest('hex') }
  return {
    id: randomUUID(),
    domain: input.domain,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    operation: input.operation,
    sourceVersion: input.sourceVersion,
    snapshotCiphertext: sealed.ciphertext,
    snapshotSha256: sealed.sha256,
    createdBy: input.createdBy ?? null,
  }
}
