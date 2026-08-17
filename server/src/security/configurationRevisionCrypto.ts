import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export type ConfigurationRevisionDomain = 'model' | 'capability' | 'im'
type CipherPayload = { v: 1; iv: string; tag: string; data: string }

function keyForDomain(domain: ConfigurationRevisionDomain): Buffer {
  const envName = domain === 'im'
    ? 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY'
    : 'MODEL_CREDENTIAL_ENCRYPTION_KEY'
  const configured = process.env[envName]?.trim() || ''
  const decoded = /^[0-9a-f]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64')
  if (decoded.length !== 32) {
    throw Object.assign(new Error('配置版本加密密钥未配置或长度无效'), {
      code: 'CONFIGURATION_REVISION_KEY_INVALID', status: 503,
    })
  }
  return decoded
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]))
  }
  return value
}

export function configurationRevisionContext(input: {
  domain: ConfigurationRevisionDomain
  resourceType: string
  resourceId: string
  sourceVersion: number
}): string {
  return `${input.domain}:${input.resourceType}:${input.resourceId}:${input.sourceVersion}`
}

export function encryptConfigurationRevisionSnapshot(
  domain: ConfigurationRevisionDomain,
  context: string,
  snapshot: Record<string, unknown>,
): { ciphertext: string; sha256: string } {
  const plainText = JSON.stringify(normalize(snapshot))
  const key = keyForDomain(domain)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const payload: CipherPayload = {
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: encrypted.toString('base64url'),
  }
  return {
    ciphertext: JSON.stringify(payload),
    sha256: createHash('sha256').update(plainText).digest('hex'),
  }
}

export function decryptConfigurationRevisionSnapshot(
  domain: ConfigurationRevisionDomain,
  context: string,
  ciphertext: string,
  expectedSha256: string,
): Record<string, unknown> {
  try {
    const payload = JSON.parse(ciphertext) as CipherPayload
    if (payload.v !== 1 || !payload.iv || !payload.tag || !payload.data) throw new Error('invalid payload')
    const decipher = createDecipheriv('aes-256-gcm', keyForDomain(domain), Buffer.from(payload.iv, 'base64url'))
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'))
    const plainText = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
    if (createHash('sha256').update(plainText).digest('hex') !== expectedSha256) throw new Error('hash mismatch')
    const value = JSON.parse(plainText) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid snapshot')
    return value as Record<string, unknown>
  } catch {
    throw Object.assign(new Error('配置版本快照无法解密或完整性校验失败'), {
      code: 'CONFIGURATION_REVISION_DECRYPT_FAILED', status: 503,
    })
  }
}
