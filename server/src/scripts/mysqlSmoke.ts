import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  aiSummaries,
  aiTasks,
  agentConversations,
  agentMessages,
  auditLogs,
  chatConversations,
  knowledgeChunks,
  leadScoreJobs,
  leads,
  meetings,
  projectScoreJobs,
  projects,
  radarSyncState,
  runtimeJobRuns,
  runtimeJobs,
  risks,
  todos,
  users,
} from '../db/schema.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlConfig, quoteMysqlIdentifier } from '../db/config.js'
import { hashPassword } from '../services/authService.js'
import { clearLeadScoreJob, createLead, leadPoolStats, listLeads, saveLeadScoreJob } from '../services/aiSummaryService.js'
import { createConversation, appendMessages, deleteConversation, renameConversation } from '../services/conversationService.js'
import { createMeeting, createTodo, deleteTodo, todoCounts, updateMeeting, updateTodo } from '../services/meetingService.js'
import { createProject, listProjects, pinProject, updateProject } from '../services/projectService.js'
import { saveRadarSyncState } from '../services/radarSyncService.js'
import { createRisk, riskCounts, updateRisk } from '../services/riskService.js'

type ForeignKeyColumn = {
  constraintName: string
  tableName: string
  columnName: string
  referencedTableName: string
  referencedColumnName: string
  ordinalPosition: number
}

const APPROVED_MYSQL = {
  version: '8.0.36',
  engine: 'InnoDB',
  charset: 'utf8mb4',
  collation: 'utf8mb4_0900_ai_ci',
  isolation: 'READ-COMMITTED',
  globalTimeZone: '+08:00',
  sessionTimeZone: '+08:00',
  sqlModes: [
    'ERROR_FOR_DIVISION_BY_ZERO',
    'IGNORE_SPACE',
    'NO_ENGINE_SUBSTITUTION',
    'NO_ZERO_DATE',
    'NO_ZERO_IN_DATE',
    'ONLY_FULL_GROUP_BY',
    'STRICT_TRANS_TABLES',
  ].sort(),
} as const

async function assertApprovedMySqlEnvironment(): Promise<{ version: string; tables: number }> {
  const [variableRows] = await pool.query<Array<import('mysql2').RowDataPacket & {
    version: string
    engine: string
    charset: string
    collation: string
    sqlMode: string
    isolationLevel: string
    timeZone: string
    globalTimeZone: string
  }>>(`SELECT
      @@version AS version,
      @@default_storage_engine AS engine,
      @@character_set_database AS charset,
      @@collation_database AS collation,
      @@sql_mode AS sqlMode,
      @@transaction_isolation AS isolationLevel,
      @@session.time_zone AS timeZone,
      @@global.time_zone AS globalTimeZone`)
  const variables = variableRows[0]
  if (!variables) throw new Error('MySQL environment query returned no row')
  const actualModes = variables.sqlMode.split(',').filter(Boolean).sort()
  const expected = APPROVED_MYSQL
  const mismatch = variables.version !== expected.version
    || variables.engine !== expected.engine
    || variables.charset !== expected.charset
    || variables.collation !== expected.collation
    || variables.isolationLevel !== expected.isolation
    || variables.timeZone !== expected.sessionTimeZone
    || variables.globalTimeZone !== expected.globalTimeZone
    || JSON.stringify(actualModes) !== JSON.stringify(expected.sqlModes)
  if (mismatch) {
    throw new Error(`MySQL server contract mismatch: ${JSON.stringify({
      expected,
      actual: { ...variables, sqlMode: actualModes },
    })}`)
  }

  const [tableRows] = await pool.query<Array<import('mysql2').RowDataPacket & {
    tableName: string
    engine: string
    collation: string
  }>>(`SELECT TABLE_NAME AS tableName, ENGINE AS engine, TABLE_COLLATION AS collation
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=? AND LEFT(TABLE_NAME,?)=?`, [
    mysqlConfig.database,
    mysqlConfig.tablePrefix.length,
    mysqlConfig.tablePrefix,
  ])
  if (!tableRows.length) throw new Error('MySQL application table inventory is empty')
  const invalid = tableRows.filter((row) => row.engine !== expected.engine || row.collation !== expected.collation)
  if (invalid.length) throw new Error(`MySQL table storage contract mismatch: ${JSON.stringify(invalid)}`)
  const aipin = tableRows.filter((row) => /aipin/i.test(row.tableName))
  if (aipin.length) throw new Error(`Aipin tables exist in target schema: ${aipin.map((row) => row.tableName).join(',')}`)
  return { version: variables.version, tables: tableRows.length }
}

async function assertNoForeignKeyOrphans(): Promise<number> {
  const [rows] = await pool.query<import('mysql2').RowDataPacket[]>(`
    SELECT CONSTRAINT_NAME AS constraintName, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
           REFERENCED_TABLE_NAME AS referencedTableName, REFERENCED_COLUMN_NAME AS referencedColumnName,
           ORDINAL_POSITION AS ordinalPosition
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_NAME LIKE ?
    ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION
  `, [mysqlConfig.database, `${mysqlConfig.tablePrefix}%`])
  const groups = new Map<string, ForeignKeyColumn[]>()
  for (const raw of rows) {
    const column: ForeignKeyColumn = {
      constraintName: String(raw.constraintName), tableName: String(raw.tableName), columnName: String(raw.columnName),
      referencedTableName: String(raw.referencedTableName), referencedColumnName: String(raw.referencedColumnName),
      ordinalPosition: Number(raw.ordinalPosition),
    }
    const key = `${column.tableName}\u0000${column.constraintName}`
    groups.set(key, [...(groups.get(key) ?? []), column])
  }
  for (const columns of groups.values()) {
    const child = quoteMysqlIdentifier(columns[0].tableName)
    const parent = quoteMysqlIdentifier(columns[0].referencedTableName)
    const join = columns.map((column) => `c.${quoteMysqlIdentifier(column.columnName)}=p.${quoteMysqlIdentifier(column.referencedColumnName)}`).join(' AND ')
    const present = columns.map((column) => `c.${quoteMysqlIdentifier(column.columnName)} IS NOT NULL`).join(' AND ')
    const missing = `p.${quoteMysqlIdentifier(columns[0].referencedColumnName)} IS NULL`
    const [orphanRows] = await pool.query<import('mysql2').RowDataPacket[]>(`
      SELECT COUNT(*) AS count FROM ${child} c LEFT JOIN ${parent} p ON ${join} WHERE ${present} AND ${missing}
    `)
    if (Number(orphanRows[0]?.count) !== 0) throw new Error(`foreign key orphan audit failed: ${columns[0].constraintName}`)
  }
  return groups.size
}

async function main() {
  await ensureSchema()
  const mysqlEnvironment = await assertApprovedMySqlEnvironment()
  const marker = `mysql-smoke-${randomUUID()}`
  const [createdUser] = await db.insert(users).values({
    email: `${marker}@example.invalid`,
    name: 'MySQL Smoke',
    role: '系统管理员',
    department: '测试',
    passwordHash: await hashPassword(randomUUID()),
  }).$returningId()
  const [user] = await db.select().from(users).where(eq(users.id, createdUser.id)).limit(1)
  if (!user) throw new Error('MySQL smoke failed to create isolated test user')

  let projectId = ''
  let meetingId = ''
  let todoId = ''
  let riskId = ''
  let conversationId = ''
  let leadId = ''
  let taskId = ''

  try {
    const project = await createProject({
      name: marker,
      companyName: `${marker}-company`,
      owner: user.name,
      collaborators: [],
      tags: ['mysql'],
    }, user.id)
    projectId = project.id
    await updateProject(project.id, { summary: 'MySQL migration smoke' }, user.id)
    await pinProject(project.id, true, user.id)
    const projectPage = await listProjects({ keyword: marker, page: 1, pageSize: 10 })
    if (projectPage.total !== 1 || projectPage.list[0]?.id !== project.id) {
      throw new Error('project CRUD/search smoke failed')
    }
    const [scalarProject] = await db.select().from(projects).where(eq(projects.id, project.id)).limit(1)
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project.id)
      || scalarProject?.pinned !== true
      || !(scalarProject.createdAt instanceof Date)
      || !Array.isArray(scalarProject.tags)
    ) throw new Error('UUID/JSON/DATETIME/BOOLEAN scalar contract smoke failed')

    const longText = `${marker}:`.padEnd(70_000, '长')
    const knownUtcTime = new Date('2024-02-29T12:34:56.789Z')
    const [longConversation] = await db.insert(agentConversations).values({
      userId: user.id, projectId: project.id, title: marker, scope: 'project', status: 'idle', runtime: 'jw',
      createdAt: knownUtcTime, updatedAt: knownUtcTime,
    }).$returningId()
    await db.insert(agentMessages).values({
      conversationId: longConversation.id, role: 'user', sequence: 0, content: longText,
    })
    const [longMessage] = await db.select().from(agentMessages)
      .where(eq(agentMessages.conversationId, longConversation.id)).limit(1)
    if (longMessage?.content !== longText) throw new Error('LONGTEXT round-trip smoke failed')
    const [timeConversation] = await db.select().from(agentConversations)
      .where(eq(agentConversations.id, longConversation.id)).limit(1)
    if (timeConversation?.createdAt.getTime() !== knownUtcTime.getTime()) {
      throw new Error('UTC instant round-trip smoke failed')
    }
    await db.delete(agentConversations).where(eq(agentConversations.id, longConversation.id))

    const rollbackName = `${marker}-rollback`
    try {
      await db.transaction(async (tx) => {
        await tx.insert(projects).values({
          name: rollbackName, owner: user.name, ownerUserId: user.id, createdBy: user.id,
        })
        throw new Error('intentional transaction rollback')
      })
    } catch (error) {
      if ((error as Error).message !== 'intentional transaction rollback') throw error
    }
    const [rolledBack] = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, rollbackName)).limit(1)
    if (rolledBack) throw new Error('repository transaction left a partial project write')

    const meeting = await createMeeting({
      projectId: project.id,
      projectName: project.name,
      title: marker,
      host: user.name,
      attendees: [user.name],
      conclusions: ['MySQL ready'],
    }, [], user.id)
    meetingId = meeting.id
    await updateMeeting(meeting.id, { aiSummary: 'updated' }, meeting.version, user.id)

    const todo = await createTodo({
      projectId: project.id,
      projectName: project.name,
      title: marker,
      owner: user.name,
    }, user.id)
    todoId = todo.id
    await updateTodo(todo.id, { status: '进行中' })
    const counts = await todoCounts()
    if (!Number.isFinite(counts['进行中'])) throw new Error('todo aggregation smoke failed')
    await deleteTodo(todo.id)
    todoId = ''

    const risk = await createRisk({
      projectId: project.id,
      projectName: project.name,
      type: '技术',
      title: marker,
    }, user.id)
    riskId = risk.id
    await updateRisk(risk.id, { status: '处置中' }, user.id)
    const riskSummary = await riskCounts()
    if (!riskSummary.some((row) => row.status === '处置中')) throw new Error('risk aggregation smoke failed')

    const conversation = await createConversation(user.id, {
      title: marker,
      scope: 'project',
      projectId: project.id,
      projectName: project.name,
    })
    conversationId = conversation.id
    await appendMessages(user.id, conversation.id, [{
      id: randomUUID(),
      role: 'user',
      content: marker,
    }])
    const renamed = await renameConversation(user.id, conversation.id, 'mysql-renamed')
    if (renamed?.title !== 'mysql-renamed') throw new Error('conversation JSON/update smoke failed')

    await db.insert(projectScoreJobs).values({ projectId: project.id })
    const [projectScoreJob] = await db.select().from(projectScoreJobs)
      .where(eq(projectScoreJobs.projectId, project.id)).limit(1)
    if (!projectScoreJob || projectScoreJob.status !== 'queued') {
      throw new Error('project score job persistence smoke failed')
    }

    const lead = await createLead({
      name: marker,
      companyName: `${marker}有限公司`,
      industry: '人工智能',
      source: 'MySQL migration smoke',
      highlights: ['MySQL'],
      risks: [],
      fundingRounds: [],
      riskTags: [],
      sources: [{ title: marker }],
      radarSourceKeys: [],
    }, user.id)
    leadId = lead.id
    await saveLeadScoreJob(lead.id, {
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      updatedAt: new Date().toISOString(),
    })
    await db.insert(leadScoreJobs).values({ leadId: lead.id })
    const [scoreJob] = await db.select().from(leadScoreJobs).where(eq(leadScoreJobs.leadId, lead.id)).limit(1)
    if (!scoreJob || scoreJob.status !== 'queued') throw new Error('lead score job persistence smoke failed')
    const leadPage = await listLeads({ keyword: marker, page: 1, pageSize: 10 })
    if (leadPage.total !== 1 || leadPage.list[0]?.id !== lead.id) {
      throw new Error('lead MySQL JSON/search smoke failed')
    }
    const leadStats = await leadPoolStats()
    if (leadStats.total < 1) throw new Error('lead stats smoke failed')
    await clearLeadScoreJob(lead.id)

    const [task] = await db.insert(aiTasks).values({
      userId: user.id,
      projectId: project.id,
      conversationId: conversation.id,
      type: 'project_qa',
      parameters: { marker },
      templateVersion: 'mysql-smoke',
      idempotencyKey: marker,
      requestHash: marker,
    }).$returningId()
    taskId = task.id
    const [aiTask] = await db.select().from(aiTasks).where(eq(aiTasks.id, task.id)).limit(1)
    if (!aiTask || aiTask.executionAttempts !== 0 || aiTask.leaseOwner !== null) {
      throw new Error('AI task lease schema smoke failed')
    }

    await db.insert(aiSummaries).values({
      projectId: project.id,
      positioning: marker,
      highlights: [],
      risks: [],
      questions: [],
      missing: [],
      sources: [],
    })

    await saveRadarSyncState({ id: marker, backfillCursor: 'cursor', backfillComplete: false })
    await db.insert(runtimeJobs).values({
      id: marker,
      task: 'mysql-smoke',
      scheduleKind: 'interval',
      intervalSeconds: 60,
      nextRunAt: new Date(Date.now() + 60_000),
    })
    await db.insert(runtimeJobRuns).values({
      jobId: marker,
      task: 'mysql-smoke',
      status: 'succeeded',
      leaseOwner: marker,
      finishedAt: new Date(),
      result: { ok: true },
    })
    const [runtimeJob] = await db.select().from(runtimeJobs).where(eq(runtimeJobs.id, marker)).limit(1)
    if (!runtimeJob || runtimeJob.task !== 'mysql-smoke') throw new Error('runtime job persistence smoke failed')
    const foreignKeys = await assertNoForeignKeyOrphans()

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'schema', 'mysql-server-contract', 'innodb-utf8mb4-table-contract', 'no-aipin-table',
        'isolated-user', 'project', 'project-score-jobs', 'meeting', 'todo', 'risk', 'conversation',
        'lead-json-search', 'lead-stats', 'lead-score-jobs', 'ai-task-lease', 'ai-summary',
        'radar-state', 'runtime-jobs', 'mysql-scalar-types', 'transaction-rollback', 'foreign-keys',
      ],
      foreignKeys,
      mysqlEnvironment,
    }))
  } finally {
    if (taskId) await db.delete(aiTasks).where(eq(aiTasks.id, taskId))
    if (leadId) await db.delete(knowledgeChunks).where(eq(knowledgeChunks.refId, leadId))
    if (projectId) await db.delete(knowledgeChunks).where(eq(knowledgeChunks.refId, projectId))
    if (leadId) await db.delete(leads).where(eq(leads.id, leadId))
    await db.delete(aiSummaries).where(eq(aiSummaries.projectId, projectId || '__none__'))
    if (riskId) await db.delete(risks).where(eq(risks.id, riskId))
    if (todoId) await db.delete(todos).where(eq(todos.id, todoId))
    if (meetingId) await db.delete(meetings).where(eq(meetings.id, meetingId))
    if (conversationId) await deleteConversation(user.id, conversationId)
    await db.delete(radarSyncState).where(eq(radarSyncState.id, marker))
    await db.delete(runtimeJobs).where(eq(runtimeJobs.id, marker))
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId))
    await db.delete(auditLogs).where(eq(auditLogs.userId, user.id))
    await db.delete(users).where(eq(users.id, user.id))
  }
}

main()
  .catch((error) => {
    console.error('[mysql smoke]', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
