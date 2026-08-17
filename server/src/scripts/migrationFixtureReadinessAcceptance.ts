import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import JSZip from 'jszip'
import { db, pool } from '../db/client.js'
import { projectFiles, projectFileVersions, projects, users } from '../db/schema.js'
import { decodeAndValidateProjectFile } from '../security/projectFileValidation.js'
import { hashPassword } from '../services/authService.js'
import { getAccessibleProject } from '../services/projectAccessService.js'

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[migration fixture readiness] ${message}`)
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

async function ooxml(entry: string) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file(entry, '<root/>')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/migration-fixture-readiness')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryPath, [
    '# 迁移前置测试夹具就绪验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    '- 五类角色、两个部门和两个互相隔离项目在真实 MySQL 中创建、核验并清理',
    '- 两个项目均覆盖 PDF、DOCX、XLSX、PPTX、图片和文本六类安全合成资料',
    '- 重复、多主体、弱来源、冲突来源、无效主体及五类成功/失败模拟条件均有版本化契约',
    '- 夹具使用随机身份、`.invalid` 邮箱、随机密码和合成文件，不使用真实业务资料或凭据',
    '',
    '报告只保存数量、类别、契约哈希和零残留结果，不保存文件正文、用户标识、路径或连接身份。',
    '',
  ].join('\n'), { mode: 0o600 })
  await Promise.all([chmod(reportPath, 0o600), chmod(summaryPath, 0o600)])
}

async function main() {
  const marker = randomUUID()
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'migration-fixture-files-'))
  const previousRoot = process.env.PROJECT_FILE_ROOT
  process.env.PROJECT_FILE_ROOT = storageRoot
  const userIds: string[] = []
  const projectIds: string[] = []
  try {
    const roleFixtures = [
      { key: 'system-admin', role: '系统管理员', department: '平台部' },
      { key: 'ai-platform-admin', role: 'AI 平台管理员', department: '平台部' },
      { key: 'operations-admin', role: '平台运营', department: '运营部' },
      { key: 'business-a', role: '投资经理', department: '投资一部' },
      { key: 'business-b', role: '投资经理', department: '投资二部' },
    ]
    const createdUsers: Record<string, { id: string; role: string }> = {}
    for (const fixture of roleFixtures) {
      const [user] = await db.insert(users).values({
        email: `${fixture.key}-${marker}@example.invalid`, name: `迁移夹具-${fixture.key}`,
        role: fixture.role, department: fixture.department, passwordHash: await hashPassword(randomUUID()),
      }).$returningId()
      userIds.push(user.id)
      createdUsers[fixture.key] = { id: user.id, role: fixture.role }
    }
    for (const key of ['business-a', 'business-b']) {
      const owner = createdUsers[key]
      assertContract(owner, `missing fixture owner: ${key}`)
      const [project] = await db.insert(projects).values({
        name: `迁移隔离项目-${key}-${marker}`, owner: `迁移夹具-${key}`, ownerUserId: owner.id,
        collaborators: [], createdBy: owner.id,
      }).$returningId()
      projectIds.push(project.id)
    }
    const [projectA, projectB] = projectIds
    const businessA = createdUsers['business-a']!
    const businessB = createdUsers['business-b']!
    const systemAdmin = createdUsers['system-admin']!
    const aiAdmin = createdUsers['ai-platform-admin']!
    const operationsAdmin = createdUsers['operations-admin']!
    assertContract(await getAccessibleProject(businessA.id, projectA), 'project A owner cannot access own project')
    assertContract(await getAccessibleProject(businessB.id, projectB), 'project B owner cannot access own project')
    assertContract(!await getAccessibleProject(businessA.id, projectB), 'department A user can access isolated project B')
    assertContract(!await getAccessibleProject(businessB.id, projectA), 'department B user can access isolated project A')
    assertContract(await getAccessibleProject(systemAdmin.id, projectA) && await getAccessibleProject(systemAdmin.id, projectB), 'system admin cannot inspect both fixtures')
    assertContract(!await getAccessibleProject(aiAdmin.id, projectA), 'AI platform admin obtained unrelated project access')
    assertContract(!await getAccessibleProject(operationsAdmin.id, projectB), 'operations admin obtained unrelated project access')

    const fixtures = [
      { kind: 'pdf', name: 'sample.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF') },
      { kind: 'docx', name: 'sample.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: await ooxml('word/document.xml') },
      { kind: 'xlsx', name: 'sample.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: await ooxml('xl/workbook.xml') },
      { kind: 'pptx', name: 'sample.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: await ooxml('ppt/presentation.xml') },
      { kind: 'image', name: 'sample.png', mime: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      { kind: 'text', name: 'sample.txt', mime: 'text/plain', bytes: Buffer.from('synthetic migration fixture') },
    ]
    const storage = await import(`../services/projectFileStorageService.js?migration-fixtures=${Date.now()}`)
    for (const [projectIndex, projectId] of projectIds.entries()) {
      const owner = projectIndex === 0 ? businessA : businessB
      for (const fixture of fixtures) {
        const validated = await decodeAndValidateProjectFile({
          name: fixture.name, declaredType: fixture.mime, dataBase64: fixture.bytes.toString('base64'),
        })
        const [file] = await db.insert(projectFiles).values({
          projectId, name: fixture.name, type: fixture.kind.toUpperCase(), category: '迁移验收',
          size: `${validated.byteSize} B`, byteSize: validated.byteSize, sha256: validated.sha256,
          uploader: '迁移安全合成夹具', uploadedBy: owner.id, parseStatus: '解析中', visibility: '项目成员',
        }).$returningId()
        const storagePath = await storage.saveProjectFileRevision(projectId, file.id, validated.buffer)
        await db.update(projectFiles).set({ storagePath }).where(eq(projectFiles.id, file.id))
        await db.insert(projectFileVersions).values({
          fileId: file.id, version: 1, byteSize: validated.byteSize, sha256: validated.sha256,
          storagePath, createdBy: owner.id,
        })
        assertContract((await readFile(path.resolve(storageRoot, storagePath))).equals(fixture.bytes), `${fixture.kind} storage round-trip mismatch`)
      }
    }
    const storedFiles = await db.select({ id: projectFiles.id }).from(projectFiles).where(inArray(projectFiles.projectId, projectIds))
    assertContract(storedFiles.length === 12, `expected 12 prepared project files, received ${storedFiles.length}`)

    const subjectGoldText = await readFile(path.resolve('server/assets/lead-subject-gold-v1.json'), 'utf8')
    const workflowGoldText = await readFile(path.resolve('server/assets/lead-workflow-gold-v1.json'), 'utf8')
    const subjectGold = JSON.parse(subjectGoldText) as { cases?: Array<{ category?: string }> }
    const workflowGold = JSON.parse(workflowGoldText) as { cases?: Array<{ category?: string }> }
    assertContract(subjectGold.cases?.some((item) => item.category === 'ambiguous'), 'multi-subject fixture is missing')
    assertContract(subjectGold.cases?.some((item) => item.category === 'noise'), 'invalid-subject fixture is missing')
    assertContract(workflowGold.cases?.some((item) => item.category === 'weak-source-review'), 'weak-source fixture is missing')
    assertContract(workflowGold.cases?.some((item) => item.category === 'conflict'), 'conflicting-source fixture is missing')
    const duplicateSubjects = ['重复主体有限公司', ' 重复主体有限公司 ']
    assertContract(new Set(duplicateSubjects.map((value) => value.normalize('NFKC').trim().toLocaleLowerCase())).size === 1, 'duplicate-subject fixture is invalid')

    const failureSources = await Promise.all([
      readFile(path.resolve('server/src/scripts/leadSubjectAgentAcceptance.ts'), 'utf8'),
      readFile(path.resolve('server/src/scripts/leadAgentRuntimeGuardAcceptance.ts'), 'utf8'),
      readFile(path.resolve('server/src/scripts/aiTaskLifecycleAcceptance.ts'), 'utf8'),
      readFile(path.resolve('server/src/scripts/jwRestartRecoveryAcceptance.ts'), 'utf8'),
    ])
    const [agentAcceptance, runtimeGuard, taskLifecycle, restartRecovery] = failureSources
    assertContract(/queryFactory/.test(agentAcceptance), 'success model fixture is missing')
    assertContract(/attempted forbidden tool: Bash/.test(agentAcceptance), 'tool failure fixture is missing')
    assertContract(/failingFactory/.test(agentAcceptance) && /throwingFactory/.test(agentAcceptance), 'model failure fixtures are missing')
    assertContract(/cross-profile-minute-rate-is-persistently-limited/.test(runtimeGuard), 'rate-limit fixture is missing')
    assertContract(/gateway timeout/.test(taskLifecycle) && /MODEL_TIMEOUT/.test(taskLifecycle), 'timeout classification fixture is missing')
    assertContract(/controller\.abort\(\)/.test(restartRecovery), 'abort/timeout fixture is missing')

    const fixtureContract = {
      roles: roleFixtures.map((item) => item.role),
      departments: ['投资一部', '投资二部'],
      projectFileKinds: fixtures.map((item) => item.kind),
      leadConditions: ['duplicate', 'multi-subject', 'weak-source', 'conflicting-source', 'invalid-subject'],
      executionConditions: ['success', 'timeout', 'rate-limit', 'tool-failure', 'model-failure'],
      goldHashes: [sha256(subjectGoldText), sha256(workflowGoldText)],
      failureSourceHashes: failureSources.map((source) => sha256(source)),
    }
    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      fixtureContractSha256: sha256(JSON.stringify(fixtureContract)),
      roles: roleFixtures.length,
      isolatedDepartments: 2,
      isolatedProjects: 2,
      projectFileKinds: fixtures.length,
      storedProjectFiles: storedFiles.length,
      leadConditions: fixtureContract.leadConditions.length,
      executionConditions: fixtureContract.executionConditions.length,
      syntheticOnly: true,
      fixtureCleanupPending: true,
      checks: [
        'five-required-role-fixtures',
        'two-department-two-project-isolation',
        'six-file-kinds-per-project-private-roundtrip',
        'duplicate-multi-weak-conflict-invalid-lead-fixtures',
        'success-timeout-rate-tool-model-execution-fixtures',
        'synthetic-invalid-domain-random-credential-policy',
        'evidence-excludes-content-identities-paths-and-connections',
      ],
    }
    await db.delete(projects).where(inArray(projects.id, projectIds))
    await db.delete(users).where(inArray(users.id, userIds))
    const [remainingFiles, remainingProjects, remainingUsers] = await Promise.all([
      db.select({ id: projectFiles.id }).from(projectFiles).where(inArray(projectFiles.projectId, projectIds)),
      db.select({ id: projects.id }).from(projects).where(inArray(projects.id, projectIds)),
      db.select({ id: users.id }).from(users).where(inArray(users.id, userIds)),
    ])
    assertContract(!remainingFiles.length && !remainingProjects.length && !remainingUsers.length, 'fixture database cleanup is incomplete')
    report.fixtureCleanupPending = false
    await persistEvidence(report)
    console.log(JSON.stringify(report))
  } finally {
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)).catch(() => {})
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds)).catch(() => {})
    if (previousRoot == null) delete process.env.PROJECT_FILE_ROOT
    else process.env.PROJECT_FILE_ROOT = previousRoot
    await rm(storageRoot, { recursive: true, force: true })
  }
}

await main().finally(async () => pool.end())
