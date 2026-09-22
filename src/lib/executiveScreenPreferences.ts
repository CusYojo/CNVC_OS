import type { ExecutiveView } from './executiveDashboard'
import { executiveScreenOrder } from './executiveScreen'

export type ExecutiveScreenPreferences = { version: 1; order: readonly ExecutiveView[]; hidden: readonly ExecutiveView[] }
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

export function defaultExecutiveScreenPreferences(): ExecutiveScreenPreferences {
  return { version: 1, order: [...executiveScreenOrder], hidden: [] }
}

export function normalizeExecutiveScreenPreferences(value: unknown): ExecutiveScreenPreferences {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return defaultExecutiveScreenPreferences()
  const input = value as { order?: unknown; hidden?: unknown }
  const validIds = (list: unknown): ExecutiveView[] => Array.isArray(list)
    ? [...new Set(list.filter((id): id is ExecutiveView => executiveScreenOrder.includes(id)))] : []
  const savedOrder = validIds(input.order)
  const order = [...savedOrder, ...executiveScreenOrder.filter(id => !savedOrder.includes(id))]
  let hidden = validIds(input.hidden)
  if (hidden.length === order.length) hidden = hidden.filter(id => id !== order[0])
  return { version: 1, order, hidden }
}

export function visibleExecutiveScreenIds(preferences: ExecutiveScreenPreferences, temporary?: ExecutiveView | null) {
  return preferences.order.filter(id => !preferences.hidden.includes(id) || id === temporary)
}

export function resolveExecutiveScreen(active: ExecutiveView | undefined, visible: readonly ExecutiveView[]): ExecutiveView {
  return active && visible.includes(active) ? active : visible[0] ?? 'overview'
}

export function moveExecutiveScreen(preferences: ExecutiveScreenPreferences, id: ExecutiveView, direction: -1 | 1): ExecutiveScreenPreferences {
  const index = preferences.order.indexOf(id), next = index + direction
  if (index < 0 || next < 0 || next >= preferences.order.length) return preferences
  const order = [...preferences.order]
  const previous = order[index]
  order[index] = order[next]
  order[next] = previous
  return { ...preferences, order }
}

export function toggleExecutiveScreen(preferences: ExecutiveScreenPreferences, id: ExecutiveView): ExecutiveScreenPreferences {
  if (preferences.hidden.includes(id)) return { ...preferences, hidden: preferences.hidden.filter(item => item !== id) }
  if (visibleExecutiveScreenIds(preferences).length === 1) return preferences
  return { ...preferences, hidden: [...preferences.hidden, id] }
}

export function executiveScreenPreferenceKey(userId: string) { return `fde-executive-screen-preferences:v1:${userId}` }

export function readExecutiveScreenPreferences(userId: string, storage: () => PreferenceStorage = () => window.localStorage): ExecutiveScreenPreferences {
  if (!userId) return defaultExecutiveScreenPreferences()
  try { return normalizeExecutiveScreenPreferences(JSON.parse(storage().getItem(executiveScreenPreferenceKey(userId)) || 'null')) }
  catch { return defaultExecutiveScreenPreferences() }
}

export function saveExecutiveScreenPreferences(userId: string, preferences: ExecutiveScreenPreferences, storage: () => PreferenceStorage = () => window.localStorage) {
  if (!userId) return false
  try { storage().setItem(executiveScreenPreferenceKey(userId), JSON.stringify(normalizeExecutiveScreenPreferences(preferences))); return true }
  catch { return false }
}
