import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function verifyProjectSkillConsumer(input: { projectId: string; capabilityId: string; versionId: string; candidateId: string }) {
  const { pool } = await import('../../src/db/client.js')
  const { freezeTaskAiEvolutionSkills, validateExistingTaskSkillSnapshot, readExistingTaskSkillSnapshot } = await import('../../src/services/aiEvolutionSkillTaskService.js')
  const { loadEvolutionSkill } = await import('../../src/services/aiEvolutionLoadedSkill.js')
  const userId = randomUUID(), taskId = randomUUID(), retryTaskId = randomUUID(), otherProjectId = randomUUID()
  const additionalTasks: string[] = [], additionalCapabilities: string[] = []
  try {
    await pool.query('INSERT INTO evo_test_users (id,email,name,role,password_hash) VALUES (?,?,?,?,?)',
      [userId, `${userId}@example.invalid`, 'project consumer', '投资经理', 'no-login-password'])
    await pool.query('INSERT INTO evo_test_project_members (project_id,user_id,member_role,source_name) VALUES (?,?,?,?)',
      [input.projectId, userId, 'member', 'fixture'])
    await pool.query('INSERT INTO evo_test_ai_tasks (id,user_id,project_id,type,template_version,idempotency_key) VALUES (?,?,?,?,?,?)',
      [taskId, userId, input.projectId, 'due_diligence_report', 'fixture', randomUUID()])
    const expected = { taskType: 'due_diligence_report', projectId: input.projectId, capabilityId: input.capabilityId }
    assert.equal(await validateExistingTaskSkillSnapshot(userId, taskId, expected), false)
    const frozen = await freezeTaskAiEvolutionSkills(userId, taskId, [input.capabilityId])
    assert.equal(await validateExistingTaskSkillSnapshot(userId, taskId, expected), true)
    assert.equal(frozen?.packages[0].versionId, input.versionId)
    const { getAiEvolutionCandidateForUser } = await import('../../src/services/aiEvolutionApplicationService.js')
    await assert.rejects(getAiEvolutionCandidateForUser(userId, input.candidateId), { code: 'EVOLUTION_NOT_FOUND' })
    await pool.query('DELETE FROM evo_test_project_members WHERE project_id=? AND user_id=?', [input.projectId, userId])
    await assert.rejects(freezeTaskAiEvolutionSkills(userId, taskId, [input.capabilityId]), { code: 'EVOLUTION_SCOPE_FORBIDDEN' })
    await pool.query('INSERT INTO evo_test_project_members (project_id,user_id,member_role,source_name) VALUES (?,?,?,?)',
      [input.projectId, userId, 'member', 'fixture'])
    const resumed = await freezeTaskAiEvolutionSkills(userId, taskId, [input.capabilityId])
    assert.equal(resumed?.snapshotHash, frozen?.snapshotHash)
    await pool.query('UPDATE evo_test_ai_capabilities SET tool_names=? WHERE id=?', [JSON.stringify(['new-tool']), input.capabilityId])
    try {
      await assert.rejects(freezeTaskAiEvolutionSkills(userId, taskId, [input.capabilityId]), { code: 'EVOLUTION_SKILL_PERMISSIONS_CHANGED' })
      await assert.rejects(validateExistingTaskSkillSnapshot(userId, taskId, expected), { code: 'EVOLUTION_SKILL_PERMISSIONS_CHANGED' })
    } finally {
      await pool.query('UPDATE evo_test_ai_capabilities SET tool_names=? WHERE id=?', ['[]', input.capabilityId])
    }
    await pool.query('INSERT INTO evo_test_ai_tasks (id,user_id,project_id,type,template_version,idempotency_key,retry_of_task_id) VALUES (?,?,?,?,?,?,?)',
      [retryTaskId, userId, input.projectId, 'due_diligence_report', 'fixture', randomUUID(), taskId])
    const retried = await freezeTaskAiEvolutionSkills(userId, retryTaskId, [input.capabilityId])
    assert.equal(retried?.snapshotHash, frozen?.snapshotHash)
    assert.equal(retried?.packages[0].versionId, input.versionId)
    await pool.query('INSERT INTO evo_test_projects (id,name,owner,owner_user_id,created_by) VALUES (?,?,?,?,?)',
      [otherProjectId, 'other isolated project', 'project consumer', userId, userId])
    await pool.query('UPDATE evo_test_ai_tasks SET project_id=? WHERE id=?', [otherProjectId, taskId])
    try {
      await assert.rejects(freezeTaskAiEvolutionSkills(userId, taskId, [input.capabilityId]), { code: 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT' })
    } finally {
      await pool.query('UPDATE evo_test_ai_tasks SET project_id=? WHERE id=?', [input.projectId, taskId])
    }
    const restoredContext = await freezeTaskAiEvolutionSkills(userId, taskId, [input.capabilityId])
    assert.equal(restoredContext?.snapshotHash, frozen?.snapshotHash)
    for (const [taskType, skillName] of [
      ['compliance_statement', 'generate-investment-compliance-note'],
      ['custom_template_document', 'generate-document-from-template'],
    ]) {
      const capabilityId = randomUUID(), originalId = randomUUID(), retryId = randomUUID()
      additionalCapabilities.push(capabilityId); additionalTasks.push(originalId, retryId)
      await pool.query('INSERT INTO evo_test_ai_capabilities (id,kind,capability_key,name,config,tool_names,dependency_names,allowed_roles) VALUES (?,?,?,?,?,?,?,?)',
        [capabilityId, 'skill', skillName, 'isolated report baseline', '{}', '[]', '[]', '[]'])
      await pool.query('INSERT INTO evo_test_ai_tasks (id,user_id,project_id,type,template_version,idempotency_key) VALUES (?,?,?,?,?,?)',
        [originalId, userId, input.projectId, taskType, 'fixture', randomUUID()])
      const context = { taskType, projectId: input.projectId, capabilityId }
      assert.equal(await readExistingTaskSkillSnapshot(userId, originalId, context), false)
      const application = await freezeTaskAiEvolutionSkills(userId, originalId, [capabilityId])
      const readBack = await readExistingTaskSkillSnapshot(userId, originalId, context)
      assert.ok(readBack)
      assert.equal(loadEvolutionSkill(readBack.bundle, skillName).name, skillName)
      await pool.query('INSERT INTO evo_test_ai_tasks (id,user_id,project_id,type,template_version,idempotency_key,retry_of_task_id) VALUES (?,?,?,?,?,?,?)',
        [retryId, userId, input.projectId, taskType, 'fixture', randomUUID(), originalId])
      const retry = await freezeTaskAiEvolutionSkills(userId, retryId, [capabilityId])
      assert.equal(retry?.snapshotHash, application?.snapshotHash)
      assert.equal(retry?.packages[0].bundle.packageHash, readBack.bundle.packageHash)
      await assert.rejects(readExistingTaskSkillSnapshot(userId, originalId, { ...context, taskType: 'project_qa' }), { code: 'EVOLUTION_SCOPE_FORBIDDEN' })
    }
    console.log('PASS actual compliance and uploaded-template baseline snapshots persist and survive retry')
    console.log('PASS real project member task freezes shared version and rejects revoked membership')
  } finally {
    await pool.query('DELETE FROM evo_test_ai_evolution_skill_applications WHERE owner_user_id=?', [userId])
    for (const id of additionalTasks.reverse()) await pool.query('DELETE FROM evo_test_ai_tasks WHERE id=?', [id])
    for (const id of additionalCapabilities) await pool.query('DELETE FROM evo_test_ai_capabilities WHERE id=?', [id])
    await pool.query('DELETE FROM evo_test_ai_tasks WHERE id=?', [taskId])
    await pool.query('DELETE FROM evo_test_ai_tasks WHERE id=?', [retryTaskId])
    await pool.query('DELETE FROM evo_test_projects WHERE id=?', [otherProjectId])
    await pool.query('DELETE FROM evo_test_project_members WHERE project_id=? AND user_id=?', [input.projectId, userId])
    await pool.query('DELETE FROM evo_test_users WHERE id=?', [userId])
  }
}
