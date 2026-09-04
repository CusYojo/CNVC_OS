import { and, count, desc, eq, like, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { personalNotes } from '../db/schema.js'
import { personalNoteCreate, personalNoteDelete, personalNotePlainText, personalNoteQuery, personalNoteUpdate } from '../contracts/personalNoteContract.js'

type PersonalNoteRow = typeof personalNotes.$inferSelect

function fail(code: string, message: string, status: number): never {
  throw Object.assign(new Error(message), { code, status })
}

function present(row: PersonalNoteRow) {
  return {
    id: row.id,
    title: row.title,
    noteDate: row.noteDate,
    content: row.content,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function ownedNote(id: string, ownerId: string) {
  const [row] = await db.select().from(personalNotes).where(and(eq(personalNotes.id, id), eq(personalNotes.ownerId, ownerId))).limit(1)
  if (!row) fail('PERSONAL_NOTE_NOT_FOUND', '笔记不存在', 404)
  return row
}

export async function listPersonalNotes(ownerId: string, raw: unknown) {
  const input = personalNoteQuery.parse(raw)
  const keyword = input.keyword ? `%${input.keyword}%` : ''
  const where = and(
    eq(personalNotes.ownerId, ownerId),
    keyword ? or(like(personalNotes.title, keyword), like(personalNotes.plainText, keyword)) : undefined,
  )
  const [{ total }] = await db.select({ total: count() }).from(personalNotes).where(where)
  const rows = await db.select().from(personalNotes).where(where)
    .orderBy(desc(personalNotes.noteDate), desc(personalNotes.updatedAt), desc(personalNotes.id))
    .limit(input.pageSize).offset((input.page - 1) * input.pageSize)
  return { list: rows.map(present), total, page: input.page, pageSize: input.pageSize }
}

export async function createPersonalNote(ownerId: string, raw: unknown) {
  const input = personalNoteCreate.parse(raw)
  const [inserted] = await db.insert(personalNotes).values({
    ownerId,
    title: input.title,
    noteDate: input.noteDate,
    content: input.content,
    plainText: personalNotePlainText(input.content),
  }).$returningId()
  return present(await ownedNote(inserted.id, ownerId))
}

export async function updatePersonalNote(id: string, ownerId: string, raw: unknown) {
  const input = personalNoteUpdate.parse(raw)
  const [result] = await db.update(personalNotes).set({
    title: input.title,
    noteDate: input.noteDate,
    content: input.content,
    plainText: personalNotePlainText(input.content),
    version: sql`${personalNotes.version} + 1`,
    updatedAt: new Date(),
  }).where(and(eq(personalNotes.id, id), eq(personalNotes.ownerId, ownerId), eq(personalNotes.version, input.expectedVersion)))
  if (result.affectedRows !== 1) {
    await ownedNote(id, ownerId)
    fail('VERSION_CONFLICT', '笔记已在其他页面更新，请刷新后重试', 409)
  }
  return present(await ownedNote(id, ownerId))
}

export async function deletePersonalNote(id: string, ownerId: string, raw: unknown) {
  const input = personalNoteDelete.parse(raw)
  const [result] = await db.delete(personalNotes).where(and(eq(personalNotes.id, id), eq(personalNotes.ownerId, ownerId), eq(personalNotes.version, input.expectedVersion)))
  if (result.affectedRows !== 1) {
    await ownedNote(id, ownerId)
    fail('VERSION_CONFLICT', '笔记已在其他页面更新，请刷新后重试', 409)
  }
  return { deleted: true }
}
