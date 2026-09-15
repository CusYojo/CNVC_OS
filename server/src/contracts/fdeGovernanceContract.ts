export const FDE_ROLE_CATEGORIES = [
  { code: 'institution_leader', label: '机构领导' },
  { code: 'project_lead', label: '项目负责人' },
  { code: 'secretary', label: '推进秘书' },
  { code: 'member', label: '项目成员' },
  { code: 'coordinator', label: '时间协调人' },
  { code: 'specialist', label: '财务/法务/风控' },
  { code: 'system_admin', label: '系统管理员' },
] as const
export type FdeRoleCategory = typeof FDE_ROLE_CATEGORIES[number]['code']
export const FDE_PROJECT_DUTIES = [
  { code: 'secretary', label: '推进秘书', eligible: ['secretary', 'project_lead', 'member'] },
  { code: 'member', label: '项目成员', eligible: ['institution_leader', 'project_lead', 'secretary', 'member', 'specialist'] },
  { code: 'coordinator', label: '时间协调人', eligible: ['coordinator', 'secretary'] },
  { code: 'finance', label: '财务复核', eligible: ['specialist'] },
  { code: 'legal', label: '法务/风控复核', eligible: ['specialist'] },
  { code: 'concerned_leader', label: '关注领导', eligible: ['institution_leader'] },
  { code: 'executive_lead', label: '牵头领导', eligible: ['institution_leader'] },
  { code: 'chairman', label: '董事长审批职责', eligible: ['institution_leader'] },
  { code: 'president', label: '总裁/计划审核职责', eligible: ['institution_leader'] },
] as const
export type FdeProjectDuty = typeof FDE_PROJECT_DUTIES[number]['code']
// `boss` is a workflow-only alias for the project's chairman and president.
// It must never be persisted in project_duty_assignments.
export type FdeApprovalDuty = FdeProjectDuty | 'boss'
export type FdeDutyAssignment = { duty: FdeProjectDuty; userId: string }
export const FDE_LEADERSHIP_DUTIES: readonly FdeProjectDuty[] = ['concerned_leader', 'executive_lead', 'chairman', 'president']
