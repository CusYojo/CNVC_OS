export type LeadAgentAuditRuntime = 'claude-agent-sdk' | 'codex-cli'

export function leadAgentAuditPromptVersion(
  baseVersion: string,
  runtime: LeadAgentAuditRuntime,
) {
  const base = String(baseVersion ?? '').normalize('NFKC').trim()
  if (!base) throw new Error('lead Agent prompt version is required')
  const suffix = runtime === 'codex-cli' ? 'codex-v1' : 'claude-v1'
  const version = `${base}-${suffix}`
  if (version.length > 64) throw new Error('lead Agent audit prompt version exceeds 64 characters')
  return version
}
