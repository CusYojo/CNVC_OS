import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { db } from '../db/client.js'
import { oaApprovalRequests } from '../db/schema.js'
import { addFile, classifyProject, createProject, setFileStoragePath } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { saveProjectFileRevision } from '../services/projectFileStorageService.js'
import { executeCommittee } from '../services/fdeCommitteeService.js'
import { shanghaiToday, shiftDate, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

type Person = { id: string; name: string }
export async function seedCommitteeBrowser(owner: Person, member: Person, other: Person) {
  assertIsolatedMysqlAcceptanceDatabase('fdeCommitteeBrowserFixture')
  assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
  assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
  assert.ok(process.env.PROJECT_FILE_ROOT?.includes('fde-migration-acceptance-'))
  const agendas = []
  for (const [i, person] of [member, other].entries()) {
    let project = await createProject({ name: ['投决甲项目页面验收', '投决乙项目独立权限验收'][i], owner: owner.name, ownerUserId: owner.id, collaborators: [] }, owner.id)
    project = await classifyProject({ projectId: project.id, userId: owner.id, expectedVersion: project.version, toClassification: 'normal', reason: '隔离投决项目完成初筛' })
    await proposeFdeGovernance({ projectId: project.id, userId: owner.id, ownerUserId: owner.id, expectedVersion: project.governanceVersion, reason: '分别指定投决议题项目成员', assignments: [{ duty: 'member', userId: person.id }] })
    const bytes = Buffer.from(`投决${i ? '乙' : '甲'}项目页面验收原件，不包含真实客户数据。`)
    const file = await addFile({ projectId: project.id, name: `投决${i ? '乙' : '甲'}项目原件.txt`, type: 'TXT', category: '项目基础资料', uploader: owner.name, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, owner.id)
    await setFileStoragePath(file.id, await saveProjectFileRevision(project.id, file.id, bytes), owner.id)
    const requestId = randomUUID()
    await db.insert(oaApprovalRequests).values({ id: requestId, requestNo: `IC-${requestId}`, projectId: project.id, projectName: project.name, title: `${project.name}正式审批关联夹具`, type: '投决审批', fromStage: '投决', targetStage: '打款', status: '已通过', applicantUserId: owner.id, applicantName: owner.name, department: '隔离验收', currentNodeName: '已完成', reason: '仅用于页面关联测试，不代表正式业务审批验收', completedAt: new Date(), materialSnapshot: [{ requirementKey: 'fixture', fileId: file.id, fileVersion: 1, waiverReason: null }] })
    agendas.push({ id: randomUUID(), projectId: project.id, title: project.name, participantIds: [person.id], materials: [{ fileId: file.id, version: 1 }] })
  }
  const day = shiftDate(weekStartFor(shanghaiToday()), -7)
  const meeting = await executeCommittee(owner.id, { action: 'create', commandId: randomUUID(), reason: '准备多议题真实页面验收', definition: { title: '多议题投决会页面验收', hostUserId: member.id, startsAt: `${day}T10:00`, endsAt: `${day}T11:30`, materialCheckAt: `${day}T09:00`, ruleNote: '按正式审批矩阵办理，不启用线上逐票表决。', agendas } })
  return { meetingId: meeting.meetingId, agendas, day }
}
