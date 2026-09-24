import { isSystemAdminRole } from './adminRoleContract.js'

export const ADMIN_EDITABLE_PROJECT_STAGES = [
  '入库', '立项', '尽调计划制定', '尽调计划审核', '尽调', '内核', '投决', '打款', '已 Close',
  '线索', '初筛', '上会', '投后', '退出', '放弃',
] as const

export type AdminEditableProjectStage = typeof ADMIN_EDITABLE_PROJECT_STAGES[number]

const PROJECT_STAGE_PROGRESS: Record<AdminEditableProjectStage, number> = {
  入库: 0,
  线索: 0,
  初筛: 5,
  立项: 10,
  尽调计划制定: 20,
  尽调计划审核: 30,
  尽调: 50,
  内核: 60,
  上会: 65,
  投决: 75,
  打款: 90,
  '已 Close': 100,
  投后: 100,
  退出: 100,
  放弃: 100,
}

export function canAdministrativelyEditProject(role: string) {
  return isSystemAdminRole(role)
}

export function projectProgressForStage(stage: AdminEditableProjectStage) {
  return PROJECT_STAGE_PROGRESS[stage]
}
