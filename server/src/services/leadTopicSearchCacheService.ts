import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { canonicalEnrichmentJson, type LeadEnrichmentTopicKey } from './leadEnrichmentContract.js'

const cacheTable = quoteMysqlIdentifier(mysqlTableName('lead_topic_search_cache'))
const cacheHours = Math.max(1, Math.min(168, Number(process.env.LEAD_TOPIC_SEARCH_CACHE_HOURS) || 24))

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedSubject(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function leadTopicSearchCacheIdentity(input: {
  subjectName: string
  entityType: string
  topicKey: LeadEnrichmentTopicKey
  promptVersion: string
  queryPlan: readonly string[]
}) {
  const subjectFingerprint = sha256(`${input.entityType}:${normalizedSubject(input.subjectName)}`)
  const queryPlanHash = sha256(canonicalEnrichmentJson(input.queryPlan))
  const cacheKey = sha256(canonicalEnrichmentJson({
    subjectFingerprint, topicKey: input.topicKey, promptVersion: input.promptVersion, queryPlanHash,
  }))
  return { cacheKey, subjectFingerprint, queryPlanHash }
}

export async function readLeadTopicSearchCache<T>(input: {
  subjectName: string
  entityType: string
  topicKey: LeadEnrichmentTopicKey
  promptVersion: string
  queryPlan: readonly string[]
}): Promise<T | null> {
  const identity = leadTopicSearchCacheIdentity(input)
  const [rows] = await pool.query<Array<RowDataPacket & { result: unknown }>>(
    `SELECT result FROM ${cacheTable} WHERE cache_key=? AND expires_at>NOW(3) LIMIT 1`, [identity.cacheKey],
  )
  if (!rows[0]) return null
  if (typeof rows[0].result !== 'string') return rows[0].result as T
  try { return JSON.parse(rows[0].result) as T } catch { return null }
}

export async function writeLeadTopicSearchCache<T extends Record<string, unknown>>(input: {
  subjectName: string
  entityType: string
  topicKey: LeadEnrichmentTopicKey
  promptVersion: string
  queryPlan: readonly string[]
  model: string
  result: T
}) {
  const identity = leadTopicSearchCacheIdentity(input)
  await pool.query(
    `INSERT INTO ${cacheTable}
      (cache_key,subject_fingerprint,topic_key,prompt_version,query_plan_hash,model,result,expires_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,CAST(? AS JSON),DATE_ADD(NOW(3),INTERVAL ? HOUR),NOW(3),NOW(3))
     ON DUPLICATE KEY UPDATE model=VALUES(model),result=VALUES(result),expires_at=VALUES(expires_at),updated_at=NOW(3)`,
    [identity.cacheKey, identity.subjectFingerprint, input.topicKey, input.promptVersion, identity.queryPlanHash,
      input.model, canonicalEnrichmentJson(input.result), cacheHours],
  )
  return identity
}
