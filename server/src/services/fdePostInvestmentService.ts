import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectDutyAssignments, projectFiles, projectMembers, projectPostInvestmentUpdateFiles, projectPostInvestmentUpdates, projects, todos, users } from '../db/schema.js'
import { requireAccessibleProject } from './projectAccessService.js'

const failure = (code: string, message: string) => Object.assign(new Error(message), { status: 409, code })
export async function listPostInvestmentUpdates(projectId: string, userId: string) {
  await requireAccessibleProject(userId, projectId)
  return db.select({ id: projectPostInvestmentUpdates.id, content: projectPostInvestmentUpdates.content, createdAt: projectPostInvestmentUpdates.createdAt, author: users.name })
    .from(projectPostInvestmentUpdates).innerJoin(users, eq(users.id, projectPostInvestmentUpdates.authorId)).where(eq(projectPostInvestmentUpdates.projectId, projectId))
}
export async function createPostInvestmentUpdate(input: { projectId: string; userId: string; content: string; fileIds: string[]; leaderIds: string[] }) {
  const project = await requireAccessibleProject(input.userId, input.projectId)
  if (project.stage !== '投后') throw failure('FDE_POST_INVESTMENT_REQUIRED', '项目尚未进入投后阶段')
  const [member] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.userId, input.userId))).limit(1)
  if (!member) throw failure('FDE_PROJECT_TEAM_REQUIRED', '仅项目成员可更新投后情况')
  const id = randomUUID()
  await db.transaction(async tx => {
    const files = input.fileIds.length ? await tx.select({ id: projectFiles.id }).from(projectFiles).where(and(eq(projectFiles.projectId, input.projectId), inArray(projectFiles.id, input.fileIds))) : []
    if (files.length !== input.fileIds.length) throw failure('POST_INVESTMENT_FILE_INVALID', '关联文件不属于当前项目')
    const leaders = input.leaderIds.length ? await tx.select({ id: projectDutyAssignments.userId, duty: projectDutyAssignments.duty, name: users.name }).from(projectDutyAssignments).innerJoin(users, eq(users.id, projectDutyAssignments.userId)).where(and(eq(projectDutyAssignments.projectId, input.projectId), inArray(projectDutyAssignments.userId, input.leaderIds))) : []
    if (leaders.some(row => row.duty !== 'chairman' && row.duty !== 'president') || leaders.length !== input.leaderIds.length) throw failure('POST_INVESTMENT_LEADER_INVALID', '只能提醒本项目董事长或总裁')
    await tx.insert(projectPostInvestmentUpdates).values({ id, projectId: input.projectId, authorId: input.userId, content: input.content })
    if (files.length) await tx.insert(projectPostInvestmentUpdateFiles).values(files.map(file => ({ updateId: id, fileId: file.id })))
    if (leaders.length) await tx.insert(todos).values(leaders.map(leader => ({ id: randomUUID(), projectId: input.projectId, projectName: project.name, title: `投后更新：${project.name}`, owner: leader.name, ownerUserId: leader.id, priority: '中', status: '未开始', type: '通知', createdBy: input.userId })))
  })
  return { id }
}
