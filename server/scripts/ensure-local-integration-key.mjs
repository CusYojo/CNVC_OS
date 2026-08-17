import { randomBytes } from 'node:crypto'
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const envPath = path.resolve(process.cwd(), '.env')
const keyName = 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY'
const current = await readFile(envPath, 'utf8').catch(() => '')
const existing = current.match(new RegExp(`^${keyName}=(.+)$`, 'm'))?.[1]?.trim() || ''
const decoded = /^[0-9a-f]{64}$/i.test(existing)
  ? Buffer.from(existing, 'hex')
  : Buffer.from(existing, 'base64')

if (decoded.length !== 32) {
  const next = `${current.replace(/\s*$/, '\n')}${keyName}=${randomBytes(32).toString('hex')}\n`
  const temporaryPath = `${envPath}.integration-key.tmp`
  await writeFile(temporaryPath, next, { mode: 0o600 })
  await rename(temporaryPath, envPath)
  await chmod(envPath, 0o600)
  console.log('[local-config] generated integration credential encryption key')
}
