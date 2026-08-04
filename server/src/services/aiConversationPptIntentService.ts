import {
  createAiTask,
  listAiTasks,
  type AiTaskUser,
} from './aiTaskService.js'

export type ConversationContextMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type ConversationPptIntentInput = {
  projectId: string
  conversationId: string
  message: string
  recentMessages: ConversationContextMessage[]
  sourceCutoffDate: string
  idempotencyKey: string
  force?: boolean
  attachmentFileIds?: string[]
  attachmentFileNames?: string[]
}

const PPT_SUBJECT = /(?:\bPPTX?\b|幻灯片|演示文稿|路演材料|投资建议书)/i
const GENERATE_ACTION = /(?:生成|制作|创建|输出|导出|开始做|做一份|做一个|帮我做|整理成|转换成|转成)/i
const CONTEXTUAL_ACTION = /(?:开始生成|现在生成|直接生成|就按(?:这个|上述|以上|刚才的?内容)(?:生成|做)|生成吧|开始做吧|出一份吧)/i
const CHINESE_PAGE_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

function parseChinesePageCount(value: string) {
  if (!value.includes('十')) return CHINESE_PAGE_DIGITS[value]
  const [tensText, onesText] = value.split('十')
  const tens = tensText ? CHINESE_PAGE_DIGITS[tensText] : 1
  const ones = onesText ? CHINESE_PAGE_DIGITS[onesText] : 0
  if (tens === undefined || ones === undefined) return undefined
  return tens * 10 + ones
}

export function extractRequestedPptPageCount(
  message: string,
  recentMessages: ConversationContextMessage[] = [],
) {
  const candidates = [
    message,
    ...recentMessages.slice(-8).reverse().map((item) => item.content),
  ]
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\s+/g, ' ')
    const match = normalized.match(/(?<!第)(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*页(?:版|的)?/)
    if (!match) continue
    const parsed = /^\d+$/.test(match[1])
      ? Number.parseInt(match[1], 10)
      : parseChinesePageCount(match[1])
    if (parsed !== undefined && parsed >= 3 && parsed <= 30) return parsed
  }
  return undefined
}

/**
 * 这里只识别“明确执行”而不是能力咨询。任务创建属于有状态操作，所以
 * “能生成吗 / 如何生成 / 如果我说生成 PPT”必须继续走普通问答。
 */
export function detectConversationPptGenerationIntent(
  message: string,
  recentMessages: ConversationContextMessage[] = [],
) {
  const current = message.replace(/\s+/g, ' ').trim()
  if (!current) return false
  if (/(?:不要|不用|无需|暂不|先不|停止|取消).{0,16}(?:生成|制作|创建|输出|导出|做).{0,16}(?:PPT|幻灯片|演示文稿|投资建议书)/i.test(current)) {
    return false
  }
  if (
    /(?:如果|假如|当).{0,20}(?:说|输入|提到).{0,20}(?:生成|制作).{0,12}(?:PPT|幻灯片|投资建议书)/i.test(current)
    || /(?:我说了|我提到|我在.{0,12}说).{0,20}(?:生成|制作).{0,12}(?:PPT|幻灯片|投资建议书).{0,20}(?:时|的话|没有|没)/i.test(current)
  ) {
    return false
  }
  if (
    /[吗么？?]\s*$/.test(current)
    && /(?:能|会|能不能|能否|可以|是否|支持|怎么|如何|为什么|流程|方法|教程)/.test(current)
  ) {
    return false
  }
  if (PPT_SUBJECT.test(current) && GENERATE_ACTION.test(current)) return true

  const context = recentMessages
    .slice(-8)
    .map((item) => item.content)
    .join('\n')
  return CONTEXTUAL_ACTION.test(current) && PPT_SUBJECT.test(context)
}

export function buildConversationPptInstructions(
  message: string,
  recentMessages: ConversationContextMessage[],
  attachmentFileNames: string[] = [],
) {
  const context = recentMessages
    .slice(-8)
    .map((item) => {
      const role = item.role === 'user' ? '用户' : '助手'
      const content = item.content.replace(/\s+/g, ' ').trim().slice(0, 500)
      return content ? `${role}：${content}` : ''
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 1_450)
  return [
    `本次会话生成要求：${message.replace(/\s+/g, ' ').trim().slice(0, 450)}`,
    attachmentFileNames.length
      ? `本轮上传文件：${attachmentFileNames.slice(0, 10).join('、')}`
      : '',
    context ? `最近对话上下文：\n${context}` : '',
    '请结合当前项目档案、项目资料库、本轮上传文件、最近对话和已核验联网证据生成，并使用系统内置的投资建议书版式。',
  ].filter(Boolean).join('\n').slice(0, 2_000)
}

export async function createInvestmentPptTaskFromConversation(
  user: AiTaskUser,
  input: ConversationPptIntentInput,
) {
  const skillName = 'create-reference-driven-editable-ppt' as const
  if (
    !input.force
    && !detectConversationPptGenerationIntent(input.message, input.recentMessages)
  ) {
    return { matched: false, needsTemplate: false, skillName }
  }

  const existing = (await listAiTasks(user.uid, {
    conversationId: input.conversationId,
    limit: 20,
  })).find((task) =>
    task?.projectId === input.projectId
    && task.type === 'investment_recommendation_ppt'
    && (task.status === 'pending' || task.status === 'running'))
  if (existing) {
    return {
      matched: true,
      needsTemplate: false,
      reused: true,
      skillName,
      task: existing,
    }
  }

  const userInstructions = buildConversationPptInstructions(
    input.message,
    input.recentMessages,
    input.attachmentFileNames,
  )
  const requestedPageCount = extractRequestedPptPageCount(
    input.message,
    input.recentMessages,
  )
  const task = await createAiTask(user, {
    type: 'investment_recommendation_ppt',
    projectId: input.projectId,
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
    parameters: {
      sourceCutoffDate: input.sourceCutoffDate,
      outputFormat: 'PPTX',
      language: '中文',
      structureMode: 'standard',
      pageCount: String(requestedPageCount ?? 17),
      userInstructions,
      researchIntent: userInstructions,
      attachmentFileIds: input.attachmentFileIds ?? [],
      attachmentFileNames: input.attachmentFileNames ?? [],
      conversationTriggered: true,
      // 前端用正式任务自身恢复用户的原始请求。任务创建成功后不再为了显示
      // 一条聊天气泡而重复调用通用 Agent，因此刷新/切换会话后仍需由任务
      // 参数重建这条用户消息。
      conversationPrompt: input.message.replace(/\s+/g, ' ').trim().slice(0, 1_000),
      quickActionSelected: input.force === true,
      requestedSkill: skillName,
    },
  })
  return {
    matched: true,
    needsTemplate: false,
    reused: false,
    skillName,
    task,
  }
}
