import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyKnowledgeCommands as commands, companyKnowledgeEvents as events, users } from '../db/schema.js'
import { knowledgeCommandTarget, knowledgeReceipt, type KnowledgeCommandTarget, type KnowledgeReceipt } from '../contracts/fdeKnowledgeCommandContract.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import type { FileTx } from './projectFileAccessService.js'

const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }
async function lockCommand(tx: FileTx, userId: string, target: KnowledgeCommandTarget) {
  // Shared account lock keeps disable atomic without exclusive user locks
  // deadlocking when two knowledge authors grant one another access.
  const [actor] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用'))).for('share')
  if (!actor) return fail('KNOWLEDGE_ACTOR_FORBIDDEN', '当前账号不可用', 403)
  await tx.insert(commands).values({ actorId: userId, commandId: target.clientRequestId, entryId: target.id, action: target.action, commentId: target.commentId ?? null })
    .onDuplicateKeyUpdate({ set: { id: sql`${commands.id}` } })
  const [command] = await tx.select().from(commands).where(and(eq(commands.actorId, userId), eq(commands.commandId, target.clientRequestId))).for('update')
  if (command.entryId !== target.id || command.action !== target.action || command.commentId !== (target.commentId ?? null)) return fail('KNOWLEDGE_REQUEST_REUSED', '请求编号已绑定其他知识或动作')
  return { command, actor }
}
function priorReceipt(event: typeof events.$inferSelect, userId: string, target: KnowledgeCommandTarget) {
  const action = ['create', 'edit'].includes(event.action) ? 'save' : event.action === 'withdraw-rating' ? 'rate' : event.action
  if (event.actorId !== userId || event.entryId !== target.id || action !== target.action || (target.action === 'withdraw-comment' && event.snapshot.commentId !== target.commentId)) return fail('KNOWLEDGE_REQUEST_REUSED', '请求编号已用于其他操作；请核对原结果')
  return knowledgeReceipt.parse({ id: event.entryId, version: event.version })
}
async function complete(tx: FileTx, commandId: string, hash: string, receipt: KnowledgeReceipt) {
  await tx.update(commands).set({ commandHash: hash, receipt, completedAt: new Date() }).where(eq(commands.id, commandId))
  return receipt
}
export async function withKnowledgeCommand(raw: KnowledgeCommandTarget, userId: string, hash: string, work: (tx: FileTx) => Promise<KnowledgeReceipt>) {
  const target = knowledgeCommandTarget.parse(raw)
  return db.transaction(async tx => {
    const { command } = await lockCommand(tx, userId, target)
    if (command.closedAt) return fail('KNOWLEDGE_COMMAND_CLOSED', '旧知识请求已封闭，请读取当前版本后重新确认')
    if (command.receipt) {
      if (command.commandHash !== hash) return fail('KNOWLEDGE_REQUEST_REUSED', '请求编号不能用于不同内容')
      return knowledgeReceipt.parse(command.receipt)
    }
    // Preserve existing event hashes and receipts; no rewrite of historical data.
    const [prior] = await tx.select().from(events).where(eq(events.requestId, target.clientRequestId))
    if (prior) {
      const receipt = priorReceipt(prior, userId, target)
      if (prior.requestHash !== hash) return fail('KNOWLEDGE_REQUEST_REUSED', '请求编号不能用于不同内容')
      return complete(tx, command.id, hash, receipt)
    }
    const receipt = knowledgeReceipt.parse(await work(tx))
    if (receipt.id !== target.id) return fail('KNOWLEDGE_RECEIPT_INVALID', '知识回执与原请求不符', 500)
    return complete(tx, command.id, hash, receipt)
  }, { isolationLevel: 'read committed' })
}
export async function resolveKnowledgeCommand(userId: string, raw: unknown) {
  const target = knowledgeCommandTarget.parse(raw)
  return db.transaction(async tx => {
    const { command, actor } = await lockCommand(tx, userId, target)
    if (command.receipt) return { state: 'committed' as const, receipt: knowledgeReceipt.parse(command.receipt) }
    if (!command.closedAt) {
      const [prior] = await tx.select().from(events).where(and(eq(events.requestId, target.clientRequestId), eq(events.actorId, userId)))
      if (prior) return { state: 'committed' as const, receipt: await complete(tx, command.id, prior.requestHash, priorReceipt(prior, userId, target)) }
      await tx.update(commands).set({ closedAt: new Date() }).where(eq(commands.id, command.id))
      await createMySqlIdentityRepositoryContext(tx).audits.append({ userId, userName: actor.name, module: '公司知识', action: '核对未提交并封闭请求', target: `${target.id} / ${target.action} / ${target.clientRequestId}` })
    }
    return { state: 'not_applied' as const }
  }, { isolationLevel: 'read committed' })
}
