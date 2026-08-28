import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, projects, users } from '../db/schema.js'
import { createProject } from '../services/projectService.js'
import { scheduleTransaction } from '../services/fdeScheduleTransactionService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
const marker = randomUUID(), actorId = randomUUID()
try {
  await db.insert(users).values({ id: actorId, name: `并发-${marker.slice(0, 8)}`, role: '投资经理', department: '隔离验收', email: `${marker}@schedule.invalid`, passwordHash: 'not-for-login' })
  const fixture = []
  for (const suffix of ['A', 'B']) fixture.push(await createProject({ name: `并发回滚-${suffix}-${marker}`, owner: '隔离验收', ownerUserId: actorId, collaborators: [] }, actorId))
  const ids = fixture.map(row => row.id)
  const before = await db.select({ id: projects.id, version: projects.version }).from(projects).where(inArray(projects.id, ids))
  const attempts = [0, 0]
  let arrived = 0, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  // Opposite project row locks guarantee a real InnoDB deadlock on the first
  // attempt; the replay must bypass this first-attempt-only barrier.
  const results = await Promise.all([0, 1].map(index => scheduleTransaction(async tx => {
    attempts[index]++
    await tx.update(projects).set({ version: sql`${projects.version} + 1` }).where(eq(projects.id, ids[index]))
    await tx.insert(auditLogs).values({ userId: actorId, userName: '隔离验收', module: 'FDE事务回滚验收', action: `operation-${index}`, target: marker })
    if (attempts[index] === 1) {
      if (++arrived === 2) release()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([barrier, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('隔离并发夹具未同时到达')), 5000) })])
      } finally { if (timer) clearTimeout(timer) }
    }
    await tx.update(projects).set({ version: sql`${projects.version} + 1` }).where(eq(projects.id, ids[1 - index]))
    return index
  }, { isolationLevel: 'read committed' })))
  assert.deepEqual(results, [0, 1])
  assert.equal(attempts.reduce((a, b) => a + b, 0), 3, '一个死锁受害事务重试一次，其余事务仅执行一次')
  const after = await db.select({ id: projects.id, version: projects.version }).from(projects).where(inArray(projects.id, ids))
  for (const row of after) assert.equal(row.version, before.find(item => item.id === row.id)!.version + 2, '失败事务的第一条写入必须整体回滚')
  const events = await db.select().from(auditLogs).where(and(eq(auditLogs.module, 'FDE事务回滚验收'), eq(auditLogs.target, marker)))
  assert.equal(events.length, 2, '死锁前写入的审计应回滚，不留下第三条副作用')
  assert.deepEqual(events.map(event => event.action).sort(), ['operation-0', 'operation-1'])
  console.log(JSON.stringify({ ok: true, prefix: process.env.DB_FREFIX, passed: 1, attempts, checks: ['FDE-CONC-001/002:real-mysql-deadlock-full-rollback-bounded-retry-and-no-duplicate-events'] }))
} finally { await pool.end() }
