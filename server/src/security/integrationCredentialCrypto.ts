import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

type CipherPayload = { v: 1; iv: string; tag: string; data: string }

function encryptionKey(): Buffer {
  const configured = process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY?.trim() || ''
  const decoded = /^[0-9a-f]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64')
  if (decoded.length !== 32) {
    throw Object.assign(new Error('集成凭据加密密钥未配置或长度无效'), {
      code: 'INTEGRATION_ENCRYPTION_KEY_INVALID', status: 503,
    })
  }
  return decoded
}

export function assertIntegrationCredentialEncryptionReady() {
  encryptionKey()
}

export function encryptIntegrationCredential(value: Record<string, string>, context: string) {
  const plainText = JSON.stringify(value)
  if (!Object.keys(value).length || Object.values(value).some((item) => !item.trim())) {
    throw Object.assign(new Error('集成凭据不能为空'), { code: 'INTEGRATION_CREDENTIAL_EMPTY', status: 400 })
  }
  const key = encryptionKey()
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
  const hintSource = value.webhookUrl || value.appId || value.clientId || value.corpId || value.inboundSecret || plainText
  return {
    ciphertext: JSON.stringify(payload),
    hint: `••••${hintSource.slice(-4)}`,
    fingerprint: createHmac('sha256', key).update(plainText).digest('hex'),
  }
}

export function decryptIntegrationCredential(ciphertext: string, context: string): Record<string, string> {
  try {
    const payload = JSON.parse(ciphertext) as CipherPayload
    if (payload.v !== 1 || !payload.iv || !payload.tag || !payload.data) throw new Error('invalid payload')
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64url'))
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'))
    const decoded = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
    const value = JSON.parse(decoded) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid credential')
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    throw Object.assign(new Error('集成凭据无法解密，请由管理员重新写入'), {
      code: 'INTEGRATION_CREDENTIAL_DECRYPT_FAILED', status: 503,
    })
  }
}
