import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { auditLogs, promptLibraryItems } from '../../db/schema.js'
import type { PromptLibraryKind, PromptLibraryRecord, PromptLibraryRepository, PromptLibrarySummaryRecord } from '../../services/promptLibraryService.js'

type SummaryRow = Pick<typeof promptLibraryItems.$inferSelect, keyof PromptLibrarySummaryRecord>

function summaryRecord(row: SummaryRow): PromptLibrarySummaryRecord {
  return {
    id: row.id, kind: row.kind as PromptLibraryKind, name: row.name,
    description: row.description, fileName: row.fileName,
    sourceUrl: row.sourceUrl, license: row.license,
    ownerUserId: row.ownerUserId, visibility: row.visibility as PromptLibraryRecord['visibility'],
    version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
  }
}

function record(row: typeof promptLibraryItems.$inferSelect): PromptLibraryRecord {
  return { ...summaryRecord(row), markdown: row.markdown }
}

export const mysqlPromptLibraryRepository: PromptLibraryRepository = {
  async listVisible(userId, kind, includePrivateForAdmin = false) {
    const rows = await db.select({
      id: promptLibraryItems.id, kind: promptLibraryItems.kind, name: promptLibraryItems.name,
      description: promptLibraryItems.description, fileName: promptLibraryItems.fileName,
      sourceUrl: promptLibraryItems.sourceUrl, license: promptLibraryItems.license,
      ownerUserId: promptLibraryItems.ownerUserId, visibility: promptLibraryItems.visibility,
      version: promptLibraryItems.version, createdAt: promptLibraryItems.createdAt,
      updatedAt: promptLibraryItems.updatedAt,
    }).from(promptLibraryItems).where(and(
      eq(promptLibraryItems.kind, kind), isNull(promptLibraryItems.deletedAt),
      includePrivateForAdmin ? undefined : or(eq(promptLibraryItems.ownerUserId, userId), eq(promptLibraryItems.visibility, 'organization')),
    )).orderBy(desc(promptLibraryItems.updatedAt)).limit(500)
    return rows.map(summaryRecord)
  },
  async findById(id) {
    const [row] = await db.select().from(promptLibraryItems).where(and(
      eq(promptLibraryItems.id, id), isNull(promptLibraryItems.deletedAt),
    )).limit(1)
    return row ? record(row) : null
  },
  async createWithAudit(item, audit) {
    return db.transaction(async (tx) => {
      await tx.insert(promptLibraryItems).values(item)
      await tx.insert(auditLogs).values(audit)
      return item
    })
  },
  async updateWithAudit(id, expectedVersion, patch, audit) {
    return db.transaction(async (tx) => {
      const [result] = await tx.update(promptLibraryItems).set({
        ...patch, version: sql`${promptLibraryItems.version} + 1`, updatedAt: new Date(),
      }).where(and(
        eq(promptLibraryItems.id, id), eq(promptLibraryItems.version, expectedVersion), isNull(promptLibraryItems.deletedAt),
      ))
      if (result.affectedRows !== 1) return false
      await tx.insert(auditLogs).values(audit)
      return true
    })
  },
  async deleteWithAudit(id, expectedVersion, audit) {
    return db.transaction(async (tx) => {
      const [result] = await tx.update(promptLibraryItems).set({
        deletedAt: new Date(), version: sql`${promptLibraryItems.version} + 1`, updatedAt: new Date(),
      }).where(and(
        eq(promptLibraryItems.id, id), eq(promptLibraryItems.version, expectedVersion), isNull(promptLibraryItems.deletedAt),
      ))
      if (result.affectedRows !== 1) return false
      await tx.insert(auditLogs).values(audit)
      return true
    })
  },
}
