import type { ExecutiveView } from './executiveDashboard'

export const executiveScreens = [
  { id: 'overview', label: '今日要务' },
  { id: 'projects', label: '项目进展' },
  { id: 'directives', label: '我的督办' },
  { id: 'risks', label: '风险预警' },
  { id: 'team', label: '团队动态' },
  { id: 'personal', label: '个人安排' },
] as const
export const executiveScreenOrder: readonly ExecutiveView[] = executiveScreens.map(screen => screen.id)

export function executiveScreenAtPosition(scrollLeft: number, width: number, gap: number, order: readonly ExecutiveView[] = executiveScreenOrder): ExecutiveView {
  return order[Math.round(executiveScreenProgress(scrollLeft, width, gap, order.length))] ?? 'overview'
}

export function executiveScreenProgress(scrollLeft: number, width: number, gap: number, count: number = executiveScreens.length) {
  if (width <= 0 || !Number.isFinite(width + gap) || width + gap <= 0 || !Number.isFinite(scrollLeft)) return 0
  return Math.max(0, Math.min(count - 1, scrollLeft / (width + gap)))
}

type NavigationBounds = { left: number; top: number; width: number; height: number }

// Interpolate measured buttons, including when navigation wraps on a tablet.
export function executiveNavigationLens(progress: number, bounds: readonly NavigationBounds[], reducedMotion = false): NavigationBounds | null {
  if (!bounds.length) return null
  const position = Math.max(0, Math.min(bounds.length - 1, Number.isFinite(progress) ? progress : 0))
  if (reducedMotion || Number.isInteger(position)) return { ...bounds[Math.round(position)] }
  const from = bounds[Math.floor(position)], to = bounds[Math.ceil(position)], fraction = position % 1
  const width = from.width + (to.width - from.width) * fraction
  const stretch = Math.sin(Math.PI * fraction) * Math.min(12, width * .08)
  return {
    left: from.left + (to.left - from.left) * fraction - stretch / 2,
    top: from.top + (to.top - from.top) * fraction,
    width: width + stretch,
    height: from.height + (to.height - from.height) * fraction,
  }
}

export function executiveScreenScrollLeft(id: ExecutiveView, width: number, gap: number, order: readonly ExecutiveView[] = executiveScreenOrder) {
  const index = order.indexOf(id)
  if (index < 0) return null
  if (width <= 0) return 0
  return index * (width + gap)
}

export function executiveVisibleRows<T>(rows: readonly T[], expanded: boolean): T[] {
  return rows.slice(0, expanded ? rows.length : 6)
}
