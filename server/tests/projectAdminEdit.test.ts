import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  ADMIN_EDITABLE_PROJECT_STAGES,
  canAdministrativelyEditProject,
  projectProgressForStage,
} from '../src/contracts/projectAdminEditContract.js'

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('only system administrators can directly edit project stage and owner', () => {
  assert.equal(canAdministrativelyEditProject('系统管理员'), true)
  assert.equal(canAdministrativelyEditProject('投资经理'), false)
  assert.equal(canAdministrativelyEditProject('董事长'), false)
})

test('administrator stage editing uses the canonical stage list and progress mapping', () => {
  assert.deepEqual(ADMIN_EDITABLE_PROJECT_STAGES, [
    '入库', '立项', '尽调计划制定', '尽调计划审核', '尽调', '内核', '投决', '打款', '已 Close',
    '线索', '初筛', '上会', '投后', '退出', '放弃',
  ])
  assert.equal(projectProgressForStage('入库'), 0)
  assert.equal(projectProgressForStage('尽调'), 50)
  assert.equal(projectProgressForStage('投后'), 100)
  assert.equal(projectProgressForStage('放弃'), 100)
})

test('project edit interfaces expose stage and owner controls only to administrators', async () => {
  const [listPage, detailPage] = await Promise.all([
    read('src/pages/ProjectsPage.tsx'),
    read('src/pages/ProjectDetailPage.tsx'),
  ])
  for (const source of [listPage, detailPage]) {
    assert.match(source, /canAdministrativelyEditProject\(currentUser\.role\)/)
    assert.match(source, /项目阶段/)
    assert.match(source, /项目负责人/)
    assert.match(source, /ownerUserId/)
    assert.match(source, /ADMIN_EDITABLE_PROJECT_STAGES\.map/)
  }
  assert.doesNotMatch(detailPage, /项目阶段在此不可编辑/)
})

test('project patch route and service keep administrator edits authorized and atomic', async () => {
  const [route, service] = await Promise.all([
    read('server/src/routes/projects.ts'),
    read('server/src/services/projectService.ts'),
  ])
  assert.match(route, /AdminProjectPatchSchema/)
  assert.match(route, /canAdministrativelyEditProject\(req\.user!\.role\)/)
  assert.match(route, /updateProjectAsAdministrator/)
  assert.match(service, /export async function updateProjectAsAdministrator/)
  assert.match(service, /stageSource: '管理员修正'/)
  assert.match(service, /projectMembers/)
  assert.match(service, /governanceVersion/)
})
