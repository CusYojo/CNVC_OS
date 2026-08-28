import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { oaApprovalRequests, projectStageDates, projects } from '../db/schema.js'
import { buildAgentTimeline } from '../contracts/fdeAgentScheduleContract.js'
import { shanghaiToday } from '../contracts/fdeWeeklyPlanContract.js'

export async function readAgentTimeline(reader: Pick<typeof db, 'select'>, project: typeof projects.$inferSelect) {
  const dates = await reader.select().from(projectStageDates).where(eq(projectStageDates.projectId, project.id))
  const completed = await reader.select({ stage: oaApprovalRequests.fromStage, at: oaApprovalRequests.completedAt }).from(oaApprovalRequests)
    .where(and(eq(oaApprovalRequests.projectId, project.id), eq(oaApprovalRequests.businessType, 'project_stage'), eq(oaApprovalRequests.status, '已通过'))).orderBy(asc(oaApprovalRequests.completedAt))
  const actualDates = Object.fromEntries(completed.flatMap(row => row.at ? [[row.stage, shanghaiToday(row.at)]] : []))
  return buildAgentTimeline(project.targetDate, project.cycleDays, dates, actualDates)
}
