// The service applies this closure before creating the next node's notices in
// the same transaction. Todos are request-bound; future nodes have no todos yet.
// This selects cleanup scope only, never authorization or node advancement.
export function replanApprovalTodoClosure(input: { requestStatus: string; nodeCompleted: boolean; actorId: string; approverUserIds: string[] }):
  { scope: 'request' } | { scope: 'owners'; ownerIds: string[] } {
  if (input.requestStatus !== '审批中') return { scope: 'request' }
  if (!input.approverUserIds.length || !input.approverUserIds.includes(input.actorId)) throw new Error('REPLAN_TODO_NODE_INVALID')
  return { scope: 'owners', ownerIds: input.nodeCompleted ? [...new Set(input.approverUserIds)] : [input.actorId] }
}
