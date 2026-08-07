import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { FLUE_BASE_URL } from '../config/agentRuntime.js'
import { ingestFile } from '../services/ragService.js'
import { ProjectCreateSchema } from '../schemas/project.js'
import {
  addFile, createProject, finishFileParse, getFile, getProject, listFiles, listProjects, moveProjectStage, replaceFileContent, setFileStoragePath, updateProject, deleteProject, pinProject, listAllFiles } from '../services/projectService.js'
import { openProjectFile, projectFileContentType, removeProjectFile, saveProjectFile } from '../services/projectFileStorageService.js'

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

projectsRouter.get('/', async (req, res, next) => {
  try {
    const args = ListSchema.parse(req.query)
    const data = await listProjects(args)
    res.json(data)
  } catch (err) { next(err) }
})

projectsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getProject(routeId(req.params.id))
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '项目不存在', details: null }); return }
    res.json(row)
  } catch (err) { next(err) }
})

projectsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = ProjectCreateSchema.parse(req.body)
    const row = await createProject(body as never, req.user!.uid)
    res.status(201).json(row)
  } catch (err) { next(err) }
})

projectsRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const row = await updateProject(routeId(req.params.id), req.body, req.user!.uid)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '项目不存在', details: null }); return }
    res.json(row)
  } catch (err) { next(err) }
})

projectsRouter.post('/:id/stage', async (req: AuthedRequest, res, next) => {
  try {
    const { stage, comment } = z.object({ stage: z.string(), comment: z.string().default('') }).parse(req.body)
    const row = await moveProjectStage(routeId(req.params.id), stage, req.user!.uid)
    res.json({ ok: true, project: row })
  } catch (err) { next(err) }
})

// 项目评分：复用公有线索池同款 score-project workflow（7维+竞品+同赛道分位），异步存 projects.scoring
const projScoreStatus = new Map<string, { status: 'running' | 'done' | 'failed'; error?: string; startedAt: number }>()
async function doScoreProject(projectId: string): Promise<void> {
  try {
    const { getProject, listProjects, saveProjectScoring } = await import('../services/projectService.js')
    const proj = await getProject(projectId)
    if (!proj) throw new Error('项目不存在')
    // 读取该项目知识库(RAG)全部资料，作为评分证据 —— 上传的文档必须真正参与评分
    const { db } = await import('../db/client.js')
    const { knowledgeChunks } = await import('../db/schema.js')
    const { and, eq } = await import('drizzle-orm')
    const chunks = await db.select().from(knowledgeChunks).where(and(eq(knowledgeChunks.scope, 'project'), eq(knowledgeChunks.refId, projectId)))
    const kbText = chunks.map((c) => c.content).join('\n').slice(0, 24000)
    const kbSources = [...new Set(chunks.map((c) => c.sourceName).filter(Boolean))]
    const summaryWithKb = [proj.summary ?? '', kbText ? `\n\n=== 知识库资料(项目已上传文档/纪要，评分请以此为准) ===\n${kbText}` : ''].filter(Boolean).join('')
    const resp = await fetch(`${FLUE_BASE_URL}/workflows/score-project?wait=result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName: proj.name,
        industry: proj.industry ?? undefined,
        round: proj.round ?? undefined,
        valuation: proj.valuation ?? undefined,
        financing: proj.financing ?? undefined,
        summary: summaryWithKb || undefined,
        team: proj.team ?? undefined,
        sources: kbSources.length ? kbSources : undefined,
      }),
      signal: AbortSignal.timeout(600000),
    })
    if (!resp.ok) throw new Error(`评分服务 ${resp.status}`)
    const { result } = await resp.json() as { result?: { total: number; verdict: string; overall_comment: string; dimensions: unknown[] } }
    if (!result) throw new Error('评分服务返回空')
    // 同赛道分位：与同 industry 的已评分项目比
    const all = await listProjects({ page: 1, pageSize: 500 })
    const peers = (all.list as Array<{ industry?: string; id: string; scoring?: { total?: number } }>).filter((p) => p.industry === proj.industry && p.id !== projectId && p.scoring?.total != null).map((p) => p.scoring!.total as number)
    const allScores = [...peers, result.total].sort((a, b) => b - a)
    const rankIndex = allScores.indexOf(result.total)
    const percentile = allScores.length > 1 ? Math.round((1 - rankIndex / (allScores.length - 1)) * 100) : 100
    const scoring = { ...result, rank: { peers_count: allScores.length, position: rankIndex + 1, percentile, industry: proj.industry ?? '未分类' }, scored_at: new Date().toISOString() }
    await saveProjectScoring(projectId, scoring, result.total)
    projScoreStatus.set(projectId, { status: 'done', startedAt: projScoreStatus.get(projectId)?.startedAt ?? Date.now() })
  } catch (err) {
    projScoreStatus.set(projectId, { status: 'failed', error: (err as Error).message, startedAt: projScoreStatus.get(projectId)?.startedAt ?? Date.now() })
  }
}
projectsRouter.post('/:id/score', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = routeId(req.params.id)
    const cur = projScoreStatus.get(projectId)
    if (cur?.status === 'running') { res.json({ code: 0, message: 'running', status: 'running' }); return }
    projScoreStatus.set(projectId, { status: 'running', startedAt: Date.now() })
    void doScoreProject(projectId)
    res.json({ code: 0, message: 'started', status: 'running' })
  } catch (err) { next(err) }
})
projectsRouter.get('/:id/score', async (req, res, next) => {
  try {
    const { getProject } = await import('../services/projectService.js')
    const projectId = routeId(req.params.id)
    const proj = await getProject(projectId)
    if (!proj) { res.status(404).json({ code: 'NOT_FOUND', message: '项目不存在' }); return }
    const st = projScoreStatus.get(projectId)
    const scoring = (proj as { scoring?: unknown }).scoring
    res.json({ code: 0, status: scoring ? 'done' : (st?.status ?? 'idle'), error: st?.error, scoring: scoring ?? null })
  } catch (err) { next(err) }
})
projectsRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const row = await deleteProject(routeId(req.params.id), req.user!.uid)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '项目不存在' }); return }
    res.json({ code: 0, message: 'success', deleted: row.id })
  } catch (err) { next(err) }
})
projectsRouter.post('/:id/pin', async (req: AuthedRequest, res, next) => {
  try {
    const pinned = req.body?.pinned !== false
    const row = await pinProject(routeId(req.params.id), pinned, req.user!.uid)
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: '项目不存在' }); return }
    res.json({ code: 0, message: 'success', pinned: row.pinned })
  } catch (err) { next(err) }
})
projectsRouter.get('/files/all', async (_req, res, next) => {
  try { const list = await listAllFiles(); res.json({ list, total: list.length }) } catch (err) { next(err) }
})
projectsRouter.get('/:id/files', async (req, res, next) => {
  try {
    const projectId = routeId(req.params.id)
    const list = await listFiles(projectId)
    res.json({ list, total: list.length })
  } catch (err) { next(err) }
})

const FileSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  type: z.string(),
  category: z.string(),
  size: z.string().optional(),
  uploader: z.string(),
  parseStatus: z.string().default('解析中'),
  visibility: z.string().default('项目成员'),
})

projectsRouter.post('/files', async (req: AuthedRequest, res, next) => {
  try {
    const body = FileSchema.parse(req.body)
    const row = await addFile(body as never, req.user!.uid)
    res.status(201).json(row)
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
    // 查重：同项目下同名文件已存在则拦截（除非 force）
    if (!body.force) {
      const existing = (await listFiles(body.projectId)).find((f) => f.name === body.name)
      if (existing) { res.status(409).json({ code: 'DUPLICATE', message: `「${body.name}」已在该项目资料库中（${existing.parseStatus}），请勿重复录入。如需覆盖请确认。`, existingId: existing.id }); return }
    }
    const buffer = Buffer.from(body.dataBase64, 'base64')
    const sizeMb = (buffer.length / 1024 / 1024).toFixed(2) + ' MB'
    console.log(`[files/upload] project=${body.projectId} name=${body.name} type=${body.type} size=${sizeMb}`)
    // project_files.type 是 varchar(16)：pptx/xlsx/docx 的浏览器 MIME 长达 60+ 字符会触发
    // PG 22001「value too long」。归一为短标签（优先扩展名，回退 MIME 子类型），并硬截断 16。
    const extLabel = (body.name.split('.').pop() || '').toUpperCase()
    const rawType = extLabel && extLabel.length <= 8 ? extLabel : (body.type.split('/')[1] || body.type)
    const safeType = (rawType || 'FILE').slice(0, 16)
    const row = await addFile({
      projectId: body.projectId, name: body.name, type: safeType, category: body.category,
      size: sizeMb, uploader: body.uploader, parseStatus: '解析中', visibility: body.visibility,
    } as never, req.user!.uid)
    // 原始字节必须先持久化，资料库下载与后台解析才能共享同一份可信文件。
    // storagePath 只保存相对路径，真实路径被限制在 PROJECT_FILE_ROOT 下。
    let storagePath: string | undefined
    try {
      storagePath = await saveProjectFile(body.projectId, row.id, buffer)
      await setFileStoragePath(row.id, storagePath)
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
    void ingestFile(row.id, body.projectId, body.name, buffer, body.type)
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
    const body = z.object({
      name: z.string().min(1),
      type: z.string().optional(),
      dataBase64: z.string().min(1),
    }).parse(req.body)
    if (body.name !== file.name) {
      res.status(400).json({ code: 'FILE_NAME_MISMATCH', message: `请选择原文件「${file.name}」`, details: null })
      return
    }
    const buffer = Buffer.from(body.dataBase64, 'base64')
    if (buffer.length > 100 * 1024 * 1024) {
      res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: '文件不能超过 100MB', details: null })
      return
    }
    const storagePath = await saveProjectFile(file.projectId, file.id, buffer)
    const size = `${(buffer.length / 1024 / 1024).toFixed(2)} MB`
    const updated = await replaceFileContent(file.id, storagePath, size, req.user!.uid)
    if (!updated) {
      res.status(404).json({ code: 'NOT_FOUND', message: '资料记录不存在', details: null })
      return
    }
    void ingestFile(file.id, file.projectId, file.name, buffer, body.type || file.type)
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
    if (!file.storagePath) {
      res.status(404).json({
        code: 'FILE_CONTENT_NOT_FOUND',
        message: '该历史资料未留存原始文件，请使用“补传原文件”；现有资料记录不会删除',
        details: null,
      })
      return
    }
    const result = await openProjectFile(file.storagePath)
    res.setHeader('Content-Type', projectFileContentType(file.name))
    res.setHeader('Content-Length', String(result.size))
    res.setHeader('Content-Disposition', contentDisposition(file.name))
    res.setHeader('Cache-Control', 'private, no-store')
    result.stream.on('error', next)
    result.stream.pipe(res)
  } catch (error) { next(error) }
})

projectsRouter.delete('/files/:id', async (req: AuthedRequest, res, next) => {
  try {
    const { deleteFile } = await import('../services/projectService.js')
    const fileId = routeId(req.params.id)
    const ok = await deleteFile(fileId)
    if (!ok) { res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在' }); return }
    res.json({ code: 0, message: 'success', deleted: fileId })
  } catch (err) { next(err) }
})

projectsRouter.post('/files/:id/parse-finish', async (req, res, next) => {
  try {
    const row = await finishFileParse(routeId(req.params.id))
    res.json(row)
  } catch (err) { next(err) }
})
