export function encodeInstitutionTrackingKey(name: string): string {
  return [...new TextEncoder().encode(name.normalize('NFKC').trim())]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function decodeInstitutionTrackingKey(key: string): string | null {
  if (!key || key.length > 2040 || key.length % 2 !== 0 || !/^[a-f0-9]+$/u.test(key)) return null
  try {
    const bytes = new Uint8Array(key.match(/.{2}/gu)!.map((byte) => Number.parseInt(byte, 16)))
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return name && encodeInstitutionTrackingKey(name) === key ? name : null
  } catch {
    return null
  }
}
