import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const profilesTable = quoteMysqlIdentifier(mysqlTableName('lead_research_profile_projections'))
const [rows] = await pool.query<Array<RowDataPacket & {
  research_leads: number; projected: number; verified: number; partial: number; missing: number; conflicted: number;
  financing_leaks: number; oversized: number;
}>>(
  `SELECT COUNT(*) research_leads,COUNT(p.lead_id) projected,
          SUM(p.profile_status='verified') verified,SUM(p.profile_status='partial') partial,
          SUM(p.profile_status='missing') missing,SUM(p.profile_status='conflicted') conflicted,
          SUM(p.profile_payload IS NOT NULL AND (
            JSON_EXTRACT(p.profile_payload,'$.financing') IS NOT NULL OR
            JSON_EXTRACT(p.profile_payload,'$.valuation') IS NOT NULL OR
            JSON_EXTRACT(p.profile_payload,'$.customers') IS NOT NULL
          )) financing_leaks,
          SUM(OCTET_LENGTH(CAST(p.profile_payload AS CHAR)) > 4096) oversized
   FROM ${leadsTable} l LEFT JOIN ${profilesTable} p ON p.lead_id=l.id
   WHERE l.pool_status NOT IN ('解析失败','已合并','已删除','已注销','已转专属项目')
     AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.radar_profile,'$.channel')),'')='论文'`,
)
const result = { database: mysqlConfig.database, ...rows[0], coverage: Number(rows[0]?.research_leads || 0) ? Number(rows[0]?.projected || 0) / Number(rows[0]?.research_leads || 1) : 1 }
console.log(JSON.stringify(result, null, 2))
await pool.end()
if (Number(result.financing_leaks || 0) > 0 || Number(result.oversized || 0) > 0) process.exitCode = 1
