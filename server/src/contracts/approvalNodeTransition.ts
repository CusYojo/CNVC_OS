/** Shared deterministic node engine. Business handlers own authorization, locks,
 * evidence checks and the final domain consequence; this never grants authority. */
export function approveNodeTransition(input: { mode: string; approverUserIds: string[]; approvedByUserIds: string[]; actorId: string; override?: boolean }) {
  if (!['或签', '会签'].includes(input.mode) || !input.approverUserIds.length) throw new Error('OA_NODE_CONFIGURATION_INVALID')
  if (!input.override && !input.approverUserIds.includes(input.actorId)) throw new Error('OA_NODE_ACTOR_INVALID')
  if (!input.override && input.approvedByUserIds.includes(input.actorId)) throw new Error('OA_ALREADY_APPROVED')
  const approvedIds = [...new Set([...input.approvedByUserIds, input.actorId])]
  const completed = Boolean(input.override) || input.mode === '或签' || input.approverUserIds.every(id => approvedIds.includes(id))
  return { approvedIds, completed, remainingIds: completed ? [] : input.approverUserIds.filter(id => !approvedIds.includes(id)) }
}
