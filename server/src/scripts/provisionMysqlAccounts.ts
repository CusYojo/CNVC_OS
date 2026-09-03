import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '../db/client.js'
import { mysqlConfig } from '../db/config.js'
import {
  mysqlAccountProvisioningPreview,
  provisionSeparatedMysqlAccounts,
  type MysqlAccountSeparationSpec,
} from '../services/mysqlAccountProvisioningService.js'

const apply = process.argv.includes('--apply')

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`[mysql-account] ${name} is required${apply ? ' for --apply' : ''}`)
  return value
}

function accountSpec(): MysqlAccountSeparationSpec {
  return {
    database: mysqlConfig.database,
    runtime: {
      username: required('DB_RUNTIME_USERNAME'),
      host: required('DB_RUNTIME_HOST'),
      password: required('DB_RUNTIME_PASSWORD'),
    },
    migration: {
      username: required('DB_MIGRATION_USERNAME'),
      host: required('DB_MIGRATION_HOST'),
      password: required('DB_MIGRATION_PASSWORD'),
    },
  }
}

async function writePrivate(file: string, value: string) {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function main() {
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'preview',
      mutatesDatabase: false,
      requiredEnvironment: [
        'DB_RUNTIME_USERNAME', 'DB_RUNTIME_HOST', 'DB_RUNTIME_PASSWORD',
        'DB_MIGRATION_USERNAME', 'DB_MIGRATION_HOST', 'DB_MIGRATION_PASSWORD',
      ],
      runtimePrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      migrationPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'INDEX', 'REFERENCES', 'TRIGGER'],
      note: 'Passwords are required only for --apply and are never printed or written to reports.',
    }))
    return
  }
  const spec = accountSpec()
  const statements = mysqlAccountProvisioningPreview(spec)
  const connection = await pool.getConnection()
  try {
    const result = await provisionSeparatedMysqlAccounts(connection, spec)
    const report = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      ok: true,
      database: mysqlConfig.database,
      statements: statements.map((statement) => statement.replace('<redacted-password>', '<redacted>')),
      result,
      passwordsPersisted: false,
      nextStep: 'Place runtime credentials in the application .env and migration credentials in root-owned DB_MIGRATION_ENV_FILE, then rerun audit:mysql-privileges.',
    }
    const outputDir = path.resolve('.runtime/migration-evidence/mysql-account-separation')
    await mkdir(outputDir, { recursive: true, mode: 0o700 })
    await chmod(outputDir, 0o700)
    await writePrivate(path.join(outputDir, 'apply-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ ok: true, mode: 'apply', result, passwordsPersisted: false, outputDir }))
  } finally {
    connection.release()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}).finally(() => pool.end())
