import { Router } from 'express'
import { z } from 'zod'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { resolve as pathResolve, sep as pathSep, extname } from 'node:path'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { ingestFile } from '../services/ragService.js'
import { db } from '../db/client.js'
import { projectFiles } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { ProjectCreateSchema } from '../schemas/project.js'
import { requireSystemAdmin } from '../middleware/requireAuth.js'
import { listProjectMembers, replaceProjectMembers } from '../services/identityAdministrationService.js'
import {
  addFile, createProject, getFile, getFileVersion, getProject, listFiles, listFileVersions, listProjects, moveProjectStage, replaceFileContent, setFileStoragePath, updateProject, deleteProject, pinProject, listAllFiles } from '../services/projectService.js'
import { openProjectFile, projectFileContentType, projectFilePreviewContentType, removeProjectFile, saveProjectFileRevision } from '../services/projectFileStorageService.js'
import { requireAccessibleProject } from '../services/projectAccessService.js'
import { decodeAndValidateProjectFile } from '../security/projectFileValidation.js'
import { enqueueProjectScoreJob, getProjectScoreJob } from '../services/projectScoreJobService.js'
import { writeAudit } from '../services/auditService.js'

export const projectsRouter = Router()
const routeId = (value: string | string[]) => z.string().min(1).parse(value)

function contentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

const ListSchema = z.object({
  keyword: z.string().optional(),
  stage: z.string().optional(),
  owner: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

const ProjectPatchSchema = ProjectCreateSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
}).strict()

projectsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const args = ListSchema.parse(req.query)
    const data = await listProjects(args, req.user!.uid)
    res.json(data)
  } catch (err) { next(err) }
})

projectsRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.id)
    await requireAccessibleProject(req.user!.uid, projectId)
    const row = await getProject(projectId)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '项目不存在', details: null }); return }
    res.json(row)
  } catch (err) { next(err) }
})

projectsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = ProjectCreateSchema.parse(req.body)
    // Every new project starts with the authenticated creator as its sole
    // stable owner. Later assignment must use the audited admin member route.
    const row = await createProject({
      ...body,
      owner: req.user!.name,
      collaborators: [],
    } as never, req.user!.uid)
    res.status(201).json(row)
  } catch (err) { next(err) }
})

projectsRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.id)
    await requireAccessibleProject(req.user!.uid, projectId)
    if (
      req.body
      && typeof req.body === 'object'
      && ('owner' in req.body || 'ownerUserId' in req.body || 'collaborators' in req.body)
    ) {
      const admin = req.user!.role === '系统管理员'
      throw Object.assign(new Error(admin
        ? '请通过项目成员管理接口修改负责人和协作成员'
        : '项目负责人和协作成员只能由系统管理员修改'), {
        status: admin ? 409 : 403,
        code: admin ? 'PROJECT_MEMBERSHIP_ENDPOINT_REQUIRED' : 'PROJECT_MEMBERSHIP_FORBIDDEN',
      })
    }
    const { expectedVersion, ...patch } = ProjectPatchSchema.parse(req.body)
    const row = await updateProject(projectId, patch, req.user!.uid, expectedVersion)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '项目不存在', details: null }); return }
    res.json(row)
  } catch (err) { next(err) }
})

projectsRouter.get('/:id/members', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.id)
    await requireAccessibleProject(req.user!.uid, projectId)
    const list = await listProjectMembers(projectId)
    res.json({ list, total: list.length })
  } catch (error) { next(error) }
})

const ReplaceProjectMembersSchema = z.object({
  ownerUserId: z.string().uuid(),
  collaboratorUserIds: z.array(z.string().uuid()).max(100).default([]),
}).strict()

projectsRouter.put('/:id/members', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.id)
    const body = ReplaceProjectMembersSchema.parse(req.body)
    const result = await replaceProjectMembers({ projectId, ...body }, {
      userId: req.user!.uid,
      userName: req.user!.name,
    })
    res.json(result)
  } catch (error) { next(error) }
})

projectsRouter.post('/:id/stage', async (req: AuthedRequest, res, next) => {
  try {
    const { stage, comment, expectedVersion } = z.object({
      stage: z.string(), comment: z.string().default(''), expectedVersion: z.number().int().positive(),
    }).strict().parse(req.body)
    const projectId = routeId(req.params.id)
    await requireAccessibleProject(req.user!.uid, projectId)
    const row = await moveProjectStage(projectId, stage, req.user!.uid, expectedVersion)
    res.json({ ok: true, project: row })
  } catch (err) { next(err) }
})

// 项目评分复用公有线索池同款 score-project Agent，但执行状态由 MySQL
// 租约队列持久化；路由进程不再保存易丢失、不可跨实例协调的 Map。
projectsRouter.post('/:id/score', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.id)
    await requireAccessibleProject(req.user!.uid, projectId)
    const enqueued = await enqueueProjectScoreJob(projectId)
    res.json({ code: 0, message: enqueued ? 'started' : 'running', status: 'running' })
  } catch (err) { next(err) }
})
projectsRouter.get('/:id/score', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.id)
    await requireAccessibleProject(req.user!.uid, projectId)
    const proj = await getProject(projectId)
    if (!proj) { res.status(404).json({ code: 'NOT_FOUND', message: '项目不存在' }); return }
    const job = await getProjectScoreJob(projectId)
    const scoring = (proj as { scoring?: unknown }).scoring
    const status = job && ['queued', 'running', 'retrying'].includes(job.status)
      ? 'running'
      : job?.status === 'dead_letter'
        ? 'failed'
        : scoring || job?.status === 'done'
          ? 'done'
          : 'idle'
    res.json({ code: 0, status, error: job?.last_error ?? undefined, scoring: scoring ?? null })
  } catch (err) { next(err) }
})
projectsRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.id)
    await requireAccessibleProject(req.user!.uid, projectId)
    const row = await deleteProject(projectId, req.user!.uid)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '项目不存在' }); return }
    res.json({ code: 0, message: 'success', deleted: row.id })
  } catch (err) { next(err) }
})
projectsRouter.post('/:id/pin', async (req: AuthedRequest, res, next) => {
  try {
    const { pinned, expectedVersion } = z.object({
      pinned: z.boolean().default(true), expectedVersion: z.number().int().positive(),
    }).strict().parse(req.body ?? {})
    const projectId = routeId(req.params.id)
    await requireAccessibleProject(req.user!.uid, projectId)
    const row = await pinProject(projectId, pinned, req.user!.uid, expectedVersion)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '项目不存在' }); return }
    res.json({ code: 0, message: 'success', pinned: row.pinned, version: row.version })
  } catch (err) { next(err) }
})
projectsRouter.get('/files/all', async (req: AuthedRequest, res, next) => {
  try { const list = await listAllFiles(req.user!.uid); res.json({ list, total: list.length }) } catch (err) { next(err) }
})
projectsRouter.get('/:id/files', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.id)
    await requireAccessibleProject(req.user!.uid, projectId)
    const list = await listFiles(projectId)
    res.json({ list, total: list.length })
  } catch (err) { next(err) }
})

// 真实上传：接收 base64 文件 → 建记录 → 提取正文 → 切块入库（供 AI 检索）
projectsRouter.post('/files/upload', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      projectId: z.string(),
      name: z.string(),
      type: z.string(),
      category: z.string().default('项目资料'),
      uploader: z.string(),
      visibility: z.string().default('项目成员'),
      dataBase64: z.string().min(1),
      force: z.boolean().optional(),
    }).parse(req.body)
    await requireAccessibleProject(req.user!.uid, body.projectId)
    // 查重：同项目下同名文件已存在则拦截（除非 force）
    if (!body.force) {
      const existing = (await listFiles(body.projectId)).find((f) => f.name === body.name)
      if (existing) { res.status(409).json({ code: 'DUPLICATE', message: `「${body.name}」已在该项目资料库中（${existing.parseStatus}），请勿重复录入。如需覆盖请确认。`, existingId: existing.id }); return }
    }
    const validated = await decodeAndValidateProjectFile({ name: body.name, dataBase64: body.dataBase64, declaredType: body.type })
    const buffer = validated.buffer
    const sizeMb = (buffer.length / 1024 / 1024).toFixed(2) + ' MB'
    console.log(`[files/upload] project=${body.projectId} name=${body.name} type=${body.type} size=${sizeMb}`)
    // project_files.type 是 varchar(16)：pptx/xlsx/docx 的浏览器 MIME 长达 60+ 字符会触发
    // PG 22001「value too long」。归一为短标签（优先扩展名，回退 MIME 子类型），并硬截断 16。
    const safeType = validated.typeLabel
    const row = await addFile({
      projectId: body.projectId, name: body.name, type: safeType, category: body.category,
      size: sizeMb, byteSize: validated.byteSize, sha256: validated.sha256,
      uploader: body.uploader, parseStatus: '解析中', visibility: body.visibility,
    } as never, req.user!.uid)
    // 原始字节必须先持久化，资料库下载与后台解析才能共享同一份可信文件。
    // storagePath 只保存相对路径，真实路径被限制在 PROJECT_FILE_ROOT 下。
    let storagePath: string | undefined
    try {
      storagePath = await saveProjectFileRevision(body.projectId, row.id, buffer)
      await setFileStoragePath(row.id, storagePath, req.user!.uid)
    } catch (error) {
      const { deleteFile } = await import('../services/projectService.js')
      await deleteFile(row.id).catch(() => {})
      await removeProjectFile(storagePath).catch(() => {})
      throw error
    }
    // 【上传卡住修复】立即返回(parseStatus='解析中')，正文提取/OCR 放后台异步跑。
    // 原来 await ingestFile 同步等解析完才返回：大 PDF 走 OCR 要几分钟、并行多文件更慢，
    // 前端 fetch 无超时会一直转圈"卡住"。改为不阻塞上传，前端拿到"解析中"即结束上传态，
    // 解析完成后 ingestFile 内部会 UPDATE parse_status→成功/失败，前端刷新/轮询即可看到。
    void ingestFile(row.id, body.projectId, body.name, buffer, validated.contentType)
      .catch((e) => console.error('[ingestFile 后台解析失败]', row.id, body.name, (e as Error).message))
    const { storagePath: _storagePath, ...publicFile } = row
    res.status(201).json({ file: { ...publicFile, hasOriginal: true }, ingest: { ok: true, async: true, status: '解析中' } })
  } catch (err) { next(err) }
})

// 为历史资料补存原始文件：保留原记录、文件 ID、项目归属和已有 RAG 内容，不执行删除。
projectsRouter.post('/files/:id/content', async (req: AuthedRequest, res, next) => {
  try {
    const file = await getFile(routeId(req.params.id))
    if (!file) {
      res.status(404).json({ code: 'NOT_FOUND', message: '资料记录不存在', details: null })
      return
    }
    await requireAccessibleProject(req.user!.uid, file.projectId)
    const body = z.object({
      name: z.string().min(1),
      type: z.string().optional(),
      dataBase64: z.string().min(1),
    }).parse(req.body)
    if (body.name !== file.name) {
      res.status(400).json({ code: 'FILE_NAME_MISMATCH', message: `请选择原文件「${file.name}」`, details: null })
      return
    }
    const validated = await decodeAndValidateProjectFile({ name: body.name, dataBase64: body.dataBase64, declaredType: body.type || file.type })
    const buffer = validated.buffer
    const storagePath = await saveProjectFileRevision(file.projectId, file.id, buffer)
    const size = `${(buffer.length / 1024 / 1024).toFixed(2)} MB`
    const updated = await replaceFileContent(
      file.id, storagePath, size, validated.byteSize, validated.sha256, req.user!.uid,
    ).catch(async (error) => {
      await removeProjectFile(storagePath).catch(() => {})
      throw error
    })
    if (!updated) {
      res.status(404).json({ code: 'NOT_FOUND', message: '资料记录不存在', details: null })
      return
    }
    void ingestFile(file.id, file.projectId, file.name, buffer, validated.contentType)
      .catch((error) => console.error('[补传原文件解析失败]', file.id, file.name, (error as Error).message))
    res.json({ file: updated, ingest: { ok: true, async: true, status: '解析中' } })
  } catch (error) { next(error) }
})

projectsRouter.get('/files/:id/download', async (req: AuthedRequest, res, next) => {
  try {
    const file = await getFile(routeId(req.params.id))
    if (!file) {
      res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在', details: null })
      return
    }
    await requireAccessibleProject(req.user!.uid, file.projectId)
    if (!file.storagePath) {
      res.status(404).json({
        code: 'FILE_CONTENT_NOT_FOUND',
        message: '该历史资料未留存原始文件，请使用”补传原文件”；现有资料记录不会删除',
        details: null,
      })
      return
    }
    const result = await openProjectFile(file.storagePath)
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: '项目资料', action: '下载项目资料',
      target: `project-file:${file.id};project:${file.projectId};version:${file.version};bytes:${result.size}`,
      ip: req.ip,
    })
    res.setHeader('Content-Type', projectFileContentType(file.name))
    res.setHeader('Content-Length', String(result.size))
    res.setHeader('Content-Disposition', contentDisposition(file.name))
    res.setHeader('Cache-Control', 'private, no-store')
    result.stream.on('error', next)
    result.stream.pipe(res)
  } catch (error) { next(error) }
})

projectsRouter.get('/files/:id/preview', async (req: AuthedRequest, res, next) => {
  try {
    const file = await getFile(routeId(req.params.id))
    if (!file) { res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在', details: null }); return }
    await requireAccessibleProject(req.user!.uid, file.projectId)
    if (!file.storagePath) {
      res.status(404).json({ code: 'FILE_CONTENT_NOT_FOUND', message: '该历史资料未留存原始文件', details: null })
      return
    }
    const contentType = projectFilePreviewContentType(file.name)
    if (!contentType) {
      res.status(415).json({ code: 'FILE_PREVIEW_UNSUPPORTED', message: '该格式请下载后使用本地软件查看', details: null })
      return
    }
    const result = await openProjectFile(file.storagePath)
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: '项目资料', action: '预览项目资料',
      target: `project-file:${file.id};project:${file.projectId};version:${file.version};bytes:${result.size}`,
      ip: req.ip,
    })
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', String(result.size))
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:")
    result.stream.on('error', next)
    result.stream.pipe(res)
  } catch (error) { next(error) }
})

projectsRouter.get('/files/:id/versions', async (req: AuthedRequest, res, next) => {
  try {
    const file = await getFile(routeId(req.params.id))
    if (!file) { res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在', details: null }); return }
    await requireAccessibleProject(req.user!.uid, file.projectId)
    res.json({ list: await listFileVersions(file.id), currentVersion: file.version })
  } catch (error) { next(error) }
})

projectsRouter.get('/files/:id/versions/:version/download', async (req: AuthedRequest, res, next) => {
  try {
    const file = await getFile(routeId(req.params.id))
    if (!file) { res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在', details: null }); return }
    await requireAccessibleProject(req.user!.uid, file.projectId)
    const version = z.coerce.number().int().min(1).parse(req.params.version)
    const revision = await getFileVersion(file.id, version)
    if (!revision) { res.status(404).json({ code: 'NOT_FOUND', message: '文件版本不存在', details: null }); return }
    const result = await openProjectFile(revision.storagePath)
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: '项目资料', action: '下载项目资料历史版本',
      target: `project-file:${file.id};project:${file.projectId};version:${version};bytes:${result.size}`,
      ip: req.ip,
    })
    res.setHeader('Content-Type', projectFileContentType(file.name))
    res.setHeader('Content-Length', String(result.size))
    res.setHeader('Content-Disposition', contentDisposition(file.name))
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-File-Version', String(version))
    res.setHeader('X-Content-SHA256', revision.sha256 || '')
    result.stream.on('error', next)
    result.stream.pipe(res)
  } catch (error) { next(error) }
})

projectsRouter.delete('/files/:id', async (req: AuthedRequest, res, next) => {
  try {
    const { deleteFile } = await import('../services/projectService.js')
    const fileId = routeId(req.params.id)
    const file = await getFile(fileId)
    if (!file) { res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在' }); return }
    await requireAccessibleProject(req.user!.uid, file.projectId)
    const ok = await deleteFile(fileId, req.user!.uid)
    if (!ok) { res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在' }); return }
    res.json({ code: 0, message: 'success', deleted: fileId })
  } catch (err) { next(err) }
})
