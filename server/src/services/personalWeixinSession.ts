import { createHash } from 'node:crypto'

export function personalWeixinSessionId(externalConversationId: string) {
  const digest = createHash('sha256').update(externalConversationId).digest('hex').slice(0, 48)
  return `weixin-personal:${digest}`
}
