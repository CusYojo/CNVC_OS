import { createHash, randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { aiSummaries, auditLogs, fileChunks, knowledgeChunks, projectFiles, projects, users } from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import {
  getProjectSummaryForUser,
  listProjectFilesForUser,
  readProjectFileForUser,
  searchProjectDocsForUser,
} from '../services/projectKnowledgeToolService.js'

async function expectCode(run: () => Promise<unknown>, code: string) {
  const error = await run().then(() => null, (caught: unknown) => caught as Error & { code?: string })
  if (!error || error.code !== code) throw new Error(`expected ${code}, received ${error?.code || error?.message || 'success'}`)
}

async function main() {
  const marker = randomUUID()
  const passwordHash = await hashPassword(randomUUID())
  const [owner] = await db.insert(users).values({
    email: `knowledge-owner-${marker}@example.invalid`, name: '知识工具所有者', role: '投资经理', department: '验收部', passwordHash,
  }).$returningId()
  const [outsider] = await db.insert(users).values({
    email: `knowledge-outsider-${marker}@example.invalid`, name: '知识工具外部用户', role: '投资经理', department: '验收部', passwordHash,
  }).$returningId()
  const userIds = [owner.id, outsider.id]
  const projectIds: string[] = []
  let knowledgeIds: string[] = []
  try {
    const [project] = await db.insert(projects).values({
      name: `知识工具项目-${marker}`, owner: '知识工具所有者', ownerUserId: owner.id, createdBy: owner.id, collaborators: [],
    }).$returningId()
    const [otherProject] = await db.insert(projects).values({
      name: `外部项目-${marker}`, owner: '知识工具外部用户', ownerUserId: outsider.id, createdBy: outsider.id, collaborators: [],
    }).$returningId()
    projectIds.push(project.id, otherProject.id)
    await db.insert(aiSummaries).values({
      projectId: project.id,
      positioning: `项目定位-${marker}`,
      highlights: [`摘要亮点-${marker}`],
      risks: [`摘要风险-${marker}`],
      questions: [`尽调问题-${marker}`],
      missing: [`资料缺口-${marker}`],
      confidence: 87,
      sources: [`摘要来源-${marker}`],
    })
    const payload = Buffer.from(`核心技术证据-${marker}`)
    const [file] = await db.insert(projectFiles).values({
      projectId: project.id, name: `核心技术-${marker}.txt`, type: 'TXT', category: '项目资料',
      size: `${payload.length} B`, byteSize: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'), uploader: '知识工具所有者', uploadedBy: owner.id,
      parseStatus: '成功', visibility: '项目成员', version: 1,
    }).$returningId()
    const [otherFile] = await db.insert(projectFiles).values({
      projectId: otherProject.id, name: `外部资料-${marker}.txt`, type: 'TXT', category: '项目资料',
      size: '1 B', byteSize: 1, sha256: createHash('sha256').update('x').digest('hex'),
      uploader: '知识工具外部用户', uploadedBy: outsider.id, parseStatus: '成功', visibility: '项目成员', version: 1,
    }).$returningId()
    await db.insert(fileChunks).values([
      { fileId: file.id, projectId: project.id, fileName: `核心技术-${marker}.txt`, chunkIndex: 0, content: `核心技术采用可验证架构 ${marker}` },
      { fileId: file.id, projectId: project.id, fileName: `核心技术-${marker}.txt`, chunkIndex: 1, content: `商业进展已有付费客户 ${marker}` },
    ])
    const insertedKnowledge = await db.insert(knowledgeChunks).values([
      { scope: 'project', refId: project.id, sourceType: 'project_file', sourceId: file.id, sourceName: `核心技术-${marker}.txt`, chunkIndex: 0, content: `核心技术采用可验证架构 ${marker}` },
      { scope: 'org', refId: 'org', sourceType: 'policy', sourceId: null, sourceName: '机构标准', chunkIndex: 2, content: `机构核心技术核验标准 ${marker}` },
      { scope: 'lead', refId: `lead-${marker}`, sourceType: 'lead_profile', sourceId: `lead-${marker}`, sourceName: '线索画像', chunkIndex: 3, content: `同类核心技术线索 ${marker}` },
    ]).$returningId()
    knowledgeIds = insertedKnowledge.map((row) => row.id)

    const search = await searchProjectDocsForUser({
      userId: owner.id, projectId: project.id, query: marker, compareLeadPool: true,
    })
    const projectEvidence = search.evidence.find((item) => item.scope === 'project')
    const leadEvidence = search.evidence.find((item) => item.scope === 'lead')
    if (
      !search.permission.granted || search.projectId !== project.id || !search.hasEvidence
      || projectEvidence?.sourceId !== file.id || projectEvidence.chunkIndex !== 0
      || projectEvidence.locator !== '知识片段 1' || !projectEvidence.citationId.startsWith('P')
      || leadEvidence?.refId !== `lead-${marker}` || !search.sources.some((source) => source.sourceId === file.id)
    ) throw new Error(`search_project_docs evidence/source/locator contract mismatch: evidence=${search.evidence.length} sources=${search.sources.length}`)
    await expectCode(
      () => searchProjectDocsForUser({ userId: outsider.id, projectId: project.id, query: '核心技术' }),
      'PROJECT_FORBIDDEN',
    )

    const orgSearch = await searchProjectDocsForUser({ userId: owner.id, projectId: null, query: '核验标准' })
    if (orgSearch.permission.scope !== 'org' || orgSearch.projectId !== null || orgSearch.evidence[0]?.scope !== 'org') {
      throw new Error('organization knowledge scope contract mismatch')
    }
    const summary = await getProjectSummaryForUser({ userId: owner.id, projectId: project.id })
    if (
      !summary.permission.granted || summary.permission.checkedBy !== 'server-stable-identity'
      || summary.projectId !== project.id || summary.project.id !== project.id
      || summary.aiSummary?.positioning !== `项目定位-${marker}` || summary.aiSummary.confidence !== 87
      || summary.activity.files.total !== 1 || summary.activity.files.parsed !== 1
      || summary.sources[0]?.sourceId !== project.id || summary.sources[0]?.locator !== '项目主记录'
      || !summary.sources.some((source) => source.sourceType === 'project_ai_summary')
    ) throw new Error('get_project_summary project/AI/activity/source contract mismatch')
    await expectCode(() => getProjectSummaryForUser({ userId: outsider.id, projectId: project.id }), 'PROJECT_FORBIDDEN')

    const listed = await listProjectFilesForUser({ userId: owner.id, projectId: project.id })
    if (!listed.permission.granted || listed.files.length !== 1 || listed.files[0]?.id !== file.id || listed.files[0]?.hasOriginal !== false) {
      throw new Error('list_project_files scope/metadata contract mismatch')
    }
    await expectCode(() => listProjectFilesForUser({ userId: outsider.id, projectId: project.id }), 'PROJECT_FORBIDDEN')

    const read = await readProjectFileForUser({ userId: owner.id, projectId: project.id, fileId: file.id, maxChunks: 2 })
    if (
      !read.permission.granted || read.projectId !== project.id || read.file.id !== file.id || read.evidence.length !== 2
      || read.evidence[0]?.locator !== '文件片段 1' || read.evidence[1]?.locator !== '文件片段 2'
      || read.evidence.some((item) => item.projectId !== project.id || item.sourceId !== file.id)
    ) throw new Error('read_project_file content/source/locator contract mismatch')
    await expectCode(
      () => readProjectFileForUser({ userId: outsider.id, projectId: project.id, fileId: file.id }),
      'PROJECT_FORBIDDEN',
    )
    await expectCode(
      () => readProjectFileForUser({ userId: owner.id, projectId: project.id, fileId: otherFile.id }),
      'PROJECT_FILE_NOT_FOUND',
    )

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'search-project-evidence-source-locator', 'search-lead-comparison-source', 'search-project-permission-denial',
        'search-organization-scope', 'get-project-summary-main-record', 'get-project-summary-ai-and-activity',
        'get-project-summary-source-locator', 'get-project-summary-permission-denial',
        'list-project-files-metadata', 'list-project-files-permission-denial',
        'read-project-file-source-locator', 'read-project-file-permission-denial', 'read-cross-project-file-rejection',
      ],
    }))
  } finally {
    if (knowledgeIds.length) await db.delete(knowledgeChunks).where(inArray(knowledgeChunks.id, knowledgeIds)).catch(() => {})
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)).catch(() => {})
    await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds)).catch(() => {})
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {})
  }
}

await main().finally(async () => pool.end())
