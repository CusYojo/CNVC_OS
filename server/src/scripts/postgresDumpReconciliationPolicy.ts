export type DumpDifference = {
  sourceMissingInTarget: number
  targetOnlyRows: number
  changedSourceRows: number
  changedColumns: string[]
}

export const APPROVED_DUMP_TARGET_EVOLUTION: Record<string, {
  changedColumns: readonly string[]
  allowTargetOnly: boolean
  reason: string
}> = {
  users: {
    changedColumns: ['password_hash', 'last_login'],
    allowTargetOnly: false,
    reason: 'target authentication state is authoritative after cutover',
  },
  project_files: {
    changedColumns: ['storage_path', 'byte_size', 'sha256', 'version'],
    allowTargetOnly: false,
    reason: 'validated original-file repair and integrity metadata',
  },
  leads: {
    changedColumns: [
      'scoring', 'radar_profile', 'radar_source_keys', 'business_region',
      'business_region_source', 'business_region_confidence',
    ],
    allowTargetOnly: false,
    reason: 'post-cutover scoring and Radar enrichment',
  },
  projects: {
    changedColumns: ['scoring'],
    allowTargetOnly: false,
    reason: 'legacy scoring classification and post-cutover audited Agent scoring',
  },
  audit_logs: {
    changedColumns: [],
    allowTargetOnly: true,
    reason: 'append-only target audit events',
  },
  knowledge_chunks: {
    changedColumns: [],
    allowTargetOnly: true,
    reason: 'post-cutover file ingestion appends chunks',
  },
  ai_tasks: {
    changedColumns: ['conversation_id'],
    allowTargetOnly: false,
    reason: 'source-orphan conversation normalization with durable issue ledger',
  },
  ai_artifacts: {
    changedColumns: ['conversation_id', 'archived', 'quality_status', 'metadata'],
    allowTargetOnly: false,
    reason: 'source-orphan conversation normalization and missing-file quarantine with durable issue ledgers',
  },
  chat_conversations: {
    changedColumns: ['scope', 'project_id'],
    allowTargetOnly: false,
    reason: 'legacy conversation scope normalization with a durable migration ledger',
  },
}

export function evaluateDumpTargetEvolution(
  table: string,
  difference: DumpDifference,
  options: {
    sourceOrphanNormalizationReady: boolean
    legacyConversationScopeNormalizationReady?: boolean
    missingFileAssetQuarantineReady?: boolean
    legacyScoringReady?: boolean
  },
): { approved: boolean; reason: string } {
  const policy = APPROVED_DUMP_TARGET_EVOLUTION[table]
  const normalizationEvidenceReady = !difference.changedColumns.includes('conversation_id')
    || options.sourceOrphanNormalizationReady
  const missingFileColumns = new Set(['archived', 'quality_status', 'metadata'])
  const missingFileEvidenceReady = table !== 'ai_artifacts'
    || !difference.changedColumns.some((column) => missingFileColumns.has(column))
    || options.missingFileAssetQuarantineReady === true
  const scoringEvidenceReady = !['leads', 'projects'].includes(table)
    || !difference.changedColumns.includes('scoring')
    || options.legacyScoringReady === true
  const conversationScopeColumns = new Set(['scope', 'project_id'])
  const conversationScopeEvidenceReady = table !== 'chat_conversations'
    || !difference.changedColumns.some((column) => conversationScopeColumns.has(column))
    || options.legacyConversationScopeNormalizationReady === true
  const approved = difference.sourceMissingInTarget === 0
    && Number.isFinite(difference.targetOnlyRows)
    && Number.isFinite(difference.changedSourceRows)
    && (difference.targetOnlyRows === 0 || policy?.allowTargetOnly === true)
    && (difference.changedSourceRows === 0 || Boolean(policy)
      && difference.changedColumns.every((column) => policy.changedColumns.includes(column)))
    && normalizationEvidenceReady
    && missingFileEvidenceReady
    && scoringEvidenceReady
    && conversationScopeEvidenceReady
  return {
    approved,
    reason: policy?.reason ?? 'exact source/target baseline required',
  }
}
