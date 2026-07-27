import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import {
  cancelAiTask,
  createAiTask,
  getAiTask,
  getArtifactDownload,
  getArtifactPreview,
  listAiArtifacts,
  listAiTasks,
  retryAiTask,
} from '../services/aiTaskService.js'
import { listAiTaskTypes } from '../services/aiTemplateCatalog.js'
import { listAiBusinessSkills } from '../services/aiSkillService.js'
import {
  createProjectQaAnswer,
  listProjectQaAnswers,
  PROJECT_QA_CATEGORIES,
} from '../services/aiQaService.js'

export const aiTasksRouter = Router()

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD')
const typeSchema = z.enum([
  'compliance_statement',
  'investment_proposal',
  'investment_recommendation_ppt',
  'due_diligence_report',
  'project_qa',
])

const createSchema = z.object({
  type: typeSchema,
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().trim().min(8).max(128),
}).superRefine((body, ctx) => {
  const cutoff = body.parameters.sourceCutoffDate
  if (typeof cutoff !== 'string' || !dateSchema.safeParse(cutoff).success) {
    ctx.addIssue({ code: 'custom', path: ['parameters', 'sourceCutoffDate'], message: '资料截止日必填，格式为 YYYY-MM-DD' })
  } else if (cutoff > new Date().toISOString().slice(0, 10)) {
    ctx.addIssue({ code: 'custom', path: ['parameters', 'sourceCutoffDate'], message: '资料截止日不能晚于今天' })
  }
  const requireText = (field: string, message: string) => {
    if (typeof body.parameters[field] !== 'string' || !String(body.parameters[field]).trim()) {
      ctx.addIssue({ code: 'custom', path: ['parameters', field], message })
    }
  }
  const requireAllowed = (field: string, allowed: string[], message: string) => {
    requireText(field, message)
    if (typeof body.parameters[field] === 'string' && !allowed.includes(body.parameters[field])) {
      ctx.addIssue({ code: 'custom', path: ['parameters', field], message: `${message}；可选值：${allowed.join('、')}` })
    }
  }
  if (body.type === 'investment_proposal') {
    requireAllowed('audience', ['内部立项', '基金内部汇报', '合作方沟通'], '目标受众无效')
    requireAllowed('length', ['精简版', '标准版', '详细版'], '篇幅无效')
    const userInstructions = body.parameters.userInstructions
    if (userInstructions !== undefined) {
      if (typeof userInstructions !== 'string') {
        ctx.addIssue({ code: 'custom', path: ['parameters', 'userInstructions'], message: '补充输入必须为文本' })
      } else if (userInstructions.trim().length > 2000) {
        ctx.addIssue({ code: 'custom', path: ['parameters', 'userInstructions'], message: '补充输入不能超过 2000 字' })
      }
    }
  }
  if (body.type === 'investment_recommendation_ppt') {
    requireAllowed('template', ['公司标准模板'], '公司模板无效')
    requireAllowed('pageCount', ['8-10页', '12-15页', '18-20页'], '建议页数无效')
    requireAllowed('language', ['中文'], '首期仅支持中文')
  }
  if (body.type === 'due_diligence_report') {
    requireAllowed('diligenceScope', ['商业尽调'], '首期仅支持商业尽调')
  }
  if (body.type === 'project_qa') {
    requireAllowed('qaMode', ['投资委员会 Q&A', '尽调 Q&A'], 'Q&A 类型无效')
    requireAllowed('questionDepth', ['标准版', '深度版'], '问题深度无效')
  }
  const expectedOutputFormat = body.type === 'investment_recommendation_ppt'
    ? 'PPTX'
    : body.type === 'project_qa'
      ? 'DOCX+PDF'
      : 'DOCX'
  if (body.parameters.outputFormat !== undefined && body.parameters.outputFormat !== expectedOutputFormat) {
    ctx.addIssue({
      code: 'custom',
      path: ['parameters', 'outputFormat'],
      message: `该任务输出格式固定为 ${expectedOutputFormat}`,
    })
  }
})

const idSchema = z.string().uuid()
const qaSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid(),
  category: z.enum(PROJECT_QA_CATEGORIES),
  question: z.string().trim().min(2, '问题至少需要 2 个字符').max(2000, '问题不能超过 2000 个字符'),
  sourceCutoffDate: dateSchema.optional(),
}).superRefine((body, ctx) => {
  if (body.sourceCutoffDate && body.sourceCutoffDate > new Date().toISOString().slice(0, 10)) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourceCutoffDate'],
      message: '资料截止日不能晚于今天',
    })
  }
})

function userFrom(req: AuthedRequest) {
  return { uid: req.user!.uid, name: req.user!.name, role: req.user!.role }
}

function contentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

aiTasksRouter.get('/task-types', (_req, res) => {
  res.json({ list: listAiTaskTypes() })
})

aiTasksRouter.get('/skills', async (_req, res, next) => {
  try {
    res.json({ list: await listAiBusinessSkills() })
  } catch (error) {
    next(error)
  }
})

aiTasksRouter.post('/qa', async (req: AuthedRequest, res, next) => {
  try {
    const body = qaSchema.parse(req.body ?? {})
    const answer = await createProjectQaAnswer(userFrom(req), {
      ...body,
      sourceCutoffDate: body.sourceCutoffDate ?? new Date().toISOString().slice(0, 10),
    })
    res.status(201).json(answer)
  } catch (error) { next(error) }
})

aiTasksRouter.get('/qa', async (req: AuthedRequest, res, next) => {
  try {
    const query = z.object({ conversationId: z.string().uuid() }).parse(req.query)
    const list = await listProjectQaAnswers(req.user!.uid, query.conversationId)
    if (!list) {
      res.status(404).json({ code: 'NOT_FOUND', message: '会话不存在', details: null })
      return
    }
    res.json({ list })
  } catch (error) { next(error) }
})

aiTasksRouter.post('/tasks', async (req: AuthedRequest, res, next) => {
  try {
    const body = createSchema.parse(req.body ?? {})
    const task = await createAiTask(userFrom(req), body)
    res.status(202).json(task)
  } catch (error) { next(error) }
})

aiTasksRouter.get('/tasks', async (req: AuthedRequest, res, next) => {
  try {
    const query = z.object({
      projectId: z.string().uuid().optional(),
      conversationId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query)
    res.json({ list: await listAiTasks(req.user!.uid, query) })
  } catch (error) { next(error) }
})

aiTasksRouter.get('/tasks/:id', async (req: AuthedRequest, res, next) => {
  try {
    const task = await getAiTask(req.user!.uid, idSchema.parse(req.params.id))
    if (!task) {
      res.status(404).json({ code: 'NOT_FOUND', message: '任务不存在', details: null })
      return
    }
    res.json(task)
  } catch (error) { next(error) }
})

aiTasksRouter.post('/tasks/:id/cancel', async (req: AuthedRequest, res, next) => {
  try {
    const task = await cancelAiTask(userFrom(req), idSchema.parse(req.params.id))
    if (!task) {
      res.status(404).json({ code: 'NOT_FOUND', message: '任务不存在', details: null })
      return
    }
    res.json(task)
  } catch (error) { next(error) }
})

aiTasksRouter.post('/tasks/:id/retry', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ idempotencyKey: z.string().trim().min(8).max(128) }).parse(req.body ?? {})
    const task = await retryAiTask(userFrom(req), idSchema.parse(req.params.id), body.idempotencyKey)
    if (!task) {
      res.status(404).json({ code: 'NOT_FOUND', message: '任务不存在', details: null })
      return
    }
    res.status(202).json(task)
  } catch (error) { next(error) }
})

aiTasksRouter.get('/artifacts', async (req: AuthedRequest, res, next) => {
  try {
    const query = z.object({ projectId: z.string().uuid().optional() }).parse(req.query)
    res.json({ list: await listAiArtifacts(req.user!.uid, query.projectId) })
  } catch (error) { next(error) }
})

aiTasksRouter.get('/artifacts/:id/download', async (req: AuthedRequest, res, next) => {
  try {
    const result = await getArtifactDownload(req.user!.uid, idSchema.parse(req.params.id))
    if (!result) {
      res.status(404).json({ code: 'NOT_FOUND', message: '产物不存在或尚未通过质量检查', details: null })
      return
    }
    res.setHeader('Content-Type', result.artifact.mimeType)
    res.setHeader('Content-Length', String(result.size))
    res.setHeader('Content-Disposition', contentDisposition(result.artifact.fileName))
    res.setHeader('Cache-Control', 'private, no-store')
    result.stream.on('error', next)
    result.stream.pipe(res)
  } catch (error) { next(error) }
})

aiTasksRouter.get('/artifacts/:id/preview', async (req: AuthedRequest, res, next) => {
  try {
    const result = await getArtifactPreview(req.user!.uid, idSchema.parse(req.params.id))
    if (!result) {
      res.status(404).json({ code: 'NOT_FOUND', message: '预览不存在或不可用', details: null })
      return
    }
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ fileName: result.artifact.fileName, content: result.content })
  } catch (error) { next(error) }
})
