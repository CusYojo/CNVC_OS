import { timingSafeEqual } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireAuth, requireSystemAdmin } from '../middleware/requireAuth.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import {
  ingestRadarWechatChatPush,
  listRadarWechatChatGroups,
  listRadarWechatChatMessages,
} from '../services/radarWechatChatService.js'
import { listRadarCandidates, radarCandidateSummary } from '../services/radarSyncService.js'
import {
  queueRadarRuntimeJobNow,
  queueRadarSyncAfterCollection,
} from '../services/runtimeJobScheduler.js'
import {
  listManagedRadarSources,
  listUniversityWechatSources,
  radarWechatOperationalStatus,
  replaceManagedUniversitySources,
} from '../services/radarSourceManagementService.js'
import {
  runRadarArxivCollection,
  runRadarInvestmentCollection,
  runRadarOpenAlexCollection,
  runRadarUniversityWechatRss,
  runRadarWechatCollection,
} from '../services/radarCollectorService.js'
import { db } from '../db/client.js'
import { radarCollectorStates } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { writeAudit } from '../services/auditService.js'
import {
  claimRadarWebhookReceipt,
  releaseRadarWebhookReceipt,
  verifyRadarWebhookSignature,
} from '../services/radarWebhookSecurityService.js'

export const radarRouter = Router()
export const radarInboundRouter = Router()

const optionalText = z.union([z.string(), z.number(), z.null()]).optional()
const chatFileSchema = z.object({
  file_serial_no: optionalText,
  file_name: optionalText,
  file_url: optionalText,
}).passthrough()
const chatMessageSchema = z.object({
  msg_key: optionalText,
  group_name: optionalText,
  group_serial_no: optionalText,
  sender_name: optionalText,
  sender_serial_no: optionalText,
  cite_content: optionalText,
  msg_time: optionalText,
  send_time: optionalText,
  message_time: optionalText,
  content: optionalText,
  msg_content: optionalText,
  msg_content_decoded: optionalText,
  raw_msg_content: optionalText,
  file: chatFileSchema.nullish(),
  msg_type: z.unknown().optional(),
}).passthrough()
const chatPushSchema = z.object({
  merchant_no: optionalText,
  pushed_at: optionalText,
  messages: z.array(chatMessageSchema).max(10_000).default([]),
}).passthrough()

function sameSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

type RadarWebhookRequest = Request & { rawBody?: Buffer; radarWebhookReceiptHash?: string }

async function requireRadarPushAuth(req: RadarWebhookRequest, res: Response, next: NextFunction) {
  const configured = process.env.RADAR_WECHAT_PUSH_SECRET?.trim() || ''
  const timestamp = String(req.headers['x-radar-webhook-timestamp'] || '').trim()
  const signature = String(req.headers['x-radar-webhook-signature'] || '').trim()
  const suppliedLegacySecret = String(req.headers['x-radar-webhook-secret'] || '').trim()
  try {
    if (timestamp || signature) {
      if (!req.rawBody) {
        throw Object.assign(new Error('雷达推送原始请求体不可用'), { status: 400, code: 'RADAR_WEBHOOK_RAW_BODY_MISSING' })
      }
      const verified = verifyRadarWebhookSignature({
        secret: configured, timestamp, signature, rawBody: req.rawBody,
      })
      await claimRadarWebhookReceipt(verified)
      req.radarWebhookReceiptHash = verified.receiptHash
      next()
      return
    }
    if (suppliedLegacySecret) {
      const legacyAllowed = process.env.RADAR_WECHAT_ALLOW_LEGACY_SECRET?.trim().toLowerCase() === 'true'
      if (legacyAllowed && configured && sameSecret(suppliedLegacySecret, configured)) { next(); return }
      res.status(401).json({
        code: 'RADAR_WEBHOOK_SIGNATURE_REQUIRED',
        message: '雷达推送必须使用时间戳与 HMAC-SHA256 签名',
        details: null,
      })
      return
    }
  } catch (error) {
    next(error)
    return
  }
  // 浏览器内的人工测试仍可使用统一登录会话；外部推送必须配置专用密钥。
  void requireAuth(req, res, next)
}

radarInboundRouter.post('/push', requireRadarPushAuth, async (req: RadarWebhookRequest, res, next) => {
  try {
    const body = chatPushSchema.parse(req.body ?? {})
    res.json(await ingestRadarWechatChatPush({
      merchant_no: body.merchant_no, pushed_at: body.pushed_at, messages: body.messages,
    }))
  } catch (error) {
    if (req.radarWebhookReceiptHash) {
      await releaseRadarWebhookReceipt(req.radarWebhookReceiptHash).catch(() => undefined)
    }
    next(error)
  }
})

async function candidatesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const query = z.object({
      q: z.string().max(500).optional(),
      source: z.string().max(64).optional(),
      source_key: z.string().max(255).optional(),
      group: z.string().max(64).optional(),
      attention_only: z.enum(['true', 'false']).optional(),
      min_score: z.coerce.number().int().min(0).max(100).default(0),
      limit: z.coerce.number().int().min(1).max(500).default(200),
      sort: z.enum(['score', 'collected']).default('score'),
      cursor: z.string().max(1_000).optional(),
    }).parse(req.query)
    res.json(await listRadarCandidates({
      q: query.q, source: query.source, sourceKey: query.source_key, group: query.group,
      attentionOnly: query.attention_only === 'true', minScore: query.min_score,
      limit: query.limit, sort: query.sort, cursor: query.cursor,
    }))
  } catch (error) { next(error) }
}

radarRouter.get('/radar/candidates', candidatesHandler)
radarRouter.get('/candidates', candidatesHandler)

async function summaryHandler(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await radarCandidateSummary()) } catch (error) { next(error) }
}

radarRouter.get('/radar/summary', summaryHandler)
radarRouter.get('/summary', summaryHandler)

radarRouter.get('/wechat-chat/messages', async (req, res, next) => {
  try {
    const query = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      group_name: z.string().max(255).optional(),
      group_serial_no: z.string().max(191).optional(),
      limit: z.coerce.number().int().min(1).max(5_000).default(500),
    }).parse(req.query)
    res.json(await listRadarWechatChatMessages({
      date: query.date, groupName: query.group_name, groupSerialNo: query.group_serial_no, limit: query.limit,
    }))
  } catch (error) { next(error) }
})

radarRouter.get('/wechat-chat/groups', async (req, res, next) => {
  try {
    const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query)
    res.json(await listRadarWechatChatGroups(query.date))
  } catch (error) { next(error) }
})

radarRouter.get('/auto/status', async (_req, res, next) => {
  try {
    const [row] = await db.select().from(radarCollectorStates).where(eq(radarCollectorStates.id, 'auto')).limit(1)
    res.json(row?.state ?? { enabled: false, running: false, storage: 'mysql' })
  } catch (error) { next(error) }
})

radarRouter.post('/auto/run-now', requireSystemAdmin, async (_req, res, next) => {
  try { res.status(202).json(await queueRadarRuntimeJobNow('radar-collect-sync')) } catch (error) { next(error) }
})

radarRouter.get('/wechat/sources', async (_req, res, next) => {
  try { res.json(await listUniversityWechatSources()) } catch (error) { next(error) }
})

radarRouter.post('/wechat/sources', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      sources: z.array(z.object({
        school: z.string().trim().min(1).max(255), province: z.string().max(64).optional(),
        accounts: z.array(z.object({ name: z.string().max(255).optional(), rss_url: z.string().max(2_000).optional() })).optional(),
      })).max(500),
    }).parse(req.body ?? {})
    const result = await replaceManagedUniversitySources(body.sources)
    await writeAudit({
      userId: req.user!.uid,
      userName: req.user!.name,
      module: 'Radar来源',
      action: '替换高校公众号来源',
      target: `来源数量:${body.sources.length}`,
      ip: req.ip,
      requestId: String(res.locals.requestId || ''),
    })
    res.json(result)
  } catch (error) { next(error) }
})

radarRouter.post('/wechat/run', requireSystemAdmin, async (req, res, next) => {
  try {
    const body = z.object({ max_entries_per_feed: z.number().int().min(1).max(100).default(20) }).parse(req.body ?? {})
    const result = await runRadarUniversityWechatRss(AbortSignal.timeout(10 * 60_000), body.max_entries_per_feed)
    res.json({ ...result, syncHandoff: await queueRadarSyncAfterCollection(result) })
  } catch (error) { next(error) }
})

radarRouter.get('/wechat-api/accounts', async (_req, res, next) => {
  try {
    const sources = (await listManagedRadarSources()).filter((source) => source.kind === 'wechat-account')
    const groups = Object.fromEntries([...new Set(sources.map((source) => source.group))]
      .map((group) => [group, sources.filter((source) => source.group === group).length]))
    res.json({ accounts: sources, total: sources.length, groups })
  } catch (error) { next(error) }
})

radarRouter.get('/wechat-api/daily-status', async (_req, res, next) => {
  try {
    const status = await radarWechatOperationalStatus()
    res.json({
      ...status.state, pending_retry_count: status.pending.length,
      pending_retry_samples: status.pending.slice(0, 20), storage: 'mysql',
    })
  } catch (error) { next(error) }
})

radarRouter.get('/wechat-api/source-status', async (req, res, next) => {
  try {
    const query = z.object({
      group: z.string().max(64).optional(), failures_only: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(2_000).default(200),
    }).parse(req.query)
    const status = await radarWechatOperationalStatus()
    let rows = status.sourceRows
    if (query.group) rows = rows.filter((row) => String(row.group || '') === query.group)
    if (query.failures_only === 'true') rows = rows.filter((row) => Boolean(row.error || row.last_error))
    res.json({ summary: { total: rows.length, failures: rows.filter((row) => Boolean(row.error || row.last_error)).length }, total: rows.length, items: rows.slice(0, query.limit) })
  } catch (error) { next(error) }
})

const wechatApiRunSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.number().int().min(1).max(30).default(7),
  groups: z.array(z.string().max(64)).max(20).default([]),
  wx_names: z.array(z.string().max(255)).max(5_000).default([]),
  max_accounts: z.number().int().min(0).max(5_000).default(0),
  limit_per_account: z.number().int().min(1).max(500).default(100),
})

radarRouter.post('/wechat-api/run', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = wechatApiRunSchema.parse(req.body ?? {})
    const result = await runRadarWechatCollection({
      date: body.date, days: body.days, groups: body.groups, wxNames: body.wx_names,
      maxAccounts: body.max_accounts, limit: body.limit_per_account,
    }, AbortSignal.timeout(30 * 60_000))
    await writeAudit({ userId: req.user!.uid, userName: req.user!.name, module: 'Radar采集', action: '单次公众号采集', target: `accounts:${result.accounts ?? 0}`, ip: req.ip, requestId: String(res.locals.requestId || '') })
    res.json({ ...result, syncHandoff: await queueRadarSyncAfterCollection(result) })
  } catch (error) { next(error) }
})
radarRouter.post('/wechat-api/run-yesterday', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = wechatApiRunSchema.parse(req.body ?? {})
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(Date.now() - 86_400_000))
    const result = await runRadarWechatCollection({
      date: body.date || yesterday, days: body.days,
      groups: body.groups.length ? body.groups : ['高校', '机构'], wxNames: body.wx_names,
      maxAccounts: body.max_accounts, limit: body.limit_per_account,
    }, AbortSignal.timeout(30 * 60_000))
    await writeAudit({ userId: req.user!.uid, userName: req.user!.name, module: 'Radar采集', action: '补采公众号历史日', target: `date:${body.date || yesterday};accounts:${result.accounts ?? 0}`, ip: req.ip, requestId: String(res.locals.requestId || '') })
    res.json({ ...result, syncHandoff: await queueRadarSyncAfterCollection(result) })
  } catch (error) { next(error) }
})

radarRouter.get('/investment/sources', async (_req, res, next) => {
  try {
    const sources = (await listManagedRadarSources()).filter((source) => source.kind === 'public-source' && source.group !== '论文')
    const groups = Object.fromEntries([...new Set(sources.map((source) => source.group))]
      .map((group) => [group, sources.filter((source) => source.group === group).length]))
    res.json({ sources, groups, enabled: sources.filter((source) => source.enabled).length })
  } catch (error) { next(error) }
})
radarRouter.post('/investment/run', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      groups: z.array(z.string().max(64)).max(20).default([]),
      max_entries_per_source: z.number().int().min(1).max(60).default(15),
      keyword: z.string().max(200).default('人工智能'),
    }).parse(req.body ?? {})
    const result = await runRadarInvestmentCollection({ groups: body.groups, maxEntriesPerSource: body.max_entries_per_source, keyword: body.keyword }, AbortSignal.timeout(20 * 60_000))
    await writeAudit({ userId: req.user!.uid, userName: req.user!.name, module: 'Radar采集', action: '单次多渠道采集', target: `fetched:${result.fetched ?? 0}`, ip: req.ip, requestId: String(res.locals.requestId || '') })
    res.json(result)
  } catch (error) { next(error) }
})
radarRouter.post('/arxiv/run', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      categories: z.array(z.string().max(32)).max(20).default(['cs.AI', 'cs.CL', 'cs.CV', 'cs.LG']),
      keywords: z.array(z.string().max(100)).max(20).default([]),
      max_results: z.number().int().min(1).max(100).default(20),
      days: z.number().int().min(1).max(90).default(14),
      watch_authors: z.array(z.string().max(255)).max(100).default([]),
    }).parse(req.body ?? {})
    const result = await runRadarArxivCollection({ categories: body.categories, keywords: body.keywords, maxResults: body.max_results, days: body.days, watchAuthors: body.watch_authors }, AbortSignal.timeout(10 * 60_000))
    await writeAudit({ userId: req.user!.uid, userName: req.user!.name, module: 'Radar采集', action: '单次 arXiv 采集', target: `fetched:${result.fetched ?? 0}`, ip: req.ip, requestId: String(res.locals.requestId || '') })
    res.json(result)
  } catch (error) { next(error) }
})

radarRouter.post('/openalex/run', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      query: z.string().max(500).optional(),
      max_results: z.number().int().min(1).max(100).default(50),
      days: z.number().int().min(1).max(90).default(14),
    }).parse(req.body ?? {})
    const result = await runRadarOpenAlexCollection({ query: body.query, maxResults: body.max_results, days: body.days }, AbortSignal.timeout(10 * 60_000))
    await writeAudit({ userId: req.user!.uid, userName: req.user!.name, module: 'Radar采集', action: '单次 OpenAlex 采集', target: `fetched:${result.fetched ?? 0}`, ip: req.ip, requestId: String(res.locals.requestId || '') })
    res.json(result)
  } catch (error) { next(error) }
})
