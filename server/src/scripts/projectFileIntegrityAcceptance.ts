import { createHash, randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, projectFileVersions, projects, users } from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import {
  addFile, deleteProject, getFileVersion, listFileVersions, replaceFileContent, setFileStoragePath,
} from '../services/projectService.js'
import { openProjectFile, removeProjectFile, saveProjectFileRevision } from '../services/projectFileStorageService.js'

const quotaKeys = [
  'PROJECT_FILE_MAX_COUNT_PER_PROJECT', 'PROJECT_FILE_MAX_BYTES_PER_PROJECT', 'PROJECT_FILE_MAX_BYTES_PER_USER',
] as const

function digest(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function expectCode(run: () => Promise<unknown>, code: string) {
  const error = await run().then(() => null, (caught: unknown) => caught as Error & { code?: string })
  if (!error || error.code !== code) throw new Error(`expected ${code}, received ${error?.code || error?.message || 'success'}`)
}

function fileInput(projectId: string, name: string, byteSize: number, sha256: string) {
  return {
    projectId, name, type: 'TXT', category: '项目资料', size: `${byteSize} B`, byteSize, sha256,
    uploader: '文件完整性验收', parseStatus: '解析中', visibility: '项目成员',
  } as const
}

async function readStored(storagePath: string) {
  const opened = await openProjectFile(storagePath)
  const chunks: Buffer[] = []
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function main() {
  const previous = Object.fromEntries(quotaKeys.map((key) => [key, process.env[key]]))
  const marker = randomUUID()
  const [user] = await db.insert(users).values({
    email: `file-integrity-${marker}@example.invalid`, name: '文件完整性验收', role: '系统管理员',
    department: '验收部', passwordHash: await hashPassword(randomUUID()),
  }).$returningId()
  const projectIds: string[] = []
  try {
    for (const suffix of ['A', 'B']) {
      const [project] = await db.insert(projects).values({
        name: `文件完整性项目${suffix}-${marker}`, owner: '文件完整性验收', ownerUserId: user.id,
        collaborators: [], createdBy: user.id,
      }).$returningId()
      projectIds.push(project.id)
    }
    const [projectA, projectB] = projectIds
    process.env.PROJECT_FILE_MAX_COUNT_PER_PROJECT = '2'
    process.env.PROJECT_FILE_MAX_BYTES_PER_PROJECT = '10'
    process.env.PROJECT_FILE_MAX_BYTES_PER_USER = '12'

    const firstBytes = Buffer.from('123456')
    const first = await addFile(fileInput(projectA, 'first.txt', firstBytes.length, digest(firstBytes)), user.id)
    await expectCode(
      () => addFile(fileInput(projectA, 'same-content.txt', firstBytes.length, digest(firstBytes)), user.id),
      'DUPLICATE_CONTENT',
    )
    await expectCode(
      () => addFile(fileInput(projectA, 'project-overflow.txt', 5, digest(Buffer.from('abcde'))), user.id),
      'PROJECT_FILE_STORAGE_LIMIT',
    )
    await addFile(fileInput(projectA, 'second.txt', 4, digest(Buffer.from('abcd'))), user.id)
    await expectCode(
      () => addFile(fileInput(projectA, 'count-overflow.txt', 0, digest(Buffer.alloc(0))), user.id),
      'PROJECT_FILE_COUNT_LIMIT',
    )
    await expectCode(
      () => addFile(fileInput(projectB, 'user-overflow.txt', 3, digest(Buffer.from('xyz'))), user.id),
      'USER_FILE_STORAGE_LIMIT',
    )

    process.env.PROJECT_FILE_MAX_COUNT_PER_PROJECT = '1'
    process.env.PROJECT_FILE_MAX_BYTES_PER_PROJECT = '100'
    process.env.PROJECT_FILE_MAX_BYTES_PER_USER = '100'
    const concurrent = await Promise.allSettled([
      addFile(fileInput(projectB, 'concurrent-a.txt', 1, digest(Buffer.from('a'))), user.id),
      addFile(fileInput(projectB, 'concurrent-b.txt', 1, digest(Buffer.from('b'))), user.id),
    ])
    if (concurrent.filter((result) => result.status === 'fulfilled').length !== 1) {
      throw new Error('project file count quota was not atomic under concurrency')
    }
    const rejection = concurrent.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if ((rejection?.reason as { code?: string })?.code !== 'PROJECT_FILE_COUNT_LIMIT') {
      throw new Error('concurrent quota rejection code mismatch')
    }

    process.env.PROJECT_FILE_MAX_COUNT_PER_PROJECT = '10'
    process.env.PROJECT_FILE_MAX_BYTES_PER_PROJECT = '100'
    process.env.PROJECT_FILE_MAX_BYTES_PER_USER = '100'
    const firstPath = await saveProjectFileRevision(projectA, first.id, firstBytes)
    await setFileStoragePath(first.id, firstPath, user.id)
    const replacementBytes = Buffer.from('replacement')
    const replacementPath = await saveProjectFileRevision(projectA, first.id, replacementBytes)
    await replaceFileContent(
      first.id, replacementPath, `${replacementBytes.length} B`, replacementBytes.length, digest(replacementBytes), user.id,
    ).catch(async (error) => {
      await removeProjectFile(replacementPath).catch(() => {})
      throw error
    })
    const versions = await listFileVersions(first.id)
    if (versions.length !== 2 || versions[0]?.version !== 2 || versions[1]?.version !== 1) {
      throw new Error('immutable file version metadata mismatch')
    }
    const v1 = await getFileVersion(first.id, 1)
    const v2 = await getFileVersion(first.id, 2)
    if (!v1 || !v2 || !(await readStored(v1.storagePath)).equals(firstBytes) || !(await readStored(v2.storagePath)).equals(replacementBytes)) {
      throw new Error('immutable file version byte round-trip mismatch')
    }
    const versionRows = await db.select().from(projectFileVersions).where(eq(projectFileVersions.fileId, first.id))
    if (versionRows.some((row) => !row.sha256 || row.byteSize <= 0)) throw new Error('file version integrity metadata is incomplete')

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'project-content-deduplication', 'project-byte-quota', 'project-count-quota', 'user-byte-quota',
        'concurrent-quota-serialization', 'sha256-and-byte-metadata', 'immutable-version-metadata',
        'immutable-version-byte-roundtrip',
      ],
    }))
  } finally {
    for (const projectId of projectIds) await deleteProject(projectId, user.id).catch(() => {})
    await db.delete(auditLogs).where(eq(auditLogs.userId, user.id)).catch(() => {})
    await db.delete(users).where(inArray(users.id, [user.id])).catch(() => {})
    for (const key of quotaKeys) {
      if (previous[key] == null) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

await main().finally(async () => pool.end())
