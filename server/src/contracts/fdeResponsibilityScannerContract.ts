import { z } from 'zod'

export const responsibilityScanLimit = z.number().int().min(1).max(100)
export const responsibilityScannerEnabled = (value: string | undefined) => value === 'true'
export function responsibilityScannerErrorCode(error: unknown) {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'RESP_SCAN_FAILED'
}
