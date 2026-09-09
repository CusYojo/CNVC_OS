export type ComplianceTeamIdentity = {
  personName: string
  roleTitle: string
  evidenceQuote: string
}
// Require an explicit adjacent name/role relationship in a quoted source.
// Merely seeing two names and two jobs in the same document is insufficient.
export function bindComplianceTeamIdentity(raw: unknown, evidence: string[]): ComplianceTeamIdentity | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.person_name !== 'string' || typeof value.role_title !== 'string' || typeof value.identity_quote !== 'string') return undefined
  const personName = value.person_name.trim()
  const roleTitle = value.role_title.trim()
  const evidenceQuote = value.identity_quote.trim()
  if (!personName || personName.length > 100 || !roleTitle || roleTitle.length > 160
    || !evidenceQuote || evidenceQuote.length > 1200 || !evidence.some(text => text.includes(evidenceQuote))) return undefined
  const compact = (text: string) => text.replace(/\s+/g, '')
  const name = compact(personName), role = compact(roleTitle), quote = compact(evidenceQuote)
  const pairs = [`${role}${name}`, `${role}：${name}`, `${role}:${name}`,
    `${name}（${role}）`, `${name}(${role})`, `${name}现任${role}`, `${name}担任${role}`]
  if (!pairs.some(pair => quote.includes(pair))) return undefined
  return { personName, roleTitle, evidenceQuote }
}
