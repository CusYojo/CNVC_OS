export type LinkIntakeMode = 'project' | 'knowledge' | 'both'
export type LinkArticle = { url: string; title: string; text: string; markdown?: string; publisher: string; contentHash: string }
export type LinkProjectResult = { status: 'ready' | 'review' | 'rejected'; leadId?: string; reason?: string }
export type LinkIntakeTask = {
  id: string
  initialMessageId: string
  url: string
  status: 'awaiting_choice' | 'processing' | 'completed' | 'failed' | 'cancelled'
  mode?: LinkIntakeMode
  article?: LinkArticle
  knowledgeId?: string
  knowledgeComment?: string
  knowledgeCommentSaved?: boolean
  project?: LinkProjectResult
  error?: string
}
export type LinkIntakeSession = { task?: LinkIntakeTask; receipts: Record<string, string> }

export function weixinIntakeStoredBody(article?: LinkArticle) {
  if (!article) return null
  try {
    const source = new URL(article.url)
    if (source.protocol === 'http:' || source.protocol === 'https:') return null
  } catch { /* retain non-URL file content */ }
  return article.markdown || article.text || null
}

export function redactCompletedWeixinLinkArticle(article?: LinkArticle) {
  if (!article || weixinIntakeStoredBody(article) !== null) return
  article.text = ''
  delete article.markdown
}

export function weixinArticleUrl(message: string): string | null {
  const urls = message.match(/https?:\/\/[^\s<>"“”]+/gi) || []
  for (const raw of urls) {
    try {
      const url = new URL(raw.replace(/[。，；！？）)]+$/, '').replace(/&amp;/g, '&'))
      if (url.hostname !== 'mp.weixin.qq.com' || url.username || url.password || url.port || !/^\/s(?:\/|$)/.test(url.pathname)) continue
      url.protocol = 'https:'
      url.hash = ''
      // Preserve article identity; discard only known sharing/tracking parameters.
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:scene|subscene|from|isappinstalled|clicktime|enterid|ascene|devicetype|version|nettype|lang|exportkey|pass_ticket|wx_header|utm_.*)$/i.test(key)) url.searchParams.delete(key)
      }
      url.searchParams.sort()
      return url.toString()
    } catch { /* ordinary conversation */ }
  }
  return null
}

export function weixinIntakeCommand(message: string): LinkIntakeMode | 'cancel' | 'retry' | 'status' | null {
  const text = message.trim()
  const choice = text.match(/^([123])(?:\s+[\s\S]+)?$/)?.[1]
  if (choice === '1' || text === '加入项目池') return 'project'
  if (choice === '2' || text === '存入知识库') return 'knowledge'
  if (choice === '3' || text === '两者都做') return 'both'
  if (text === '取消') return 'cancel'
  if (text === '重试') return 'retry'
  if (text === '收录状态') return 'status'
  return null
}

export function weixinIntakeKnowledgeComment(message: string) {
  const match = message.trim().match(/^[23]\s+([\s\S]+)$/)
  return match?.[1].trim().slice(0, 300) || null
}

export const WEIXIN_INTAKE_CHOICE = '请选择：\n1. 加入公共项目池\n2. 存入团队知识库（团队内共享）\n3. 两者都做\n可在选择后直接带一条评价，例如：2 内容很有参考价值\n回复数字选择，或回复“取消”。'

export function weixinIntakeBindingAuthorized(input: { senderId: string; accountUserId: string; botOwnerId: string; bindingUserId: string; bindingVersion: number }) {
  // Legacy first-message auto-bindings map every sender to the bot owner. Do not turn those
  // chat-only defaults into business-write authorization without an admin reconfirmation.
  return input.senderId === input.accountUserId || input.bindingUserId !== input.botOwnerId || input.bindingVersion > 1
}
