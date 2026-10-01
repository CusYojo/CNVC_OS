import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isAiPlatformAdminRole } from '../contracts/adminRoleContract.js'
import type { BuiltinPromptTemplate } from '../data/builtinPromptTemplates.js'

export const PROMPT_LIBRARY_KINDS = ['skill', 'agent'] as const
export type PromptLibraryKind = typeof PROMPT_LIBRARY_KINDS[number]
export type PromptLibraryVisibility = 'private' | 'organization'
export type PromptLibraryActor = { userId: string; userName: string; role: string; ip?: string }

export type PromptLibraryRecord = {
  id: string
  kind: PromptLibraryKind
  name: string
  description: string
  markdown: string
  fileName: string | null
  sourceUrl: string | null
  license: string | null
  ownerUserId: string
  visibility: PromptLibraryVisibility
  version: number
  createdAt: Date
  updatedAt: Date
}

export type PromptLibraryItem = Omit<PromptLibraryRecord, 'createdAt' | 'updatedAt'> & {
  source: 'builtin' | 'user'
  createdAt: Date | null
  updatedAt: Date | null
  editable: boolean
}

export type PromptLibraryRepository = {
  listVisible(userId: string, kind: PromptLibraryKind, includePrivateForAdmin?: boolean): Promise<PromptLibraryRecord[]>
  findById(id: string): Promise<PromptLibraryRecord | null>
  create(item: PromptLibraryRecord): Promise<PromptLibraryRecord>
  update(id: string, expectedVersion: number, patch: Partial<PromptLibraryRecord>): Promise<boolean>
  delete(id: string, expectedVersion: number): Promise<boolean>
}

const safeText = z.string().refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]|[\ud800-\udfff]/u.test(value), '正文包含不可用字符')
const fileName = z.string().trim().max(128).regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,119}\.md$/u, '只能上传 .md 文档且文件名不能包含路径').optional()
const sourceUrl = z.string().trim().max(2048).url().refine(value => /^https?:\/\//i.test(value), '来源必须为 HTTP(S) 链接').nullable().optional()
const inputSchema = z.object({
  kind: z.enum(PROMPT_LIBRARY_KINDS),
  name: safeText.trim().min(1).max(128),
  description: safeText.trim().max(4000).default(''),
  markdown: safeText.trim().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 128 * 1024, 'Markdown 不能超过 128KB'),
  fileName,
  sourceUrl,
  license: safeText.trim().max(128).nullable().optional(),
  visibility: z.enum(['private', 'organization']).default('private'),
}).strict()

export function parsePromptLibraryInput(input: unknown) {
  return inputSchema.parse(input)
}

export function safePromptDownloadFileName(name: string, kind: PromptLibraryKind) {
  const base = name.trim().replace(/\.md$/i, '').replace(/\s+/g, '-')
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(base) && !base.includes('..')
    ? `${base}.md`
    : `${kind}.md`
}

function serviceError(message: string, code: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}

function builtinView(item: BuiltinPromptTemplate): PromptLibraryItem {
  return {
    id: `builtin:${item.slug}`, kind: item.kind, name: item.name, description: item.description,
    markdown: item.markdown, fileName: `${item.slug}.md`, sourceUrl: item.sourceUrl,
    license: item.license ?? null, ownerUserId: '', visibility: 'organization',
    version: 1, createdAt: null, updatedAt: null, source: 'builtin', editable: false,
  }
}

function userView(item: PromptLibraryRecord, actor: PromptLibraryActor): PromptLibraryItem {
  return { ...item, source: 'user', editable: item.ownerUserId === actor.userId || isAiPlatformAdminRole(actor.role) }
}

export function createPromptLibraryService(
  repository: PromptLibraryRepository,
  builtins: readonly BuiltinPromptTemplate[],
  audit: (actor: PromptLibraryActor, action: string, itemId: string) => Promise<void>,
) {
  const getBuiltin = (id: string) => builtins.find(item => `builtin:${item.slug}` === id)

  async function get(actor: PromptLibraryActor, id: string): Promise<PromptLibraryItem> {
    const builtin = getBuiltin(id)
    if (builtin) return builtinView(builtin)
    const item = await repository.findById(id)
    if (!item) throw serviceError('提示词不存在', 'PROMPT_NOT_FOUND', 404)
    if (item.visibility === 'private' && item.ownerUserId !== actor.userId && !isAiPlatformAdminRole(actor.role)) {
      throw serviceError('无权访问此提示词', 'PROMPT_FORBIDDEN', 403)
    }
    return userView(item, actor)
  }

  return {
    async list(actor: PromptLibraryActor, kind: PromptLibraryKind): Promise<PromptLibraryItem[]> {
      if (!PROMPT_LIBRARY_KINDS.includes(kind)) throw serviceError('提示词类型无效', 'PROMPT_KIND_INVALID', 400)
      const items = await repository.listVisible(actor.userId, kind, isAiPlatformAdminRole(actor.role))
      return [...builtins.filter(item => item.kind === kind).map(builtinView), ...items.map(item => userView(item, actor))]
    },
    get,
    async download(actor: PromptLibraryActor, id: string): Promise<PromptLibraryItem> {
      const item = await get(actor, id)
      await audit(actor, '下载提示词', id)
      return item
    },
    async create(actor: PromptLibraryActor, input: unknown): Promise<PromptLibraryItem> {
      const value = parsePromptLibraryInput(input)
      const now = new Date()
      const created = await repository.create({
        id: randomUUID(), kind: value.kind, name: value.name, description: value.description,
        markdown: value.markdown, fileName: value.fileName ?? null,
        sourceUrl: value.sourceUrl ?? null, license: value.license ?? null,
        ownerUserId: actor.userId, visibility: value.visibility, version: 1,
        createdAt: now, updatedAt: now,
      })
      await audit(actor, '创建提示词', created.id)
      return userView(created, actor)
    },
    async update(actor: PromptLibraryActor, id: string, input: { expectedVersion: number } & Record<string, unknown>): Promise<PromptLibraryItem> {
      if (id.startsWith('builtin:')) throw serviceError('内置模板只读', 'PROMPT_BUILTIN_READONLY', 403)
      const existing = await get(actor, id)
      if (!existing.editable) throw serviceError('无权修改此提示词', 'PROMPT_FORBIDDEN', 403)
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw serviceError('版本无效', 'PROMPT_VERSION_INVALID', 400)
      const { expectedVersion, ...rawPatch } = input
      const patch = inputSchema.omit({ kind: true }).partial().strict().parse(rawPatch)
      const value = parsePromptLibraryInput({
        kind: existing.kind, name: patch.name ?? existing.name,
        description: patch.description ?? existing.description,
        markdown: patch.markdown ?? existing.markdown,
        fileName: patch.fileName ?? existing.fileName ?? undefined,
        sourceUrl: patch.sourceUrl === undefined ? existing.sourceUrl : patch.sourceUrl,
        license: patch.license === undefined ? existing.license : patch.license,
        visibility: patch.visibility ?? existing.visibility,
      })
      const changed = await repository.update(id, expectedVersion, {
        name: value.name, description: value.description, markdown: value.markdown,
        fileName: value.fileName ?? null, sourceUrl: value.sourceUrl ?? null,
        license: value.license ?? null, visibility: value.visibility,
      })
      if (!changed) throw serviceError('提示词已被更新，请刷新后重试', 'PROMPT_VERSION_CONFLICT', 409)
      await audit(actor, '修改提示词', id)
      return get(actor, id)
    },
    async remove(actor: PromptLibraryActor, id: string, expectedVersion: number): Promise<void> {
      if (id.startsWith('builtin:')) throw serviceError('内置模板只读', 'PROMPT_BUILTIN_READONLY', 403)
      const existing = await get(actor, id)
      if (!existing.editable) throw serviceError('无权删除此提示词', 'PROMPT_FORBIDDEN', 403)
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw serviceError('版本无效', 'PROMPT_VERSION_INVALID', 400)
      if (!await repository.delete(id, expectedVersion)) throw serviceError('提示词已被更新，请刷新后重试', 'PROMPT_VERSION_CONFLICT', 409)
      await audit(actor, '删除提示词', id)
    },
  }
}
