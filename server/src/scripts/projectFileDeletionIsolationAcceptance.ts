import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, projectFileVersions, projects, users } from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import { addFile, deleteFile, deleteProject, setFileStoragePath } from '../services/projectService.js'
import { removeOwnedProjectFile, saveProjectFileRevision } from '../services/projectFileStorageService.js'

function digest(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[project file deletion isolation] ${message}`)
}

async function exists(target: string) {
  return Boolean(await lstat(target).catch(() => null))
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/project-file-deletion-isolation')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryPath, [
    '# 项目文件删除隔离验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    '- 删除目标文件时，当前版本及所属历史版本被清理',
    '- 伪造为其他项目路径的版本记录被归属边界拒绝，其他项目原件保持不变',
    '- 同项目历史 AI 产物、共享模板及项目文件根之外的回滚源均保持不变',
    '',
    '报告不记录文件正文、绝对路径、业务标识或数据库连接身份。',
    '',
  ].join('\n'), { mode: 0o600 })
  await Promise.all([chmod(reportPath, 0o600), chmod(summaryPath, 0o600)])
}

function fileInput(projectId: string, name: string, bytes: Buffer) {
  return {
    projectId, name, type: 'TXT', category: '项目资料', size: `${bytes.length} B`,
    byteSize: bytes.length, sha256: digest(bytes), uploader: '删除隔离验收',
    parseStatus: '解析中', visibility: '项目成员',
  } as const
}

async function main() {
  const marker = randomUUID()
  const projectFileRoot = path.resolve(process.env.PROJECT_FILE_ROOT || 'server/project-files')
  const artifactRoot = path.resolve(process.env.AI_ARTIFACT_ROOT || 'server/ai-artifacts')
  const templateRoot = path.resolve(
    process.env.AI_CUSTOM_TEMPLATE_DATA_ROOT || process.env.AI_CUSTOM_TEMPLATE_ROOT || 'server/ai-template-data',
  )
  const rollbackRoot = await mkdtemp(path.join(tmpdir(), 'project-file-rollback-source-'))
  const sharedTemplateDir = path.join(templateRoot, `deletion-isolation-${marker}`)
  let artifactDir = ''
  const projectIds: string[] = []
  let userId = ''
  try {
    const [user] = await db.insert(users).values({
      email: `file-deletion-${marker}@example.invalid`, name: '文件删除隔离验收', role: '系统管理员',
      department: '验收部', passwordHash: await hashPassword(randomUUID()),
    }).$returningId()
    userId = user.id
    for (const suffix of ['target', 'other']) {
      const [project] = await db.insert(projects).values({
        name: `文件删除隔离-${suffix}-${marker}`, owner: '文件删除隔离验收', ownerUserId: user.id,
        collaborators: [], createdBy: user.id,
      }).$returningId()
      projectIds.push(project.id)
    }
    const [targetProjectId, otherProjectId] = projectIds
    const targetBytes = Buffer.from(`target-${marker}`)
    const otherBytes = Buffer.from(`other-${marker}`)
    const artifactBytes = Buffer.from(`historical-artifact-${marker}`)
    const templateBytes = Buffer.from(`shared-template-${marker}`)
    const rollbackBytes = Buffer.from(`rollback-source-${marker}`)
    const targetFile = await addFile(fileInput(targetProjectId, 'target.txt', targetBytes), user.id)
    const otherFile = await addFile(fileInput(otherProjectId, 'other.txt', otherBytes), user.id)
    const targetPath = await saveProjectFileRevision(targetProjectId, targetFile.id, targetBytes)
    const otherPath = await saveProjectFileRevision(otherProjectId, otherFile.id, otherBytes)
    await setFileStoragePath(targetFile.id, targetPath, user.id)
    await setFileStoragePath(otherFile.id, otherPath, user.id)

    artifactDir = path.join(artifactRoot, user.id, targetProjectId, `historical-${marker}`)
    const artifactPath = path.join(artifactDir, 'historical-output.txt')
    const templatePath = path.join(sharedTemplateDir, 'shared-template.txt')
    const rollbackPath = path.join(rollbackRoot, 'rollback-source.txt')
    await Promise.all([mkdir(artifactDir, { recursive: true }), mkdir(sharedTemplateDir, { recursive: true })])
    await Promise.all([
      writeFile(artifactPath, artifactBytes, { mode: 0o600 }),
      writeFile(templatePath, templateBytes, { mode: 0o600 }),
      writeFile(rollbackPath, rollbackBytes, { mode: 0o600 }),
    ])

    const ownershipError = await removeOwnedProjectFile(otherPath, targetProjectId, targetFile.id)
      .then(() => null, (error: unknown) => error as Error & { code?: string })
    assertContract(ownershipError?.code === 'INVALID_STORAGE_PATH', 'cross-project storage path was not rejected')
    assertContract((await readFile(path.resolve(projectFileRoot, otherPath))).equals(otherBytes), 'ownership rejection changed the other project file')

    await db.insert(projectFileVersions).values({
      fileId: targetFile.id, version: 2, byteSize: otherBytes.length, sha256: digest(otherBytes),
      storagePath: otherPath, createdBy: user.id,
    })
    assertContract(await deleteFile(targetFile.id, user.id), 'target file deletion returned false')
    assertContract(!await exists(path.resolve(projectFileRoot, targetPath)), 'owned target bytes remain after deletion')
    assertContract((await readFile(path.resolve(projectFileRoot, otherPath))).equals(otherBytes), 'other project bytes were deleted or changed')
    assertContract((await readFile(artifactPath)).equals(artifactBytes), 'historical AI artifact was deleted or changed')
    assertContract((await readFile(templatePath)).equals(templateBytes), 'shared template was deleted or changed')
    assertContract((await readFile(rollbackPath)).equals(rollbackBytes), 'rollback source was deleted or changed')
    const targetVersions = await db.select({ id: projectFileVersions.id }).from(projectFileVersions)
      .where(eq(projectFileVersions.fileId, targetFile.id))
    assertContract(targetVersions.length === 0, 'deleted target file version metadata remains')

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      pathsExcluded: true,
      contentExcluded: true,
      checks: [
        'owned-current-and-history-bytes-removed',
        'cross-project-poisoned-storage-path-rejected',
        'other-project-file-byte-equal',
        'historical-ai-artifact-byte-equal',
        'shared-template-byte-equal',
        'off-root-rollback-source-byte-equal',
        'deleted-file-version-metadata-cascaded',
        'evidence-excludes-paths-content-and-identities',
      ],
    }
    await persistEvidence(report)
    console.log(JSON.stringify(report))
  } finally {
    for (const projectId of projectIds) await deleteProject(projectId, userId).catch(() => {})
    if (userId) {
      await db.delete(auditLogs).where(eq(auditLogs.userId, userId)).catch(() => {})
      await db.delete(users).where(inArray(users.id, [userId])).catch(() => {})
    }
    await Promise.all([
      rm(rollbackRoot, { recursive: true, force: true }),
      rm(sharedTemplateDir, { recursive: true, force: true }),
      artifactDir ? rm(artifactDir, { recursive: true, force: true }) : Promise.resolve(),
    ])
  }
}

await main().finally(async () => pool.end())
