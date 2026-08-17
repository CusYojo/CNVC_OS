import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  aiArtifactGapRecord,
  leadReserveGapRecord,
  type CurrentSourceGaps,
  type SourceGapDispositionDocument,
} from './sourceGapDispositionContract.js'

function table(name: string): string {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

export async function collectCurrentSourceGaps(): Promise<CurrentSourceGaps> {
  const [leadRows, artifactRows] = await Promise.all([
    pool.query<Array<RowDataPacket & {
      id: number; srcId: string | null; imported: number; importedLeadId: string | null; scoreStatus: string
    }>>(`
      SELECT id,src_id AS srcId,imported,imported_lead_id AS importedLeadId,score_status AS scoreStatus
      FROM ${table('lead_reserve')} WHERE detail_json IS NULL ORDER BY id
    `).then(([rows]) => rows),
    pool.query<Array<RowDataPacket & {
      id: string; taskId: string; taskType: string; userId: string; projectId: string
      fileName: string; format: string; storagePath: string; qualityStatus: string; archived: number
    }>>(`
      SELECT a.id,a.task_id AS taskId,t.type AS taskType,a.user_id AS userId,a.project_id AS projectId,
        a.file_name AS fileName,a.format,a.storage_path AS storagePath,
        a.quality_status AS qualityStatus,a.archived
      FROM ${table('ai_artifacts')} a JOIN ${table('ai_tasks')} t ON t.id=a.task_id
      WHERE a.storage_path REGEXP '^/Users/[^/]+/' ORDER BY a.id
    `).then(([rows]) => rows),
  ])
  return {
    leadReserve: leadRows.map(leadReserveGapRecord),
    aiArtifacts: artifactRows.map(aiArtifactGapRecord),
  }
}

export function parseSourceGapDisposition(value: unknown): SourceGapDispositionDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('source-gap disposition must be an object')
  return value as SourceGapDispositionDocument
}
