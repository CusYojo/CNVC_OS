import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { authLegacyBearerPolicy } from '../db/schema.js'
import { invalidateAllLegacyBearerTokens } from '../services/authService.js'

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1]?.trim() || '' : ''
}

async function main() {
  await ensureSchema()
  const apply = process.argv.includes('--apply')
  const [current] = await db.select().from(authLegacyBearerPolicy)
    .where(eq(authLegacyBearerPolicy.id, 'global')).limit(1)
  if (!current) throw new Error('旧 JWT 强制失效策略不存在')
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'preview',
      currentVersion: Number(current.version),
      revokedBefore: current.revokedBefore.toISOString(),
      message: '未修改数据库；应用时必须提供系统管理员 ID 和 0600 批准理由文件',
    }))
    return
  }
  const approvedUserId = argument('--approved-user-id')
  const reasonPath = argument('--reason-file')
  if (!approvedUserId || !reasonPath) {
    throw new Error('apply requires --approved-user-id and --reason-file')
  }
  const absoluteReasonPath = path.resolve(reasonPath)
  const info = await lstat(absoluteReasonPath)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('批准理由必须是非符号链接的 0600 普通文件')
  }
  const reason = (await readFile(absoluteReasonPath, 'utf8')).trim()
  const result = await invalidateAllLegacyBearerTokens({ approvedUserId, reason })
  console.log(JSON.stringify({
    ok: true,
    mode: 'applied',
    previousVersion: Number(current.version),
    version: result.version,
    revokedBefore: result.revokedBefore.toISOString(),
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}).finally(async () => await pool.end())
