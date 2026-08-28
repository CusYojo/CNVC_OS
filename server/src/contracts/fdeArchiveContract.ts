import { z } from 'zod'

export const archiveCategories = ['项目基础资料', '立项材料', '业务尽调', '财务尽调', '法务尽调', '投决材料', '合同与协议', '交割材料'] as const
export const archiveQuery = z.object({
  keyword: z.string().trim().max(100).default(''),
  projectId: z.string().uuid().optional(),
  category: z.string().trim().max(32).default(''),
  type: z.string().trim().max(16).default(''),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(6),
}).strict()
export const archiveAuditQuery = archiveQuery.extend({ kind: z.enum(['access', 'permissions']).default('access'), fileId: z.string().uuid().optional() })
export const ARCHIVE_EXPORT_LIMIT = 2000
export type ArchiveQuery = z.infer<typeof archiveQuery>
export type ArchiveFile = {
  id: string; projectId: string; projectName: string; workflowModel: string; name: string; type: string; category: string
  uploader: string; uploadedAt: string; byteSize: number; sha256: string | null; version: number; accessVersion: number
  parseStatus: string; hasOriginal: boolean; canDownload: boolean; canAudit: boolean
}
export type ArchiveList = {
  list: ArchiveFile[]; total: number; page: number; pageSize: number; canAudit: boolean
  categories: Array<{ name: string; count: number }>; projects: Array<{ id: string; name: string }>; types: string[]
}
export type ArchiveDetail = { file: ArchiveFile; versions: Array<{ version: number; byteSize: number; sha256: string | null; createdAt: string }>; page: number; pageSize: number; total: number }
export type ArchiveAudit = {
  list: Array<{ id: string; fileId: string; fileName: string; projectName: string; actorName: string; action: string; result: string; version: string; reason: string; createdAt: string }>
  total: number; page: number; pageSize: number; coverage: string
}

// Quote every cell, neutralize spreadsheet formulas even after leading control/space
// characters, and keep CR/LF as quoted content rather than creating extra records.
export function archiveCsvCell(value: unknown) {
  const text = String(value ?? '').replace(/\u0000/g, '')
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}
export function archiveCsv(rows: unknown[][]) { return '\uFEFF' + rows.map(row => row.map(archiveCsvCell).join(',')).join('\r\n') + '\r\n' }
