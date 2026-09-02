import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { canDirectlyDeleteProject } from '../src/contracts/adminRoleContract.js'

test('only authorized leaders and system administrators can directly delete projects', () => {
  assert.equal(canDirectlyDeleteProject('董事长', ['project.classify']), true)
  assert.equal(canDirectlyDeleteProject('合伙人', ['project.classify']), true)
  assert.equal(canDirectlyDeleteProject('系统管理员', []), true)
  assert.equal(canDirectlyDeleteProject('投资经理', []), false)
  assert.equal(canDirectlyDeleteProject('项目成员', ['fde.project.read']), false)
})

test('project deletion requires the confirmation contract on both client and server', async () => {
  const [page, route, store] = await Promise.all([
    readFile(new URL('../../src/pages/ProjectsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/projects.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/store/useAppStore.ts', import.meta.url), 'utf8'),
  ])
  assert.match(page, /canDirectlyDeleteProject\(currentUser\.role, currentUser\.permissionCodes\)/)
  assert.match(page, /await deleteProject\(pendingDelete\.id, pendingDelete\.name\)/)
  assert.match(page, /确认删除项目/)
  assert.match(route, /confirmation: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(128\)/)
  assert.match(route, /expectedVersion: z\.number\(\)\.int\(\)\.positive\(\)/)
  assert.match(store, /\{ confirmation, expectedVersion \}/)
})
