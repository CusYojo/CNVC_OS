import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function source(relativeUrl: string) {
  return readFile(new URL(relativeUrl, import.meta.url), 'utf8')
}

test('project file listing pushes access control into one SQL query and omits document bodies', async () => {
  const [service, fileAccess] = await Promise.all([
    source('../src/services/projectService.ts'),
    source('../src/services/projectFileAccessService.ts'),
  ])
  const start = service.indexOf('export async function listAllFiles')
  const end = service.indexOf('function publicProjectFile', start)
  const implementation = service.slice(start, end)

  assert.match(implementation, /identityRepositories\.users\.findById\(userId\)/)
  assert.match(implementation, /innerJoin\(projects/)
  assert.match(implementation, /projectFileAccessCondition\(userId\)/)
  assert.match(implementation, /\.where\(accessWhere\)/)
  assert.match(fileAccess, /projectAccessCondition\(\{ uid: userId/)
  assert.match(fileAccess, /currentProjectScope\(userId\)/)
  assert.match(fileAccess, /eq\(projectFiles\.lifecycle, 'active'\)/)
  assert.doesNotMatch(implementation, /Promise\.all\(rows\.map/)
  assert.doesNotMatch(service.slice(service.indexOf('const projectFileListColumns'), start), /contentText/)
})

test('project detail loads its own files and never turns a global list failure into zero', async () => {
  const [page, store] = await Promise.all([
    source('../../src/pages/ProjectDetailPage.tsx'),
    source('../../src/store/useAppStore.ts'),
  ])

  assert.match(page, /apiGet<\{ list: ProjectFile\[\] \}>\(`\/projects\/\$\{project\.id\}\/files`\)/)
  assert.match(page, /项目资料加载失败/)
  assert.match(page, /重新加载/)
  assert.match(store, /results\[6\]\.status === 'fulfilled' \? results\[6\]\.value\.list : get\(\)\.files/)
})

test('current approval material access is node-bound, snapshot-bound and view-only', async () => {
  const fileAccess = await source('../src/services/projectFileAccessService.ts')
  const start = fileAccess.indexOf('function currentApprovalMaterialScope')
  const end = fileAccess.indexOf('export function projectFileAccessCondition', start)
  const approvalScope = fileAccess.slice(start, end)
  assert.match(approvalScope, /approval_request\.current_node_id/)
  assert.match(approvalScope, /approval_request\.status='审批中'/)
  assert.match(approvalScope, /JSON_TABLE\(approval_request\.material_snapshot/)
  assert.match(approvalScope, /approver_user_ids/)
  assert.match(approvalScope, /approved_by_user_ids/)
  assert.match(fileAccess, /operation === 'view' \? currentApprovalMaterialScope\(userId\) : undefined/)
})
