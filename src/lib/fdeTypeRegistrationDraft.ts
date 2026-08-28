import { z } from 'zod'
import { typeRegistrationOptions } from '../../server/src/contracts/fdeTypeRegistrationContract'

type Options = z.infer<typeof typeRegistrationOptions>
export interface RegistrationDraft {
  open: boolean; selected: string; name: string; targetDate: string; cycleDays: number; reason: string; ack: boolean
}
export interface RegistrationDraftState {
  uid: string; generation: number; phase: 'checking' | 'ready' | 'blocked'
  options: Options | null; draft: RegistrationDraft; error: string
}
export const emptyRegistrationDraft = (): RegistrationDraft => ({ open: false, selected: '', name: '', targetDate: '', cycleDays: 0, reason: '', ack: false })
export const initialRegistrationDraft = (uid: string): RegistrationDraftState => ({ uid, generation: 0, phase: 'checking', options: null, draft: emptyRegistrationDraft(), error: '' })
export const invalidateRegistrationDraft = (state: RegistrationDraftState): RegistrationDraftState => ({ ...initialRegistrationDraft(state.uid), generation: state.generation + 1 })
export const beginRegistrationRecheck = (state: RegistrationDraftState): RegistrationDraftState => ({ ...state, generation: state.generation + 1, phase: 'checking', error: '' })
export function editRegistrationDraft(state: RegistrationDraftState, patch: Partial<RegistrationDraft>): RegistrationDraftState {
  return state.phase === 'ready' ? { ...state, draft: { ...state.draft, ...patch } } : state
}
export function settleRegistrationRecheck(state: RegistrationDraftState, generation: number, result: { actorId: string; options: Options } | { error: string }): RegistrationDraftState {
  // A delayed response must not unlock a newer recheck or restore discarded data.
  if (generation !== state.generation || state.phase !== 'checking') return state
  const discard = (error: string): RegistrationDraftState => ({ ...state, phase: 'blocked', options: null, draft: emptyRegistrationDraft(), error })
  if ('error' in result) return discard(`登记权限与规则核对失败，未提交草稿已清理，登记已锁定：${result.error}`)
  if (!state.uid || result.actorId !== state.uid) return discard('当前登录账号已变化或失效，未提交草稿已清理；请刷新页面确认账号后重新登记。')
  const old = state.options?.policies.find(p => p.policyId === state.draft.selected)
  const fresh = result.options.policies.find(p => p.policyId === state.draft.selected)
  if (state.draft.selected && (!old || !fresh)) return { ...state, phase: 'ready', options: result.options, draft: emptyRegistrationDraft(), error: '原模板已停用或当前账号不再有登记权限，未提交草稿已清理；请重新选择获准模板。' }
  if (old && fresh && (old.versionId !== fresh.versionId || old.policyVersion !== fresh.policyVersion || old.sha256 !== fresh.sha256 || JSON.stringify(old.configuration) !== JSON.stringify(fresh.configuration))) {
    return { ...state, phase: 'ready', options: result.options, draft: emptyRegistrationDraft(), error: '登记规则或精确版本已变化，未提交草稿已清理；请重新选择并确认当前版本，不会沿用旧版本提交。' }
  }
  if (!result.options.policies.length) return { ...state, phase: 'ready', options: result.options, draft: emptyRegistrationDraft(), error: state.draft.open ? '当前账号暂无可登记模板，未提交草稿已清理。' : '' }
  return { ...state, phase: 'ready', options: result.options, error: '' }
}

const session = z.object({ user: z.object({ id: z.string().min(1) }).nullable() })
export async function readRegistrationRecheck(uid: string, read: (path: string) => Promise<unknown>): Promise<{ actorId: string; options: Options }> {
  const before = session.parse(await read('/auth/me')).user?.id ?? ''
  if (!uid || before !== uid) return { actorId: before, options: { policies: [] } }
  const options = typeRegistrationOptions.parse(await read('/fde-type-registration/options'))
  // Fence a session switch while the separate, server-authorized options request runs.
  const after = session.parse(await read('/auth/me')).user?.id ?? ''
  return { actorId: after, options: after === before ? options : { policies: [] } }
}
