import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companyKnowledge, weixinLinkIntakes } from '../db/schema.js'
import { companyKnowledgeAccessCondition } from './projectFileAccessService.js'
import { saveCompanyKnowledge, actOnCompanyKnowledge, getCompanyKnowledge } from './fdeKnowledgeService.js'
import { fetchLeadSourceDocument } from './leadSourceDocumentService.js'
import { recordLeadPipelineRawEvent } from './leadPipelineEventService.js'
import { attachWeixinKnowledgeBody, withWeixinLinkIntake } from '../repositories/mysql/mysqlWeixinLinkIntakeRepository.js'
import { handleWeixinLinkIntake } from './weixinLinkIntakeFlow.js'
import type { LinkIntakeTask } from '../contracts/weixinLinkIntakeContract.js'
import { candidateScore } from './radarCollectorService.js'
import { fetchWeixinBrowserArticle } from './weixinBrowserArticleService.js'

function stableId(value: string) {
  const hex = createHash('sha256').update(value).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function platformLink(path: string) {
  const base = process.env.WEIXIN_INTAKE_PLATFORM_URL?.trim()
  if (!base) return `平台内路径 ${path}`
  try {
    const url = new URL(base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return `平台内路径 ${path}`
    return new URL(path, url).href
  } catch { return `平台内路径 ${path}` }
}

function publicSourceLink(value: string) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

async function storeKnowledge(task: LinkIntakeTask, userId: string) {
  const article = task.article!
  const sourceLink = publicSourceLink(article.url)
  // Only deduplicate against entries the actor can already read. Never expose another author's draft.
  const [existing] = sourceLink ? await db.select({ id: companyKnowledge.id }).from(companyKnowledge)
    .innerJoin(weixinLinkIntakes, eq(weixinLinkIntakes.knowledgeEntryId, companyKnowledge.id)).where(and(
      eq(companyKnowledge.link, sourceLink), eq(companyKnowledge.status, 'published'),
      eq(companyKnowledge.audience, 'company'), companyKnowledgeAccessCondition(userId),
    )).limit(1) : []
  if (existing) return existing.id
  const id = stableId(`weixin-knowledge:${userId}:${article.url}:${article.contentHash}`)
  const saved = await saveCompanyKnowledge(id, userId, {
    clientRequestId: stableId(`${id}:save`), expectedVersion: 0,
    definition: {
      kind: '新闻链接', title: article.title.slice(0, 120),
      summary: `微信收录 · ${article.publisher || '公众号'}\n${article.text.slice(0, 450)}`.slice(0, 500),
      link: sourceLink, audience: 'company', readerIds: [], editorIds: [], fileId: null, fileVersion: null,
    },
  })
  await attachWeixinKnowledgeBody(task.id, userId, id)
  const current = await getCompanyKnowledge(id, userId)
  if (current.entry.status === 'published') return id
  if (current.entry.status !== 'draft') throw Object.assign(new Error('知识条目已归档，请到平台核对'), { code: 'KNOWLEDGE_ARCHIVED' })
  await actOnCompanyKnowledge(id, userId, {
    clientRequestId: stableId(`${id}:publish`), expectedVersion: saved.version,
    action: 'publish', reason: '用户在微信明确选择存入团队知识库',
  })
  return id
}

export async function importWeixinArticleProject(task: LinkIntakeTask, userId: string) {
  const article = task.article!
  const score = candidateScore('微信收录', article.title, article.text)
  const candidate = {
    source: 'weixin_link', source_id: task.id, title: article.title, link: publicSourceLink(article.url),
    article_text: article.text, article_text_length: article.text.length,
    article_markdown: article.markdown || null,
    summary: article.text.slice(0, 1000), source_name: article.publisher || '微信用户收录', source_group: '微信收录',
    submitted_by: userId, knowledge_entry_id: task.knowledgeId || null,
    attention_score: score.score, worth_attention: score.worthAttention, signals: score.signals,
    decision: score.decision, decision_label: score.decision_label, filter_reasons: score.filter_reasons,
  }
  // Same immutable candidate and existing screening/research/entity matching/commit chain as Radar.
  // The dynamic import avoids creating a runtime -> routes -> runtime initialization cycle.
  const { runRadarSyncImport } = await import('../routes/meta.js')
  await runRadarSyncImport({}, userId, [candidate])
  const recorded = await recordLeadPipelineRawEvent({ sourceType: 'radar', sourceId: `weixin_link:${task.id}`, payload: candidate })
  const item = recorded.item
  if (item.status === 'ready' && item.leadId) return { status: 'ready' as const, leadId: item.leadId }
  if (item.status === 'review' || item.status === 'rejected') return { status: item.status, reason: item.decisionReason || undefined }
  throw Object.assign(new Error('线索流程尚未完成，稍后重试'), { code: 'WEIXIN_INTAKE_PIPELINE_FAILED' })
}

type ProcessWeixinLinkIntakeInput = {
  bindingId: string
  userId: string
  messageId: string
  message: string
  onBackgroundComplete?: (reply: string) => Promise<void>
  background?: boolean
}

type ProcessWeixinDocumentIntakeInput = Omit<ProcessWeixinLinkIntakeInput, 'message' | 'background'> & {
  fileName: string
  text: string
  contentHash: string
}

function deferWeixinLinkIntake(input: ProcessWeixinLinkIntakeInput, taskId: string) {
  const run = async (attempt: number) => {
    try {
      const reply = await processWeixinLinkIntake({
        ...input,
        messageId: `background:${taskId}`,
        message: '重试',
        background: true,
      })
      if (reply && input.onBackgroundComplete) await input.onBackgroundComplete(reply)
    } catch (error) {
      if ((error as { code?: string }).code === 'WEIXIN_INTAKE_BUSY' && attempt < 5) {
        const timer = setTimeout(() => void run(attempt + 1), 100 * attempt)
        timer.unref()
        return
      }
      console.error(JSON.stringify({
        event: 'weixin_intake_background_failed',
        taskId,
        code: String((error as { code?: unknown }).code || 'INTAKE_FAILED').slice(0, 64),
      }))
    }
  }
  const timer = setTimeout(() => void run(1), 0)
  timer.unref()
}

export async function processWeixinLinkIntake(input: ProcessWeixinLinkIntakeInput) {
  return withWeixinLinkIntake(input.bindingId, input.userId, input.messageId, (session, save, withResourceLock) => handleWeixinLinkIntake(session, input.messageId, input.message, {
    save,
    fetchArticle: async url => {
      if (process.env.WEIXIN_ARTICLE_PYTHON?.trim()) return fetchWeixinBrowserArticle(url)
      // Force current parsing on this entry point so legacy cached verification pages are not reused.
      const document = await fetchLeadSourceDocument({ url, persist: false, allowedHosts: ['mp.weixin.qq.com'] })
      if (document.text.length > 200000) throw Object.assign(new Error('文章正文过长'), { code: 'SOURCE_TOO_LARGE' })
      return { url, title: document.title || '微信公众号文章', text: document.text, publisher: document.publisher, contentHash: document.contentHash }
    },
    saveKnowledge: task => withResourceLock(task.article!.url, () => storeKnowledge(task, input.userId)),
    importProject: task => importWeixinArticleProject(task, input.userId),
    link: platformLink,
    deferProcessing: input.background ? undefined : taskId => deferWeixinLinkIntake(input, taskId),
  }))
}

export async function processWeixinDocumentIntake(input: ProcessWeixinDocumentIntakeInput) {
  const article = {
    url: `weixin-file://${input.contentHash}`,
    title: input.fileName.slice(0, 120) || '微信文件',
    text: input.text,
    markdown: input.text,
    publisher: '微信文件',
    contentHash: input.contentHash,
  }
  return withWeixinLinkIntake(input.bindingId, input.userId, input.messageId, (session, save, withResourceLock) => handleWeixinLinkIntake(
    session, input.messageId, `[微信文件：${input.fileName}]`, {
      save,
      preparedArticle: article,
      fetchArticle: async () => article,
      saveKnowledge: task => withResourceLock(task.article!.url, () => storeKnowledge(task, input.userId)),
      importProject: task => importWeixinArticleProject(task, input.userId),
      link: platformLink,
      deferProcessing: taskId => deferWeixinLinkIntake({
        bindingId: input.bindingId,
        userId: input.userId,
        messageId: input.messageId,
        message: '重试',
        onBackgroundComplete: input.onBackgroundComplete,
      }, taskId),
    },
  ))
}
