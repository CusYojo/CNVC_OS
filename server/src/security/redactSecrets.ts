const sensitiveEnvName = /(?:KEY|SECRET|PASSWORD|TOKEN)$/i

function configuredSecrets(): string[] {
  return [...new Set(Object.entries(process.env).flatMap(([name, value]) => (
    sensitiveEnvName.test(name) && typeof value === 'string' && value.length >= 8 ? [value] : []
  )))].sort((left, right) => right.length - left.length)
}

export function redactSensitiveText(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value ?? '')
  for (const secret of configuredSecrets()) text = text.replaceAll(secret, '[REDACTED]')
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-[REDACTED]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*["']?)([^\s,;"'}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}

export function safeErrorLog(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: redactSensitiveText(error) }
  const typed = error as Error & { code?: unknown; status?: unknown; cause?: unknown }
  return {
    name: error.name,
    message: redactSensitiveText(error.message),
    ...(typed.code == null ? {} : { code: redactSensitiveText(typed.code) }),
    ...(typed.status == null ? {} : { status: typed.status }),
    ...(error.stack ? { stack: redactSensitiveText(error.stack) } : {}),
    ...(typed.cause instanceof Error ? { cause: redactSensitiveText(typed.cause.message) } : {}),
  }
}
