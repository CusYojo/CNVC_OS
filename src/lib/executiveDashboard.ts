// This display mode never grants access: every read still uses the existing authenticated APIs.
export const EXECUTIVE_DASHBOARD_PATH = '/projects/boss-dashboard'
export const executiveViews = [
  { id: 'overview', label: '今日总览' },
  { id: 'personal', label: '我的日程' },
  { id: 'projects', label: '项目进展' },
  { id: 'directives', label: '我的督办' },
  { id: 'risks', label: '风险预警' },
  { id: 'team', label: '团队动态' },
] as const
export type ExecutiveView = typeof executiveViews[number]['id']

// Previously shared section links remain valid after moving to focused views.
export function executiveViewFromLocation(search: string, hash = ''): ExecutiveView {
  const requested = new URLSearchParams(search).get('view') || hash.slice(1)
  return executiveViews.find(view => view.id === requested)?.id ?? 'overview'
}

export function isExecutiveRole(role?: string) {
  return ['董事长', '总裁', '合伙人'].includes(role ?? '')
}
