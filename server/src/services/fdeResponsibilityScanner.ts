import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, isNotNull, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projects, todos, responsibilityPolicies, responsibilityScanCycles as cycles, responsibilityScanState as state } from '../db/schema.js'
import { captureScannedDeadlineResponsibility } from './fdeResponsibilityService.js'
import { responsibilityScanLimit, responsibilityScannerEnabled, responsibilityScannerErrorCode } from '../contracts/fdeResponsibilityScannerContract.js'
import { responsibilityBusinessDate } from '../contracts/fdeResponsibilityPolicyContract.js'

const name = 'responsibility-deadlines-v1'

// Each task and its checkpoint are one transaction. The singleton lock makes
// two processes cooperate without an expiring lease or a stale worker fence.
// No project/policy transaction acquires the scanner lock in the reverse order.
async function step(expectedCycleId: string | null) {
  return db.transaction(async tx => {
    await tx.insert(state).values({ name }).onDuplicateKeyUpdate({ set: { name } })
    const [head] = await tx.select().from(state).where(eq(state.name, name)).for('update')
    if (expectedCycleId && head.cycleId !== expectedCycleId) return { state: 'rotated' as const, cycleId: expectedCycleId, candidates: 0 }
    let cycleId = head.cycleId
    if (!cycleId) {
      const asOf = new Date()
      const [upper] = await tx.select({ id: todos.id }).from(todos).where(and(eq(todos.executionModel, 'fde-v1'), lte(todos.createdAt, asOf))).orderBy(desc(todos.id)).limit(1)
      cycleId = randomUUID()
      await tx.insert(cycles).values({ id: cycleId, asOf, upperTaskId: upper?.id ?? null })
      await tx.update(state).set({ cycleId }).where(eq(state.name, name))
    }
    const [cycle] = await tx.select().from(cycles).where(eq(cycles.id, cycleId)).for('update')
    if (!cycle || cycle.completedAt) throw Object.assign(new Error('扫描游标与批次不一致'), { code: 'RESP_SCAN_STATE_INVALID' })
    const [candidate] = cycle.upperTaskId ? await tx.select({ id: todos.id, projectId: todos.projectId }).from(todos).where(and(
      eq(todos.executionModel, 'fde-v1'), isNotNull(todos.projectId), isNotNull(todos.dueDate), lte(todos.dueDate, responsibilityBusinessDate(cycle.asOf)), lte(todos.createdAt, cycle.asOf),
      lte(todos.id, cycle.upperTaskId), cycle.cursorTaskId ? gt(todos.id, cycle.cursorTaskId) : undefined,
    )).orderBy(asc(todos.id)).limit(1) : []
    if (!candidate) {
      await tx.update(cycles).set({ completedAt: new Date(), lastErrorCode: null }).where(eq(cycles.id, cycleId))
      await tx.update(state).set({ cycleId: null }).where(eq(state.name, name))
      return { state: 'complete' as const, cycleId, candidates: 0 }
    }
    // Match the project's existing writer lock order. Never hold two projects
    // across a policy lock; a batch is deliberately not one huge transaction.
    const [project] = await tx.select().from(projects).where(eq(projects.id, candidate.projectId!)).for('update')
    const [task] = await tx.select().from(todos).where(eq(todos.id, candidate.id)).for('update')
    const result = project && task && task.projectId === project.id
      ? await captureScannedDeadlineResponsibility(tx, project, task, cycleId, cycle.asOf)
      : { candidates: 0, outcome: 'source_removed' }
    await tx.update(cycles).set({ cursorTaskId: candidate.id, processed: cycle.processed + 1, candidates: cycle.candidates + result.candidates, lastErrorCode: null }).where(eq(cycles.id, cycleId))
    return { state: 'processed' as const, cycleId, candidates: result.candidates }
  }, { isolationLevel: 'read committed' })
}

export async function runResponsibilityScanBatch(options: { limit?: number; shouldStop?: () => boolean } = {}) {
  const limit = responsibilityScanLimit.parse(options.limit ?? 25)
  let cycleId: string | null = null, processed = 0, candidates = 0
  for (let i = 0; i < limit && !options.shouldStop?.(); i++) {
    // Read-only fast path. Current policy is locked and rechecked again under
    // the source transaction; disabling does not reset a retained checkpoint.
    const [policy] = await db.select({ enabled: responsibilityPolicies.enabled }).from(responsibilityPolicies).where(eq(responsibilityPolicies.code, 'responsibility'))
    if (!policy?.enabled) return { state: 'disabled' as const, cycleId, processed, candidates }
    try {
      const result = await step(cycleId)
      cycleId = result.cycleId
      if (result.state !== 'processed') return { state: result.state, cycleId, processed, candidates }
      processed++; candidates += result.candidates
    } catch (error) {
      // A failed source transaction never advances the cursor. Store only a
      // sanitized code, not SQL, source content or stack traces, then retry on
      // the next scheduled run (not an unknown-outcome business replay here).
      await db.transaction(async tx => {
        const [head] = await tx.select().from(state).where(eq(state.name, name)).for('update')
        if (head?.cycleId && (!cycleId || head.cycleId === cycleId)) await tx.update(cycles).set({ lastErrorCode: responsibilityScannerErrorCode(error) }).where(eq(cycles.id, head.cycleId))
      }).catch(() => undefined)
      throw error
    }
  }
  return { state: 'partial' as const, cycleId, processed, candidates }
}

let timer: ReturnType<typeof setTimeout> | null = null
let active: Promise<void> | null = null
let stopping = true
let lastRunAt: string | null = null, lastErrorCode: string | null = null
const enabled = () => responsibilityScannerEnabled(process.env.FDE_RESPONSIBILITY_SCANNER_ENABLED)
export function responsibilityScannerHealth() {
  return { name: 'fde-responsibility-scanner', ok: !enabled() || !lastErrorCode, inProcess: true, enabled: enabled(), state: !enabled() ? 'intentionally-disabled' : lastErrorCode ? 'error' : stopping ? 'stopped' : active ? 'running' : 'idle', lastRunAt, lastErrorCode }
}
export function startResponsibilityScanner() {
  if (!enabled() || !stopping) return
  stopping = false
  const tick = () => {
    if (stopping) return
    let delay = 60_000
    active = runResponsibilityScanBatch({ shouldStop: () => stopping }).then(result => { lastRunAt = new Date().toISOString(); lastErrorCode = null; if (result.state === 'partial' || result.state === 'rotated') delay = 1000 }, error => {
      lastErrorCode = responsibilityScannerErrorCode(error)
      console.error(JSON.stringify({ component: 'fde-responsibility-scanner', code: lastErrorCode }))
    }).finally(() => {
      active = null
      if (!stopping) { timer = setTimeout(tick, delay); timer.unref() }
    })
  }
  tick()
}
export async function stopResponsibilityScanner() {
  stopping = true
  if (timer) clearTimeout(timer)
  timer = null
  await active
}
