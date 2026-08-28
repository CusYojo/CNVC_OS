import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { desc, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { adminConfigurationRevisions, aiModelProviders, imBots, imOutbox } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'

export async function getFdeIntegrationSummary(userId: string) {
  const user = await identityRepositories.users.findById(userId)
  if (!user || user.status !== '启用' || !(await identityRepositories.users.listPermissionCodes(userId)).includes('system.manage')) throw Object.assign(new Error('仅管理员可读取集成摘要'), { status: 403, code: 'ROLE_FORBIDDEN' })
  await db.execute(sql`SELECT 1`)
  const [providers, bots, outbox, revisions, storageAccessible] = await Promise.all([
    db.select({ id: aiModelProviders.id, name: aiModelProviders.name, enabled: aiModelProviders.enabled, lastTestStatus: aiModelProviders.lastTestStatus, lastTestAt: aiModelProviders.lastTestAt, version: aiModelProviders.version }).from(aiModelProviders),
    db.select({ id: imBots.id, name: imBots.name, platform: imBots.platform, enabled: imBots.enabled, connectionStatus: imBots.connectionStatus, lastConnectedAt: imBots.lastConnectedAt, version: imBots.version }).from(imBots),
    db.select({ status: imOutbox.status, total: sql<number>`COUNT(*)` }).from(imOutbox).groupBy(imOutbox.status),
    db.select({ id: adminConfigurationRevisions.id, domain: adminConfigurationRevisions.domain, resourceType: adminConfigurationRevisions.resourceType, operation: adminConfigurationRevisions.operation, sourceVersion: adminConfigurationRevisions.sourceVersion, createdAt: adminConfigurationRevisions.createdAt }).from(adminConfigurationRevisions).orderBy(desc(adminConfigurationRevisions.createdAt)).limit(20),
    access(path.resolve(process.env.PROJECT_FILE_ROOT || path.join(process.cwd(), 'server', 'project-files')), constants.R_OK | constants.W_OK).then(() => true, () => false),
  ])
  return { checkedAt: new Date().toISOString(), database: { provider: 'MySQL', reachable: true }, storage: { accessible: storageAccessible, probe: 'directory-access-only' }, providers, bots, outbox: outbox.map((row) => ({ ...row, total: Number(row.total) })), revisions }
}
