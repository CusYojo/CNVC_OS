export type DirectSkillAgentGatewayRecoveryOptions = {
  maxRetries?: number
  delayMs?: number
  wait?: (delayMs: number) => Promise<void>
}

export type DirectSkillAgentFailure = {
  code: string
  recoverableGateway403: boolean
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback
}

export function directSkillAgentGatewayRecoveryPolicy(
  options: DirectSkillAgentGatewayRecoveryOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    maxRetries: options?.maxRetries ?? boundedInteger(
      env.AI_DIRECT_SKILL_GATEWAY_RETRIES,
      1,
      0,
      2,
    ),
    delayMs: options?.delayMs ?? boundedInteger(
      env.AI_DIRECT_SKILL_GATEWAY_RETRY_DELAY_MS,
      30_000,
      1_000,
      60_000,
    ),
    wait: options?.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs)
    })),
  }
}

export function classifyDirectSkillAgentFailure(
  message: string,
  fallbackCode = 'DIRECT_SKILL_AGENT_FAILED',
): DirectSkillAgentFailure {
  if (/Failed to authenticate|authentication failed|invalid api key|unauthorized|API Error:\s*401|Response code:\s*401|HTTP\s*401/i.test(message)) {
    return {
      code: 'DIRECT_SKILL_AGENT_AUTHENTICATION_FAILED',
      recoverableGateway403: false,
    }
  }
  if (/额度不足|余额不足|insufficient[_ -]?quota|insufficient credits?|billing quota/i.test(message)) {
    return {
      code: 'DIRECT_SKILL_AGENT_QUOTA_EXHAUSTED',
      recoverableGateway403: false,
    }
  }
  if (/API Error:\s*403|Response code:\s*403|HTTP\s*403|status(?:\s+code)?\s*[=:]?\s*403|403\s+Forbidden/i.test(message)) {
    return {
      code: 'DIRECT_SKILL_AGENT_UPSTREAM_FORBIDDEN',
      recoverableGateway403: true,
    }
  }
  return { code: fallbackCode, recoverableGateway403: false }
}
