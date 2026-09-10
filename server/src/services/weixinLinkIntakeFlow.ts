import { randomUUID } from 'node:crypto'
import { weixinArticleUrl, weixinIntakeCommand, WEIXIN_INTAKE_CHOICE, type LinkArticle, type LinkIntakeSession, type LinkIntakeTask, type LinkProjectResult } from '../contracts/weixinLinkIntakeContract.js'

export type LinkIntakeDependencies = {
  save: (session: LinkIntakeSession) => Promise<void>
  fetchArticle: (url: string) => Promise<LinkArticle>
  saveKnowledge: (task: LinkIntakeTask) => Promise<string>
  importProject: (task: LinkIntakeTask) => Promise<LinkProjectResult>
  link: (path: string) => string
  deferProcessing?: (taskId: string) => void
  preparedArticle?: LinkArticle
}

function receipt(task: LinkIntakeTask, deps: LinkIntakeDependencies) {
  const lines = [`《${task.article?.title || '公众号文章'}》`]
  if (task.knowledgeId) lines.push(`知识库已保存：${deps.link(`/knowledge?view=company&entry=${task.knowledgeId}`)}`)
  if (task.project?.status === 'ready' && task.project.leadId) lines.push(`项目池已收录或合并：${deps.link(`/sourcing/${task.project.leadId}`)}`)
  if (task.project?.status === 'review') lines.push('项目暂未入池，已进入线索复核流程。')
  if (task.project?.status === 'rejected') lines.push('项目未通过现有线索池准入规则，未入池。')
  if (task.status === 'failed') lines.push('收录尚未全部完成。回复“重试”继续未完成部分，已成功的部分会保留。')
  if (task.status === 'cancelled') lines.push('已取消后续收录；之前已经保存的内容保留。')
  if (task.status === 'awaiting_choice') lines.push(WEIXIN_INTAKE_CHOICE)
  if (task.status === 'processing') lines.push('上次处理尚未确认完成，回复“重试”恢复处理。')
  return lines.join('\n')
}

/** Called under a per-binding database lock. Persist intent before any business write. */
export async function handleWeixinLinkIntake(
  session: LinkIntakeSession, messageId: string, message: string, deps: LinkIntakeDependencies,
): Promise<string | null> {
  // WeChat may redeliver the same inbound message. The persisted receipt makes
  // processing idempotent; returning no reply also prevents duplicate pushes.
  if (session.receipts[messageId]) return ''
  const url = deps.preparedArticle?.url || weixinArticleUrl(message), command = weixinIntakeCommand(message)
  if (!url && (!session.task || !command)) return null
  const finish = async (reply: string) => {
    session.receipts[messageId] = reply
    await deps.save(session)
    return reply
  }
  if (url) {
    if (session.task?.url === url && session.task.status !== 'cancelled') return finish(receipt(session.task, deps))
    if (session.task && !['completed', 'cancelled'].includes(session.task.status)) {
      return finish('还有一篇文章待处理。请先选择用途、回复“重试”或“取消”，再发送新链接。')
    }
    session.task = {
      id: randomUUID(), initialMessageId: messageId, url,
      status: deps.deferProcessing ? 'awaiting_choice' : 'processing',
      ...(deps.preparedArticle ? { article: deps.preparedArticle } : {}),
    }
    session.receipts = {}
    await deps.save(session)
    if (deps.deferProcessing) return finish(receipt(session.task, deps))
  }
  const task = session.task!
  if (command === 'status') return finish(receipt(task, deps))
  if (command === 'cancel') {
    task.status = 'cancelled'
    return finish(receipt(task, deps))
  }
  if (!url && ['completed', 'cancelled'].includes(task.status)) return finish(receipt(task, deps))
  if (command && ['project', 'knowledge', 'both'].includes(command)) {
    if (task.mode && task.mode !== command) return finish('此任务已开始执行，不能改变用途。请回复“重试”或“收录状态”。')
    task.mode = command as 'project' | 'knowledge' | 'both'
    if (deps.deferProcessing) {
      task.status = 'processing'
      const reply = await finish('选择已记录，正在后台读取并处理文章。完成后我会把入库结果发给你，无需在这里等待。')
      deps.deferProcessing(task.id)
      return reply
    }
  }
  try {
    task.status = 'processing'
    await deps.save(session)
    if (!task.article) {
      task.article = await deps.fetchArticle(task.url)
      if (!task.article.text.trim()) throw new Error('SOURCE_PARSE_EMPTY')
      await deps.save(session)
    }
    if (!task.mode) {
      task.status = 'awaiting_choice'
      return finish(receipt(task, deps))
    }
    if (task.mode !== 'project' && !task.knowledgeId) {
      task.knowledgeId = await deps.saveKnowledge(task)
      await deps.save(session)
    }
    if (task.mode !== 'knowledge' && !task.project) {
      task.project = await deps.importProject(task)
      await deps.save(session)
    }
    task.status = 'completed'
    delete task.error
    return finish(receipt(task, deps))
  } catch (error) {
    task.status = 'failed'
    task.error = String((error as { code?: string }).code || 'INTAKE_FAILED').slice(0, 64)
    const explanation = task.error.includes('FORBIDDEN') ? '\n当前平台账号没有所需知识库权限，请联系管理员核对授权。' : ''
    const reply = task.article ? receipt(task, deps) + explanation : '暂时无法读取文章正文，尚未入库。请确认链接可打开，再回复“重试”；也可以回复“取消”后补充正文或文件给 AI 分析。'
    return finish(reply)
  }
}
