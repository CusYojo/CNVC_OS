import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import {
  cancelAiTask,
  createAiTask,
  createInvestmentPptPreparationTask,
  deleteAiArtifact,
  failInvestmentPptPreparationTask,
  getAiTask,
  getArtifactDownload,
  getArtifactPreview,
  listAiArtifacts,
  listAiTasks,
  retryAiTask,
  startInvestmentPptTaskAfterPreparation,
  updateInvestmentPptPreparationTask,
} from '../services/aiTaskService.js'
import { listAiTaskTypes } from '../services/aiTemplateCatalog.js'
import { listAiBusinessSkills } from '../services/aiSkillService.js'
import {
  createProjectQaAnswer,
  listProjectQaAnswers,
  PROJECT_QA_CATEGORIES,
} from '../services/aiQaService.js'
import {
  createAiCustomTemplate,
  getAiCustomTemplate,
  listAiCustomTemplates,
} from '../services/aiCustomTemplateService.js'
import {
  completeAiTemplateAnalysisProgress,
  failAiTemplateAnalysisProgress,
  getAiTemplateAnalysisProgress,
  startAiTemplateAnalysisProgress,
  updateAiTemplateAnalysisProgress,
} from '../services/aiTemplateAnalysisProgressService.js'
import { createInvestmentPptTaskFromConversation } from '../services/aiConversationPptIntentService.js'
import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'
import { writeAudit } from '../services/auditService.js'

export const aiTasksRouter = Router()

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD')
const typeSchema = z.enum([
  'compliance_statement',
  'investment_proposal',
  'investment_recommendation_ppt',
  'due_diligence_report',
  'project_qa',
  'custom_template_document',
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
  } else if (cutoff > formatShanghaiDateKey(new Date())) {
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
  if (
    body.type === 'investment_proposal'
    || body.type === 'compliance_statement'
    || body.type === 'investment_recommendation_ppt'
    || body.type === 'project_qa'
  ) {
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
    requireAllowed('language', ['中文'], '首期仅支持中文')
    requireAllowed(
      'structureMode',
      ['standard', 'strict-template'],
      '投资建议书结构模式无效',
    )
  }
  if (body.type === 'due_diligence_report') {
    requireAllowed('diligenceScope', ['商业尽调'], '首期仅支持商业尽调')
  }
  if (body.type === 'custom_template_document') {
    const customTemplateId = body.parameters.customTemplateId
    if (typeof customTemplateId !== 'string' || !z.string().uuid().safeParse(customTemplateId).success) {
      ctx.addIssue({ code: 'custom', path: ['parameters', 'customTemplateId'], message: '上传模板 ID 无效' })
    }
  }
  const expectedOutputFormat = body.type === 'investment_recommendation_ppt'
    ? 'PPTX'
    : body.type === 'custom_template_document'
        ? null
        : 'DOCX'
  if (
    body.type === 'custom_template_document'
    && body.parameters.outputFormat !== 'DOCX'
    && body.parameters.outputFormat !== 'PPTX'
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['parameters', 'outputFormat'],
      message: '上传模板任务输出格式必须为 DOCX 或 PPTX',
    })
  } else if (
    expectedOutputFormat
    && body.parameters.outputFormat !== undefined
    && body.parameters.outputFormat !== expectedOutputFormat
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['parameters', 'outputFormat'],
      message: `该任务输出格式固定为 ${expectedOutputFormat}`,
    })
  }
})

const idSchema = z.string().uuid()
const investmentPptPreparationSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  progressId: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }),
  sourceCutoffDate: dateSchema,
  outputFormat: z.literal('PPTX'),
  language: z.literal('中文'),
  structureMode: z.literal('strict-template'),
  userInstructions: z.string().trim().max(2_000).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).superRefine((body, ctx) => {
  if (body.sourceCutoffDate > formatShanghaiDateKey(new Date())) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourceCutoffDate'],
      message: '资料截止日不能晚于今天',
    })
  }
})
const conversationPptIntentSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid(),
  message: z.string().trim().min(1).max(4_000),
  recentMessages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4_000),
  })).max(12).default([]),
  force: z.boolean().optional().default(false),
  attachmentFileIds: z.array(z.string().uuid()).max(10).default([]),
  attachmentFileNames: z.array(z.string().trim().min(1).max(255)).max(10).default([]),
  sourceCutoffDate: dateSchema,
  idempotencyKey: z.string().trim().min(8).max(128),
}).superRefine((body, ctx) => {
  if (body.sourceCutoffDate > formatShanghaiDateKey(new Date())) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourceCutoffDate'],
      message: '资料截止日不能晚于今天',
    })
  }
})
const qaSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid(),
  category: z.enum(PROJECT_QA_CATEGORIES),
  question: z.string().trim().min(2, '问题至少需要 2 个字符').max(2000, '问题不能超过 2000 个字符'),
  sourceCutoffDate: dateSchema.optional(),
}).superRefine((body, ctx) => {
  if (body.sourceCutoffDate && body.sourceCutoffDate > formatShanghaiDateKey(new Date())) {
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

aiTasksRouter.post('/templates/analyze', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      projectId: z.string().uuid(),
      conversationId: z.string().uuid().optional(),
      name: z.string().trim().min(1).max(255),
      dataBase64: z.string().min(16),
      purpose: z.enum([
        'custom_template_document',
        'investment_recommendation_ppt',
      ]).optional(),
      progressId: z.string().uuid().optional(),
      taskId: z.string().uuid().optional(),
    }).parse(req.body ?? {})
    if (body.taskId && body.purpose !== 'investment_recommendation_ppt') {
      throw Object.assign(new Error('只有投资建议书模板分析可以关联正式任务'), {
        status: 400,
        code: 'INVALID_TEMPLATE_TASK',
      })
    }

    // 兼容没有 progressId 的旧调用方；新版前端使用 progressId 后，上传请求
    // 只负责受理任务，耗时的 PDF 转换在请求结束后继续执行，避免被反向代理超时切断。
    if (!body.progressId) {
      const template = await createAiCustomTemplate(userFrom(req), body)
      res.status(201).json(template)
      return
    }

    const progressId = body.progressId
    const user = userFrom(req)
    if (body.taskId) {
      const task = await updateInvestmentPptPreparationTask(
        user.uid,
        body.taskId,
        { stage: '已接收模板，正在准备分析', progress: 5 },
        {
          projectId: body.projectId,
          conversationId: body.conversationId,
          progressId,
        },
      )
      if (!task) {
        throw Object.assign(new Error('投资建议书任务不存在'), {
          status: 404,
          code: 'TASK_NOT_FOUND',
        })
      }
    }
    const progressRegistration = await startAiTemplateAnalysisProgress({
      id: progressId,
      userId: user.uid,
      projectId: body.projectId,
      taskId: body.taskId,
      fileName: body.name,
      purpose: body.purpose ?? 'custom_template_document',
    })
    if (!progressRegistration.created) {
      res.status(202).json(progressRegistration.progress)
      return
    }
    setImmediate(() => {
      void createAiCustomTemplate(user, body, {
        onProgress: async (update) => {
          await updateAiTemplateAnalysisProgress(progressId, update)
          if (body.taskId) {
            await updateInvestmentPptPreparationTask(
              user.uid,
              body.taskId,
              update,
            )
          }
        },
      }).then(async (template) => {
        if (body.taskId) {
          await startInvestmentPptTaskAfterPreparation(user, body.taskId, {
            id: template.id,
            originalFileName: template.originalFileName,
          })
        }
        await completeAiTemplateAnalysisProgress(progressId, template)
      }).catch(async (error) => {
        const message = (error as Error).message || '模板分析失败'
        await failAiTemplateAnalysisProgress(progressId, message)
        if (body.taskId) {
          await failInvestmentPptPreparationTask(
            user.uid,
            body.taskId,
            message,
          ).catch((taskError) => {
            console.error(
              `[ai-template-analysis] 正式任务失败状态写入未完成 taskId=${body.taskId}`,
              taskError,
            )
          })
        }
        console.error(
          `[ai-template-analysis] 后台模板分析失败 progressId=${progressId}`,
          error,
        )
      })
    })
    res.status(202).json({
      progressId,
      status: 'running',
      stage: '已接收模板，正在准备分析',
      progress: 5,
    })
  } catch (error) {
    next(error)
  }
})

aiTasksRouter.get('/templates/analyze-progress/:id', async (req: AuthedRequest, res, next) => {
  try {
    const progress = await getAiTemplateAnalysisProgress(
      req.user!.uid,
      idSchema.parse(req.params.id),
    )
    if (!progress) {
      res.status(404).json({
        code: 'NOT_FOUND',
        message: '模板分析进度不存在或已过期',
        details: null,
      })
      return
    }
    res.json(progress)
  } catch (error) {
    next(error)
  }
})

aiTasksRouter.get('/templates', async (req: AuthedRequest, res, next) => {
  try {
    const query = z.object({
      projectId: z.string().uuid().optional(),
      conversationId: z.string().uuid().optional(),
    }).parse(req.query)
    res.json({ list: await listAiCustomTemplates(req.user!.uid, query) })
  } catch (error) {
    next(error)
  }
})

aiTasksRouter.get('/templates/:id', async (req: AuthedRequest, res, next) => {
  try {
    const template = await getAiCustomTemplate(req.user!.uid, idSchema.parse(req.params.id))
    if (!template) {
      res.status(404).json({ code: 'NOT_FOUND', message: '上传模板不存在', details: null })
      return
    }
    res.json(template)
  } catch (error) {
    next(error)
  }
})

aiTasksRouter.post('/qa', async (req: AuthedRequest, res, next) => {
  try {
    const body = qaSchema.parse(req.body ?? {})
    const answer = await createProjectQaAnswer(userFrom(req), {
      ...body,
      sourceCutoffDate: body.sourceCutoffDate ?? formatShanghaiDateKey(new Date()),
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

aiTasksRouter.post('/tasks/from-conversation', async (req: AuthedRequest, res, next) => {
  try {
    const body = conversationPptIntentSchema.parse(req.body ?? {})
    const result = await createInvestmentPptTaskFromConversation(userFrom(req), body)
    res.status('task' in result && result.task ? 202 : 200).json(result)
  } catch (error) { next(error) }
})

aiTasksRouter.post('/tasks/preparations/investment-ppt', async (req: AuthedRequest, res, next) => {
  try {
    const body = investmentPptPreparationSchema.parse(req.body ?? {})
    const task = await createInvestmentPptPreparationTask(userFrom(req), body)
    res.status(201).json(task)
  } catch (error) { next(error) }
})

aiTasksRouter.post('/tasks/:id/preparation/fail', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      errorMessage: z.string().trim().min(1).max(2000),
    }).parse(req.body ?? {})
    const task = await failInvestmentPptPreparationTask(
      req.user!.uid,
      idSchema.parse(req.params.id),
      body.errorMessage,
    )
    if (!task) {
      res.status(404).json({ code: 'NOT_FOUND', message: '任务不存在', details: null })
      return
    }
    res.json(task)
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
    const body = z.object({
      idempotencyKey: z.string().trim().min(8).max(128),
      complianceChoice: z.object({
        action: z.enum(['supplement', 'continue_with_gaps']),
        snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
        supplementText: z.string().trim().max(2000).optional(),
      }).strict().optional(),
    }).parse(req.body ?? {})
    const task = await retryAiTask(userFrom(req), idSchema.parse(req.params.id), body.idempotencyKey, body.complianceChoice)
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

aiTasksRouter.delete('/artifacts/:id', async (req: AuthedRequest, res, next) => {
  try {
    const artifact = await deleteAiArtifact(req.user!.uid, idSchema.parse(req.params.id))
    if (!artifact) {
      res.status(404).json({ code: 'NOT_FOUND', message: '交付物不存在或无权删除', details: null })
      return
    }
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: 'AI 智能助手', action: '删除AI交付物',
      target: `ai-artifact:${artifact.id};task:${artifact.taskId};file:${artifact.fileName}`,
      ip: req.ip,
    })
    res.status(204).end()
  } catch (error) { next(error) }
})

aiTasksRouter.get('/artifacts/:id/download', async (req: AuthedRequest, res, next) => {
  try {
    const result = await getArtifactDownload(req.user!.uid, idSchema.parse(req.params.id))
    if (!result) {
      res.status(404).json({ code: 'NOT_FOUND', message: '产物不存在或尚未通过质量检查', details: null })
      return
    }
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: 'AI 智能助手', action: '下载AI产物',
      target: `ai-artifact:${result.artifact.id};task:${result.artifact.taskId};bytes:${result.size}`,
      ip: req.ip,
    })
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
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: 'AI 智能助手', action: '预览AI产物',
      target: `ai-artifact:${result.artifact.id};task:${result.artifact.taskId}`,
      ip: req.ip,
    })
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ fileName: result.artifact.fileName, content: result.content })
  } catch (error) { next(error) }
})
