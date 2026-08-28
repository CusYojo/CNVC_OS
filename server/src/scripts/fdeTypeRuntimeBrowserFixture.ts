import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { fdeWorkflowPolicies, projectDutyAssignments, projectMembers, projectFiles, projectFileVersions, projects } from '../db/schema.js'
import { executeTypePolicy, getTypePolicy, listTypePolicies } from '../services/fdeTypePolicyService.js'
import { saveProjectFile } from '../services/projectFileStorageService.js'
import { typePolicyFixture } from './fdeTypePolicyFixture.js'

export async function seedTypeRuntimeBrowser(owner: { id: string; name: string }, secretary: { id: string; name: string }, leader: { id: string; name: string }, adminId: string) {
  assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
  assert.equal(process.env.FDE_ACCEPTANCE_PREFIX, process.env.DB_FREFIX)
  const configuration = typePolicyFixture()
  configuration.planApprovals = [{ duty: 'concerned_leader', name: '领导独立审核计划', mode: '会签' }]
  configuration.actions[0].needLeader = true; configuration.actions[1].needLeader = false
  const old = (await listTypePolicies(adminId)).policies.find(p => p.code === 'noninvestment:fundraising')
  const created = await executeTypePolicy(adminId, { action: 'create', commandId: randomUUID(), expectedPolicyVersion: old?.version ?? 0, configuration, reason: '仅隔离浏览器合成模板' })
  const approved = await executeTypePolicy(leader.id, { action: 'approve', commandId: randomUUID(), policyId: created.policyId, versionId: created.versionId, expectedVersion: created.version, reason: '隔离独立复核模板规则' })
  await executeTypePolicy(adminId, { action: 'publish', commandId: randomUUID(), policyId: created.policyId, versionId: created.versionId, expectedVersion: approved.version, expectedPolicyVersion: approved.policyVersion, reason: '隔离发布模板验证交互' })
  // Synthetic policy only, never a formal activation entry point.
  await db.update(fdeWorkflowPolicies).set({ enabled: true }).where(eq(fdeWorkflowPolicies.id, created.policyId))
  const projectId = randomUUID()
  await db.insert(projects).values({ id: projectId, name: '非投资执行真实页面验收', owner: owner.name, ownerUserId: owner.id, createdBy: owner.id, workflowModel: 'fde-v1', projectType: '基金募资项目', workflowPolicyVersionId: created.versionId, stage: configuration.stages[0].name, classification: 'normal', lifecycle: 'active', targetDate: '2026-10-30', cycleDays: 50 })
  await db.insert(projectMembers).values([owner, secretary, leader].map(p => ({ projectId, userId: p.id, memberRole: p.id === owner.id ? 'owner' : 'member', sourceName: p.name })))
  await db.insert(projectDutyAssignments).values([{ projectId, userId: secretary.id, duty: 'secretary', assignedBy: owner.id }, { projectId, userId: leader.id, duty: 'concerned_leader', assignedBy: owner.id }])
  const fileId = randomUUID(), bytes = Buffer.from('非投资页面验收真实成果原件。'), sha256 = createHash('sha256').update(bytes).digest('hex'), storagePath = await saveProjectFile(projectId, fileId, bytes)
  await db.insert(projectFiles).values({ id: fileId, projectId, name: '非投资验收成果.txt', type: 'TXT', category: '项目资料', uploader: secretary.name, uploadedBy: secretary.id, storagePath, byteSize: bytes.length, sha256 })
  await db.insert(projectFileVersions).values({ fileId, version: 1, storagePath, byteSize: bytes.length, sha256, createdBy: secretary.id })
  const version = (await getTypePolicy(adminId, created.policyId)).versions.find(v => v.id === created.versionId)!
  return { projectId, fileId, policyVersionId: version.id }
}
