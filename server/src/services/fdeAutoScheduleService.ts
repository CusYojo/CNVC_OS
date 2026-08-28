import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { leaderTimeBatches, leaderTimeRequests, projects } from '../db/schema.js'
import { autoScheduleApply, autoScheduleSelection, timeDefinitionSchema, timeInstant, timeLocal, type AutoScheduleItem, type AutoScheduleResult } from '../contracts/fdeTimeContract.js'
import { planLeadershipTimes, type BusyInterval, type ScheduleCandidate } from '../contracts/fdeAutoScheduleContract.js'
import { shiftDate } from '../contracts/fdeWeeklyPlanContract.js'
import { timeActor, timeFail, timeScope, type TimeTx } from './fdeTimeAccessService.js'
import { recordTimeEvent, timeHash } from './fdeTimeEventsService.js'
import { lockSchedulePeople, scheduleConflicts } from './fdeScheduleService.js'
import { canReadReferencedDirectiveTasks } from './fdeDirectiveLinksService.js'
import { scheduleTransaction } from './fdeScheduleTransactionService.js'
import type { z } from 'zod'
import { readTimelineTimeSource } from './fdeTimelineTimeService.js'

type Selection = z.infer<typeof autoScheduleSelection>
async function selected(tx: TimeTx, userId: string, selection: Selection, checkVersions = true) {
  await timeActor(tx, userId)
  const rows = await tx.select().from(leaderTimeRequests).where(inArray(leaderTimeRequests.id, selection.requests.map(row => row.id)))
  if (rows.length !== selection.requests.length) return timeFail('TIME_BATCH_FORBIDDEN', '部分需求不存在或不可处理', 403)
  for (const row of rows) {
    const scope = await timeScope(tx, userId, row.projectId)
    if (!(scope.coordinator || scope.full && scope.leader && row.leaderId === userId) || scope.project.lifecycle !== 'active') return timeFail('TIME_BATCH_FORBIDDEN', '仅协调人或对应领导可对有效项目生成方案', 403)
    if (row.status === 'draft' && (!scope.full || row.taskId && !await canReadReferencedDirectiveTasks(tx, [row.taskId], userId))) return timeFail('TIME_BATCH_FORBIDDEN', '无权读取未提交草稿', 403)
    if (checkVersions && row.version !== selection.requests.find(item => item.id === row.id)!.expectedVersion) return timeFail('VERSION_CONFLICT', '需求已变化，请刷新后重新预览')
  }
  return rows
}
async function compute(tx: TimeTx, userId: string, selection: Selection): Promise<AutoScheduleResult> {
  const rows = await selected(tx, userId, selection), items: AutoScheduleItem[] = [], candidates: ScheduleCandidate[] = []
  for (const row of rows) {
    const complete = timeDefinitionSchema.safeParse({ ...Object.fromEntries(['title', 'reason', 'outcome', 'impact', 'priority', 'location', 'durationMinutes'].map(key => [key, row[key as keyof typeof row]])), preferredStart: timeLocal(row.preferredStart), alternativeStart: row.alternativeStart ? timeLocal(row.alternativeStart) : '' }).success
    const source = await readTimelineTimeSource(tx, row)
    const eligible = ['requested', 'pending'].includes(row.status) && complete && row.priority !== null && !source?.view.changed
    items.push({ id: row.id, title: row.title, priority: row.priority, expectedVersion: row.version, from: row.scheduledStart?.toISOString() ?? null, scheduledStart: row.scheduledStart?.toISOString() ?? null, durationMinutes: row.durationMinutes, result: 'skipped', reason: !['requested', 'pending'].includes(row.status) ? '已确认、草稿、需补信息或终态不参与重排' : !row.priority ? '请先明确需求优先级' : !complete ? '请先补全申请信息' : '' })
    items[items.length - 1].latestFinish = row.latestFinish?.toISOString() ?? null
    if (source?.view.changed) items[items.length - 1].reason = source.view.reason
    if (eligible) candidates.push({ id: row.id, leaderId: row.leaderId, priority: row.priority!, latestFinish: row.latestFinish?.toISOString() ?? null, preferredStart: row.preferredStart.toISOString(), alternativeStart: row.alternativeStart?.toISOString() ?? null, durationMinutes: row.durationMinutes })
  }
  const occupied: Record<string, BusyInterval[]> = {}
  for (const leader of [...new Set(candidates.map(row => row.leaderId))].sort()) occupied[leader] = (await scheduleConflicts(tx, leader, timeInstant(`${selection.weekStart}T00:00`), timeInstant(`${shiftDate(selection.weekStart, 7)}T00:00`), { excludeTimeIds: candidates.map(row => row.id) })).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.endsAt.localeCompare(b.endsAt))
  const now = new Date()
  for (const proposal of planLeadershipTimes(candidates, occupied, selection.weekStart, now)) {
    const item = items.find(row => row.id === proposal.id)!
    const exceedsDeadline = proposal.scheduledStart && item.latestFinish && new Date(proposal.scheduledStart).getTime() + item.durationMinutes * 60000 > new Date(item.latestFinish).getTime()
    Object.assign(item, { scheduledStart: proposal.scheduledStart, result: proposal.scheduledStart ? 'arranged' : 'overflow', reason: proposal.scheduledStart
      ? `按优先级、最晚完成时间和稳定编号排序，避开已有占用；仍需领导确认${!item.latestFinish ? '；历史最晚完成时间待补充，同优先级排在有期限需求之后' : exceedsDeadline ? '；方案结束晚于最晚完成时间，请人工核对' : ''}`
      : '所选周 07:00—20:00 无可用时段，保留待排序；可调整需求后重试' })
  }
  items.sort((a, b) => a.id.localeCompare(b.id))
  const fingerprint = timeHash({ userId, weekStart: selection.weekStart, items, occupied, rulesVersion: 'fde-priority-deadline-v2' })
  return { weekStart: selection.weekStart, fingerprint, items, arranged: items.filter(row => row.result === 'arranged').length, overflow: items.filter(row => row.result === 'overflow').length, skipped: items.filter(row => row.result === 'skipped').length, rulesVersion: 'fde-priority-deadline-v2' }
}
export async function previewAutoSchedule(userId: string, raw: unknown) {
  const selection = autoScheduleSelection.parse(raw)
  return db.transaction(tx => compute(tx, userId, selection), { isolationLevel: 'read committed' })
}
export async function applyAutoSchedule(userId: string, raw: unknown) {
  const input = autoScheduleApply.parse(raw), hash = timeHash({ userId, input })
  // Stable project/leader association cannot be edited by a time mutation. Recheck all rows after locks.
  const initial = await db.select().from(leaderTimeRequests).where(inArray(leaderTimeRequests.id, input.selection.requests.map(row => row.id)))
  return scheduleTransaction(async tx => {
    for (const id of [...new Set(initial.map(row => row.projectId))].sort()) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${id} FOR UPDATE`)
    await lockSchedulePeople(tx, [userId, ...initial.map(row => row.leaderId)])
    await selected(tx, userId, input.selection, false)
    const [prior] = await tx.select().from(leaderTimeBatches).where(eq(leaderTimeBatches.id, input.clientRequestId))
    if (prior) {
      if (prior.actorId !== userId || prior.requestHash !== hash) return timeFail('TIME_BATCH_REQUEST_REUSED', '请求编号已用于其他方案')
      return prior.result
    }
    const result = await compute(tx, userId, input.selection)
    if (result.fingerprint !== input.fingerprint) return timeFail('TIME_BATCH_STALE', '需求或占用已变化，请重新预览方案；未保存任何排期')
    for (const item of result.items) {
      if (item.result === 'skipped') continue
      await tx.update(leaderTimeRequests).set({ scheduledStart: item.scheduledStart ? new Date(item.scheduledStart) : null, status: item.result === 'arranged' ? 'pending' : 'requested', scheduleNote: item.reason, confirmedAt: null, confirmedBy: null, version: item.expectedVersion + 1 }).where(eq(leaderTimeRequests.id, item.id))
      await recordTimeEvent(tx, item.id, userId, 'auto-schedule', `${input.clientRequestId} / ${result.rulesVersion} / ${item.reason}`)
    }
    await tx.insert(leaderTimeBatches).values({ id: input.clientRequestId, actorId: userId, requestHash: hash, result })
    return result
  }, { isolationLevel: 'read committed' })
}
