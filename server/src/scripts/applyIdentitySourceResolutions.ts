import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  auditLogs, identityResolutionIssues, meetings, projectFiles, projectMembers,
  projects, todos, users,
} from '../db/schema.js'
import { syncProjectIdentityBindings } from '../services/identityResolutionService.js'

type Resolution = {
  issueId: string; entityType: 'project'; entityId: string; fieldName: 'owner';
  sourceValue: string; reason: string; resolvedUserId: string; resolvedUserName: string;
  sourceDump: string; sourceDumpSha256: string;
  evidence: { projectCreatedBy: string; creationAuditId: string; projectFileIds: string[]; meetingIds: string[]; todoIds: string[] }
  decision: string; decisionBasis: string
}
type ResolutionFile = { schemaVersion: '1.0'; resolutions: Resolution[] }

const apply = process.argv.includes('--apply')
const configuredFile = (() => {
  const index = process.argv.indexOf('--resolution-file')
  return path.resolve(index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : 'docs/迁移计划/identity-source-resolutions-20260809.json')
})()
const outputDir = path.resolve('.runtime/migration-evidence/identity-resolutions')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function fileSha256(filePath: string) {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function sameIds(actual: string[], expected: string[]) {
  return JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...new Set(expected)].sort())
}

async function verifyResolution(resolution: Resolution) {
  assert(resolution.issueId && resolution.entityId && resolution.resolvedUserId, 'resolution identifiers are required')
  assert(resolution.entityType === 'project' && resolution.fieldName === 'owner', 'only project owner resolutions are supported')
  assert(/^[a-f0-9]{64}$/.test(resolution.sourceDumpSha256), 'source dump SHA-256 is invalid')
  assert(await fileSha256(path.resolve(resolution.sourceDump)) === resolution.sourceDumpSha256, 'source dump hash changed')
  const [[issue], [project], [user], [creationAudit], files, meetingRows, todoRows] = await Promise.all([
    db.select().from(identityResolutionIssues).where(eq(identityResolutionIssues.id, resolution.issueId)).limit(1),
    db.select().from(projects).where(eq(projects.id, resolution.entityId)).limit(1),
    db.select().from(users).where(eq(users.id, resolution.resolvedUserId)).limit(1),
    db.select().from(auditLogs).where(eq(auditLogs.id, resolution.evidence.creationAuditId)).limit(1),
    db.select({ id: projectFiles.id, projectId: projectFiles.projectId, uploadedBy: projectFiles.uploadedBy }).from(projectFiles)
      .where(inArray(projectFiles.id, resolution.evidence.projectFileIds)),
    db.select({ id: meetings.id, projectId: meetings.projectId, host: meetings.host, hostUserId: meetings.hostUserId, createdBy: meetings.createdBy }).from(meetings)
      .where(inArray(meetings.id, resolution.evidence.meetingIds)),
    db.select({ id: todos.id, projectId: todos.projectId, owner: todos.owner, ownerUserId: todos.ownerUserId, createdBy: todos.createdBy }).from(todos)
      .where(inArray(todos.id, resolution.evidence.todoIds)),
  ])
  assert(issue && issue.entityType === resolution.entityType && issue.entityId === resolution.entityId
    && issue.fieldName === resolution.fieldName && issue.sourceValue === resolution.sourceValue
    && issue.reason === resolution.reason, 'identity issue no longer matches resolution')
  assert(project && project.owner === resolution.sourceValue && project.createdBy === resolution.evidence.projectCreatedBy, 'project source identity changed')
  assert(user && user.name === resolution.resolvedUserName && user.status === '启用', 'resolved user is missing, renamed or disabled')
  assert(resolution.resolvedUserId === resolution.evidence.projectCreatedBy, 'resolved user differs from stable project creator')
  assert(creationAudit && creationAudit.userId === resolution.resolvedUserId && creationAudit.module === '项目管理'
    && creationAudit.action === '创建项目' && creationAudit.target === project.name, 'creation audit does not bind the same user/project')
  assert(sameIds(files.map((row) => row.id), resolution.evidence.projectFileIds)
    && files.every((row) => row.projectId === project.id && row.uploadedBy === resolution.resolvedUserId), 'project file uploader evidence mismatch')
  assert(sameIds(meetingRows.map((row) => row.id), resolution.evidence.meetingIds)
    && meetingRows.every((row) => row.projectId === project.id && row.hostUserId === resolution.resolvedUserId
      && row.createdBy === resolution.resolvedUserId && row.host === resolution.resolvedUserName), 'meeting host evidence mismatch')
  assert(sameIds(todoRows.map((row) => row.id), resolution.evidence.todoIds)
    && todoRows.every((row) => row.projectId === project.id && row.ownerUserId === resolution.resolvedUserId
      && row.createdBy === resolution.resolvedUserId && row.owner === resolution.resolvedUserName), 'todo owner evidence mismatch')
  return { issue, project, user }
}

async function main() {
  const source = await readFile(configuredFile, 'utf8')
  const resolutionFile = JSON.parse(source) as ResolutionFile
  assert(resolutionFile.schemaVersion === '1.0' && Array.isArray(resolutionFile.resolutions), 'resolution file format is invalid')
  const resolutionFileSha256 = createHash('sha256').update(source).digest('hex')
  const results = []
  for (const resolution of resolutionFile.resolutions) {
    const verified = await verifyResolution(resolution)
    const alreadyApplied = verified.issue.status === 'resolved'
      && verified.issue.resolvedUserId === resolution.resolvedUserId
      && verified.project.ownerUserId === resolution.resolvedUserId
    if (apply && !alreadyApplied) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT ${identityResolutionIssues.id} FROM ${identityResolutionIssues} WHERE ${identityResolutionIssues.id}=${resolution.issueId} FOR UPDATE`)
        await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${resolution.entityId} FOR UPDATE`)
        const [lockedIssue] = await tx.select().from(identityResolutionIssues).where(eq(identityResolutionIssues.id, resolution.issueId)).limit(1)
        assert(lockedIssue?.status === 'open', 'identity issue is no longer open')
        await tx.update(projects).set({ ownerUserId: resolution.resolvedUserId, updatedAt: new Date() })
          .where(eq(projects.id, resolution.entityId))
        await tx.delete(projectMembers).where(and(
          eq(projectMembers.projectId, resolution.entityId), eq(projectMembers.memberRole, 'owner'), ne(projectMembers.userId, resolution.resolvedUserId),
        ))
        await tx.insert(projectMembers).values({
          projectId: resolution.entityId, userId: resolution.resolvedUserId,
          memberRole: 'owner', sourceName: resolution.sourceValue,
        }).onDuplicateKeyUpdate({ set: { memberRole: 'owner', sourceName: resolution.sourceValue } })
        await tx.update(identityResolutionIssues).set({
          status: 'resolved', resolvedUserId: resolution.resolvedUserId,
          resolvedAt: new Date(), updatedAt: new Date(),
        }).where(eq(identityResolutionIssues.id, resolution.issueId))
        await tx.insert(auditLogs).values({
          userName: '迁移程序', module: '身份迁移', action: '应用源证据身份裁决',
          target: `${resolution.issueId}:${resolution.entityId}:${resolution.resolvedUserId}:${resolutionFileSha256}`,
        })
      })
      // Re-run the normal binding path to prove the explicit resolution survives future edits.
      await syncProjectIdentityBindings(resolution.entityId, verified.project.owner, verified.project.collaborators)
    }
    const [afterIssue] = await db.select().from(identityResolutionIssues).where(eq(identityResolutionIssues.id, resolution.issueId)).limit(1)
    const [afterProject] = await db.select().from(projects).where(eq(projects.id, resolution.entityId)).limit(1)
    const [ownerMember] = await db.select().from(projectMembers).where(and(
      eq(projectMembers.projectId, resolution.entityId), eq(projectMembers.userId, resolution.resolvedUserId), eq(projectMembers.memberRole, 'owner'),
    )).limit(1)
    const appliedState = afterIssue?.status === 'resolved' && afterIssue.resolvedUserId === resolution.resolvedUserId
      && afterProject?.ownerUserId === resolution.resolvedUserId && Boolean(ownerMember)
    if (apply) assert(appliedState, 'identity resolution did not persist through normal binding synchronization')
    results.push({
      issueId: resolution.issueId, entityId: resolution.entityId, resolvedUserId: resolution.resolvedUserId,
      evidence: resolution.decisionBasis, alreadyApplied, applied: apply && appliedState,
    })
  }
  const report = {
    ok: true, mode: apply ? 'apply' : 'preview', resolutionFileSha256,
    resolutions: results.length, applied: results.filter((item) => item.applied).length, results,
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(report))
}

await main().finally(async () => pool.end())
