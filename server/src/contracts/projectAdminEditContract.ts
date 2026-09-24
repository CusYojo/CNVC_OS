import { isSystemAdminRole } from './adminRoleContract.js'

export const ADMIN_EDITABLE_PROJECT_STAGES = [
  '入库', '立项', '尽调计划制定', '尽调计划审核', '尽调', '内核', '投决', '打款', '已 Close',
  '线索', '初筛', '上会', '投后', '退出', '放弃',
] as const

export type AdminEditableProjectStage = typeof ADMIN_EDITABLE_PROJECT_STAGES[number]
export type ProjectWorkflowModel = 'legacy' | 'fde-v1'

const FDE_ADMIN_EDITABLE_PROJECT_STAGES = [
  '入库', '立项', '尽调计划制定', '尽调计划审核', '尽调', '内核', '投决', '打款', '投后', '已 Close', '放弃',
] as const satisfies readonly AdminEditableProjectStage[]

const LEGACY_ADMIN_EDITABLE_PROJECT_STAGES = [
  '线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出', '放弃',
] as const satisfies readonly AdminEditableProjectStage[]

const FDE_PROJECT_STAGE_PROGRESS: Partial<Record<AdminEditableProjectStage, number>> = {
  入库: 0,
  立项: 10,
  尽调计划制定: 18,
  尽调计划审核: 22,
  尽调: 58,
  内核: 75,
  投决: 90,
  打款: 100,
  '已 Close': 100,
  投后: 100,
}

export function canAdministrativelyEditProject(role: string) {
  return isSystemAdminRole(role)
}

export function adminEditableStagesForWorkflow(workflowModel: ProjectWorkflowModel) {
  return workflowModel === 'fde-v1' ? FDE_ADMIN_EDITABLE_PROJECT_STAGES : LEGACY_ADMIN_EDITABLE_PROJECT_STAGES
}

export function isAdminEditableStageForWorkflow(workflowModel: ProjectWorkflowModel, stage: AdminEditableProjectStage) {
  return (adminEditableStagesForWorkflow(workflowModel) as readonly AdminEditableProjectStage[]).includes(stage)
}

export function projectProgressForStage(
  stage: AdminEditableProjectStage,
  workflowModel: ProjectWorkflowModel,
  currentProgress: number,
) {
  if (stage === '放弃') return currentProgress
  if (workflowModel === 'fde-v1') return FDE_PROJECT_STAGE_PROGRESS[stage] ?? currentProgress
  const index = LEGACY_ADMIN_EDITABLE_PROJECT_STAGES.indexOf(stage as typeof LEGACY_ADMIN_EDITABLE_PROJECT_STAGES[number])
  return index >= 0 ? Math.min(100, (index + 1) * 13) : currentProgress
}
