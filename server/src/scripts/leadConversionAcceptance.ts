import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, count, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { aiSummaries, auditLogs, leads, projectFiles, projectMembers, projects, users } from '../db/schema.js'
import { convertLead } from '../services/aiSummaryService.js'

const checks: string[] = []
function check(name: string, assertion: () => void) {
  assertion()
  checks.push(name)
}

await ensureSchema()
const marker = randomUUID().slice(0, 8)
const userId = randomUUID()
const leadId = randomUUID()
const userName = `线索转项目验收-${marker}`
const leadName = `真实线索-${marker}`

try {
  await db.insert(users).values({
    id: userId,
    email: `lead-convert-${marker}@example.invalid`,
    name: userName,
    role: '投资经理',
    department: '线索验收',
    passwordHash: 'lead-convert-acceptance-not-for-login',
  })
  await db.insert(leads).values({
    id: leadId,
    name: leadName,
    companyName: `真实主体-${marker}`,
    industry: '先进制造',
    source: '验收原始事件',
    score: 68,
    summary: '仅来自验收夹具的线索摘要',
    team: '已披露团队信息',
    riskTags: ['客户集中度待核验', '融资口径待核验'],
    fundingRounds: [{ round: 'A轮', amount: '人民币1亿元', valuation: '人民币5亿元' }],
    radarProfile: { profile: { project_round: '旧轮次', latest_valuation: '旧估值' } },
    poolStatus: '公共池',
  })

  const concurrent = await Promise.allSettled([
    convertLead(leadId, userId),
    convertLead(leadId, userId),
  ])
  const succeeded = concurrent.filter((result) => result.status === 'fulfilled')
  const rejected = concurrent.filter((result) => result.status === 'rejected')
  check('concurrent-lead-conversion-creates-exactly-one-project', () => {
    assert.equal(succeeded.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'LEAD_ALREADY_CONVERTED')
  })

  const result = (succeeded[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof convertLead>>>).value
  const [project] = await db.select().from(projects).where(eq(projects.id, result.project.id)).limit(1)
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)
  const [member] = await db.select().from(projectMembers).where(and(
    eq(projectMembers.projectId, project.id),
    eq(projectMembers.userId, userId),
  )).limit(1)
  check('lead-project-link-owner-and-factual-fields-persist-atomically', () => {
    assert.equal(lead.convertedProjectId, project.id)
    assert.equal(lead.claimedBy, userName)
    assert.equal(project.ownerUserId, userId)
    assert.equal(member?.memberRole, 'owner')
    assert.equal(project.companyName, `真实主体-${marker}`)
    assert.equal(project.round, 'A轮')
    assert.equal(project.financing, '人民币1亿元')
    assert.equal(project.valuation, '人民币5亿元')
    assert.equal(project.summary, '仅来自验收夹具的线索摘要')
  })

  const [{ value: fakeSummaryCount }] = await db.select({ value: count() }).from(aiSummaries)
    .where(eq(aiSummaries.projectId, project.id))
  const [{ value: fakeFileCount }] = await db.select({ value: count() }).from(projectFiles)
    .where(eq(projectFiles.projectId, project.id))
  check('conversion-does-not-manufacture-summary-or-file-records', () => {
    assert.equal(Number(fakeSummaryCount), 0)
    assert.equal(Number(fakeFileCount), 0)
  })

  const actorAudits = await db.select().from(auditLogs).where(and(
    eq(auditLogs.userId, userId),
    eq(auditLogs.target, leadName),
  ))
  check('conversion-audit-records-the-real-actor', () => {
    assert.equal(actorAudits.length, 2)
    assert.ok(actorAudits.every((audit) => audit.userName === userName))
  })

  const missingLeadError = await convertLead(randomUUID(), userId).then(() => null, (error) => error)
  const [{ value: projectCount }] = await db.select({ value: count() }).from(projects)
    .where(eq(projects.createdBy, userId))
  check('missing-lead-failure-does-not-create-orphan-project', () => {
    assert.equal(missingLeadError?.code, 'LEAD_NOT_FOUND')
    assert.equal(Number(projectCount), 1)
  })

  console.log(JSON.stringify({ ok: true, checks }))
} finally {
  await db.delete(auditLogs).where(eq(auditLogs.userId, userId)).catch(() => {})
  await db.delete(leads).where(eq(leads.id, leadId)).catch(() => {})
  await db.delete(projects).where(eq(projects.createdBy, userId)).catch(() => {})
  await db.delete(users).where(eq(users.id, userId)).catch(() => {})
  await pool.end()
}
