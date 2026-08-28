import type { ProjectFile } from '../types'
import { shanghaiToday } from '../../server/src/contracts/fdeWeeklyPlanContract'

export const projectDetailTabs = [
  { id: 'workflow', label: '流程推进' },
  { id: 'files', label: '材料文件' },
  { id: 'tasks', label: '项目待办' },
  { id: 'collaboration', label: '协作互动' },
] as const

export function projectDetailTab(value: string | null): string {
  if (value === 'meetings') return 'collaboration'
  return projectDetailTabs.some(tab => tab.id === value) ? value! : 'workflow'
}

export function shortProjectDate(value?: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(5).replace('-', '.') : '未设置'
}

export function projectCountdown(value?: string | null, today = shanghaiToday()): string {
  if (!value) return '尚未设置目标日'
  const days = Math.round((Date.parse(`${value}T00:00:00+08:00`) - Date.parse(`${today}T00:00:00+08:00`)) / 86400000)
  if (!Number.isFinite(days)) return '尚未设置目标日'
  return days > 0 ? `距项目目标日 ${days} 天` : days < 0 ? `已超目标日 ${-days} 天` : '今天到达目标日'
}

export function materialIsSatisfied(binding: { waiverReason: string | null; fileId: string | null; fileVersion: number | null } | undefined, files: ProjectFile[]): boolean {
  return Boolean(binding?.waiverReason?.trim() || (binding?.fileId && files.some(file => file.id === binding.fileId && file.version === binding.fileVersion)))
}
