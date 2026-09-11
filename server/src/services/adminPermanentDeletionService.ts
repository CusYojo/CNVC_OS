import { createHash, randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  ADMIN_PERMANENT_DELETION_RISK_TEXT,
  permanentDeletionExecuteSchema,
  permanentDeletionPreviewSchema,
  permanentDeletionSearchSchema,
  type PermanentDeletionImpact,
  type PermanentDeletionResourceType,
} from '../contracts/adminPermanentDeletionContract.js'
import { removeProjectFileDirectory } from './projectFileStorageService.js'

type AdminActor = { userId: string; userName: string }
type ResourceRow = RowDataPacket & { id: string; name: string; status: string; created_at: Date | string; source: string | null; version_key: string }
type ForeignKeyRow = RowDataPacket & {
  TABLE_NAME: string
  COLUMN_NAME: string
  REFERENCED_TABLE_NAME: string
  REFERENCED_COLUMN_NAME: string
  DELETE_RULE: string
}

const auditTable = quoteMysqlIdentifier(mysqlTableName('admin_permanent_deletions'))
const usersTable = quoteMysqlIdentifier(mysqlTableName('users'))
const databaseName = mysqlConfig.database

function failure(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export function permanentDeletionImpactHash(impact: PermanentDeletionImpact) {
  return sha256(canonicalJson(impact))
}

export function assertPermanentDeletionConfirmation(input: { currentName: string; resourceName: string; riskText: string }) {
  if (input.resourceName !== input.currentName) throw failure(409, 'PERMANENT_DELETE_NAME_MISMATCH', '对象名称已变化，请重新预览后确认')
  if (input.riskText !== ADMIN_PERMANENT_DELETION_RISK_TEXT) throw failure(400, 'PERMANENT_DELETE_RISK_TEXT_MISMATCH', '风险确认文本不完全一致')
}

function resourceTable(type: PermanentDeletionResourceType) {
  return quoteMysqlIdentifier(mysqlTableName(type === 'lead' ? 'leads' : type === 'project' ? 'projects' : 'company_knowledge'))
}

function resourceSelect(type: PermanentDeletionResourceType, suffix: string) {
  const table = resourceTable(type)
  if (type === 'lead') return `SELECT id,name,pool_status AS status,created_at,source,CONCAT(created_at,'|',pool_status,'|',COALESCE(converted_project_id,'')) AS version_key,converted_project_id FROM ${table} ${suffix}`
  if (type === 'project') return `SELECT id,name,lifecycle AS status,created_at,NULL AS source,CAST(version AS CHAR) AS version_key FROM ${table} ${suffix}`
  return `SELECT id,title AS name,status,created_at,link AS source,CAST(version AS CHAR) AS version_key,file_id FROM ${table} ${suffix}`
}

async function assertEnabledSystemAdmin(connection: PoolConnection, actor: AdminActor) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT id FROM ${usersTable} WHERE id=? AND status='启用' AND role='系统管理员' LIMIT 1`,
    [actor.userId],
  )
  if (!rows.length) throw failure(403, 'ROLE_FORBIDDEN', '仅启用的系统管理员可以彻底删除数据')
}

async function loadResource(connection: PoolConnection, type: PermanentDeletionResourceType, id: string, lock = false) {
  const [rows] = await connection.query<ResourceRow[]>(resourceSelect(type, `WHERE id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`), [id])
  return rows[0] || null
}

async function foreignKeys(connection: PoolConnection, parentTable: string) {
  const [rows] = await connection.query<ForeignKeyRow[]>(
    `SELECT k.TABLE_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,rc.DELETE_RULE
       FROM information_schema.REFERENTIAL_CONSTRAINTS rc
       JOIN information_schema.KEY_COLUMN_USAGE k USING(CONSTRAINT_SCHEMA,CONSTRAINT_NAME,TABLE_NAME)
      WHERE rc.CONSTRAINT_SCHEMA=? AND k.REFERENCED_TABLE_NAME=?`,
    [databaseName, parentTable],
  )
  return rows
}

async function directImpact(connection: PoolConnection, type: PermanentDeletionResourceType, id: string): Promise<PermanentDeletionImpact> {
  const baseTable = mysqlTableName(type === 'lead' ? 'leads' : type === 'project' ? 'projects' : 'company_knowledge')
  const relations = await foreignKeys(connection, baseTable)
  let relatedRecords = 0
  for (const relation of relations) {
    const table = quoteMysqlIdentifier(relation.TABLE_NAME)
    const column = quoteMysqlIdentifier(relation.COLUMN_NAME)
    const [rows] = await connection.query<Array<RowDataPacket & { total: number }>>(`SELECT COUNT(*) AS total FROM ${table} WHERE ${column}=?`, [id])
    relatedRecords += Number(rows[0]?.total || 0)
  }
  let files = 0
  let sharedFiles = 0
  if (type === 'project') {
    const [rows] = await connection.query<Array<RowDataPacket & { total: number }>>(
      `SELECT COUNT(*) AS total FROM ${quoteMysqlIdentifier(mysqlTableName('project_files'))} WHERE project_id=?`, [id],
    )
    files = Number(rows[0]?.total || 0)
  } else if (type === 'knowledge') {
    const row = await loadResource(connection, type, id) as (ResourceRow & { file_id?: string | null }) | null
    if (row?.file_id) sharedFiles = 1
  }
  return { relatedRecords, files, sharedFiles }
}

export async function searchPermanentDeletionTargets(actor: AdminActor, raw: unknown) {
  const input = permanentDeletionSearchSchema.parse(raw)
  const connection = await pool.getConnection()
  try {
    await assertEnabledSystemAdmin(connection, actor)
    const pattern = `%${input.query.replace(/[\\%_]/g, '\\$&')}%`
    const suffix = `WHERE name LIKE ? ESCAPE '\\\\' OR id=? ORDER BY created_at DESC LIMIT 20`
    const knowledgeSuffix = `WHERE title LIKE ? ESCAPE '\\\\' OR id=? ORDER BY created_at DESC LIMIT 20`
    const [rows] = await connection.query<ResourceRow[]>(resourceSelect(input.resourceType, input.resourceType === 'knowledge' ? knowledgeSuffix : suffix), [pattern, input.query])
    return rows.map(row => ({ id: row.id, name: row.name, status: row.status, createdAt: new Date(row.created_at).toISOString(), source: row.source }))
  } finally { connection.release() }
}

export async function previewPermanentDeletion(actor: AdminActor, raw: unknown) {
  const input = permanentDeletionPreviewSchema.parse(raw)
  const connection = await pool.getConnection()
  try {
    await assertEnabledSystemAdmin(connection, actor)
    const resource = await loadResource(connection, input.resourceType, input.resourceId)
    if (!resource) throw failure(404, 'NOT_FOUND', '待删除对象不存在')
    const impact = await directImpact(connection, input.resourceType, input.resourceId)
    const blockers = input.resourceType === 'lead' && Boolean((resource as ResourceRow & { converted_project_id?: string }).converted_project_id)
      ? ['LEAD_CONVERTED_PROJECT_EXISTS'] : []
    const previewToken = randomUUID()
    const expiresAt = new Date(Date.now() + 10 * 60_000)
    await connection.query(
      `INSERT INTO ${auditTable} (id,token_hash,resource_type,resource_id,resource_name,resource_version,impact_hash,impact_counts,actor_id,actor_name,status,file_cleanup_payload,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'preview',JSON_OBJECT('paths',JSON_ARRAY()),?)`,
      [randomUUID(), sha256(previewToken), input.resourceType, input.resourceId, resource.name, resource.version_key, permanentDeletionImpactHash(impact), JSON.stringify(impact), actor.userId, actor.userName, expiresAt],
    )
    return { previewToken, expiresAt: expiresAt.toISOString(), ...input, resourceName: resource.name, impact, blockers }
  } finally { connection.release() }
}

async function primaryKey(connection: PoolConnection, tableName: string) {
  const [rows] = await connection.query<Array<RowDataPacket & { COLUMN_NAME: string }>>(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION`,
    [databaseName, tableName],
  )
  return rows.length === 1 ? rows[0].COLUMN_NAME : null
}

async function deleteRowsByReference(connection: PoolConnection, tableName: string, columnName: string, value: string, path: Set<string>) {
  const table = quoteMysqlIdentifier(tableName)
  const column = quoteMysqlIdentifier(columnName)
  const pk = await primaryKey(connection, tableName)
  if (!pk) {
    await connection.query(`DELETE FROM ${table} WHERE ${column}=?`, [value])
    return
  }
  const [rows] = await connection.query<RowDataPacket[]>(`SELECT ${quoteMysqlIdentifier(pk)} AS id FROM ${table} WHERE ${column}=?`, [value])
  for (const row of rows) await deleteRecordGraph(connection, tableName, pk, String(row.id), path)
}

async function deleteRecordGraph(connection: PoolConnection, tableName: string, pkColumn: string, value: string, path = new Set<string>()) {
  const key = `${tableName}:${pkColumn}:${value}`
  if (path.has(key)) throw failure(409, 'PERMANENT_DELETE_RELATION_CYCLE', '检测到无法安全清理的循环数据关系')
  path.add(key)
  for (const relation of await foreignKeys(connection, tableName)) {
    if (relation.DELETE_RULE === 'SET NULL') {
      await connection.query(`UPDATE ${quoteMysqlIdentifier(relation.TABLE_NAME)} SET ${quoteMysqlIdentifier(relation.COLUMN_NAME)}=NULL WHERE ${quoteMysqlIdentifier(relation.COLUMN_NAME)}=?`, [value])
    } else {
      await deleteRowsByReference(connection, relation.TABLE_NAME, relation.COLUMN_NAME, value, path)
    }
  }
  await connection.query(`DELETE FROM ${quoteMysqlIdentifier(tableName)} WHERE ${quoteMysqlIdentifier(pkColumn)}=?`, [value])
  path.delete(key)
}

export async function executePermanentDeletion(actor: AdminActor, raw: unknown) {
  const input = permanentDeletionExecuteSchema.parse(raw)
  const connection = await pool.getConnection()
  let removeProjectDirectory = false
  try {
    await connection.beginTransaction()
    await assertEnabledSystemAdmin(connection, actor)
    const tokenHash = sha256(input.previewToken)
    const [auditRows] = await connection.query<Array<RowDataPacket & {
      id: string; actor_id: string; resource_type: string; resource_id: string; resource_name: string; resource_version: string;
      impact_hash: string; status: string; expires_at: Date | string
    }>>(`SELECT * FROM ${auditTable} WHERE token_hash=? LIMIT 1 FOR UPDATE`, [tokenHash])
    const audit = auditRows[0]
    if (!audit || audit.actor_id !== actor.userId || audit.resource_type !== input.resourceType || audit.resource_id !== input.resourceId) {
      throw failure(409, 'PERMANENT_DELETE_TOKEN_MISMATCH', '删除确认已失效，请重新预览')
    }
    if (audit.status === 'deleted') {
      await connection.commit()
      return { deletionId: audit.id, deleted: input.resourceId, alreadyDeleted: true, fileCleanupStatus: 'done' }
    }
    if (new Date(audit.expires_at).getTime() <= Date.now()) throw failure(409, 'PERMANENT_DELETE_TOKEN_EXPIRED', '删除确认已过期，请重新预览')
    const resource = await loadResource(connection, input.resourceType, input.resourceId, true)
    if (!resource) throw failure(404, 'NOT_FOUND', '待删除对象不存在')
    assertPermanentDeletionConfirmation({ currentName: resource.name, resourceName: input.resourceName, riskText: input.riskText })
    if (resource.version_key !== audit.resource_version) throw failure(409, 'PERMANENT_DELETE_RESOURCE_CHANGED', '对象已发生变化，请重新预览')
    if (input.resourceType === 'lead' && (resource as ResourceRow & { converted_project_id?: string }).converted_project_id) {
      throw failure(409, 'LEAD_CONVERTED_PROJECT_EXISTS', '该线索已转换为正式项目，请先处理对应正式项目')
    }
    const impact = await directImpact(connection, input.resourceType, input.resourceId)
    if (permanentDeletionImpactHash(impact) !== audit.impact_hash) throw failure(409, 'PERMANENT_DELETE_IMPACT_CHANGED', '关联数据已变化，请重新预览')
    if (input.resourceType === 'knowledge') {
      await connection.query(`DELETE FROM ${quoteMysqlIdentifier(mysqlTableName('company_knowledge_commands'))} WHERE entry_id=?`, [input.resourceId])
      await connection.query(`UPDATE ${quoteMysqlIdentifier(mysqlTableName('weixin_link_intakes'))} SET knowledge_entry_id=NULL,article_body=NULL WHERE knowledge_entry_id=?`, [input.resourceId])
    }
    await deleteRecordGraph(connection, mysqlTableName(input.resourceType === 'lead' ? 'leads' : input.resourceType === 'project' ? 'projects' : 'company_knowledge'), 'id', input.resourceId)
    removeProjectDirectory = input.resourceType === 'project'
    const now = new Date()
    await connection.query(
      `UPDATE ${auditTable} SET status='deleted',risk_confirmation_version='v1',database_deleted_at=?,file_cleanup_status=?,updated_at=? WHERE id=?`,
      [now, removeProjectDirectory ? 'pending' : 'none', now, audit.id],
    )
    await connection.commit()
    if (removeProjectDirectory) {
      try {
        await removeProjectFileDirectory(input.resourceId)
        await pool.query(`UPDATE ${auditTable} SET file_cleanup_status='done',file_cleanup_attempts=file_cleanup_attempts+1,updated_at=? WHERE id=?`, [new Date(), audit.id])
      } catch (error) {
        const code = String((error as { code?: unknown }).code || 'FILE_CLEANUP_FAILED').slice(0, 128)
        await pool.query(`UPDATE ${auditTable} SET file_cleanup_status='failed',file_cleanup_attempts=file_cleanup_attempts+1,file_cleanup_error=?,updated_at=? WHERE id=?`, [code, new Date(), audit.id])
      }
    }
    return { deletionId: audit.id, deleted: input.resourceId, alreadyDeleted: false, fileCleanupStatus: removeProjectDirectory ? 'done' : 'none' }
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw error
  } finally { connection.release() }
}
