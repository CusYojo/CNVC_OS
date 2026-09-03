export const systemWorkspaces = [
  { id: 'organization', label: '组织与权限', tabs: ['users', 'org', 'roles'] },
  { id: 'rules', label: '模板与规则', tabs: ['workflow-rules', 'type-rules', 'office-rules', 'responsibility-rules', 'templates', 'dicts'] },
  { id: 'integrations', label: '集成与审计', tabs: ['audit'] },
]

export function resolveSystemTab(tab: string | null) {
  if (tab === 'operations' || tab === 'integrations-overview') return 'audit'
  return systemWorkspaces.some((item) => item.tabs.includes(tab ?? 'users')) ? tab ?? 'users' : 'users'
}

export function getSystemWorkspace(tab: string | null) {
  return systemWorkspaces.find((item) => item.tabs.includes(resolveSystemTab(tab))) ?? systemWorkspaces[0]
}
