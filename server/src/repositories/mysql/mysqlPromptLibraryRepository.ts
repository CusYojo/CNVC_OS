import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { promptLibraryItems } from '../../db/schema.js'
import type { PromptLibraryKind, PromptLibraryRecord, PromptLibraryRepository } from '../../services/promptLibraryService.js'

function record(row: typeof promptLibraryItems.$inferSelect): PromptLibraryRecord {
  return {
    id: row.id, kind: row.kind as PromptLibraryKind, name: row.name,
    description: row.description, markdown: row.markdown,
    fileName: row.fileName, sourceUrl: row.sourceUrl, license: row.license,
    ownerUserId: row.ownerUserId, visibility: row.visibility as PromptLibraryRecord['visibility'],
    version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
  }
}

export const mysqlPromptLibraryRepository: PromptLibraryRepository = {
  async listVisible(userId, kind, includePrivateForAdmin = false) {
    const rows = await db.select().from(promptLibraryItems).where(and(
      eq(promptLibraryItems.kind, kind), isNull(promptLibraryItems.deletedAt),
      includePrivateForAdmin ? undefined : or(eq(promptLibraryItems.ownerUserId, userId), eq(promptLibraryItems.visibility, 'organization')),
    )).orderBy(desc(promptLibraryItems.updatedAt)).limit(500)
    return rows.map(record)
  },
  async findById(id) {
    const [row] = await db.select().from(promptLibraryItems).where(and(
      eq(promptLibraryItems.id, id), isNull(promptLibraryItems.deletedAt),
    )).limit(1)
    return row ? record(row) : null
  },
  async create(item) {
    await db.insert(promptLibraryItems).values(item)
    return item
  },
  async update(id, expectedVersion, patch) {
    const [result] = await db.update(promptLibraryItems).set({
      ...patch, version: sql`${promptLibraryItems.version} + 1`, updatedAt: new Date(),
    }).where(and(
      eq(promptLibraryItems.id, id), eq(promptLibraryItems.version, expectedVersion), isNull(promptLibraryItems.deletedAt),
    ))
    return result.affectedRows === 1
  },
  async delete(id, expectedVersion) {
    const [result] = await db.update(promptLibraryItems).set({
      deletedAt: new Date(), version: sql`${promptLibraryItems.version} + 1`, updatedAt: new Date(),
    }).where(and(
      eq(promptLibraryItems.id, id), eq(promptLibraryItems.version, expectedVersion), isNull(promptLibraryItems.deletedAt),
    ))
    return result.affectedRows === 1
  },
}
