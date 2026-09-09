const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// Presence-only integration check. The native processor remains responsible for
// validating evidence files, hashes, authorization and substantive content.
export function complianceRenderContractError(payload: unknown) {
  const content = isRecord(payload) ? payload : {}
  const missingFields: string[] = []
  for (const field of ['public_verification', 'delivery_readiness'] as const) {
    if (!isRecord(content[field])) missingFields.push(field)
  }
  const target = isRecord(content.target_company) ? content.target_company : {}
  if (typeof target.legal_name !== 'string' || !target.legal_name.trim()) {
    missingFields.push('target_company.legal_name')
  }
  if (!missingFields.length) return null
  return Object.assign(new Error('合规渲染输入缺少必要核验契约，需修复数据传递后重试。'), {
    code: 'COMPLIANCE_RENDER_CONTRACT_MISMATCH' as const,
    missingFields,
  })
}
