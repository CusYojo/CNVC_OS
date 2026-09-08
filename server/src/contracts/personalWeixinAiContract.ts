export const PERSONAL_WEIXIN_MODE = 'personal' as const

export type PersonalWeixinAiView = {
  connected: boolean
  eligible: boolean
  botId: string | null
  version: number | null
  lastConnectedAt: string | null
  accountHint: string
  reason: string | null
}

export type PublicPersonalWeixinConfig = {
  ownershipMode: typeof PERSONAL_WEIXIN_MODE
  connectedAt: string
  accountHint: string
}

export function personalWeixinSenderAllowed(
  config: Record<string, unknown>,
  senderId: string,
): boolean {
  return config.ownershipMode === PERSONAL_WEIXIN_MODE
    && typeof config.accountUserId === 'string'
    && config.accountUserId.length > 0
    && config.accountUserId === senderId
}

export function publicPersonalWeixinConfig(
  config: Record<string, unknown>,
): PublicPersonalWeixinConfig {
  const accountUserId = typeof config.accountUserId === 'string' ? config.accountUserId : ''
  return {
    ownershipMode: PERSONAL_WEIXIN_MODE,
    connectedAt: typeof config.connectedAt === 'string' ? config.connectedAt : '',
    accountHint: accountUserId ? `***${accountUserId.slice(-4)}` : '',
  }
}
