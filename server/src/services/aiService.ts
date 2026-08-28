import { gatewayJson, gatewayText } from './inProcessAiWorkflowService.js'
import { retrieveKnowledge } from './ragService.js'

export async function answerQuestion(question: string, projectName = '当前项目', projectId?: string, userId?: string) {
  const chunks = await retrieveKnowledge(projectId ? 'project' : 'org', projectId, question, 6, userId)
  const sources = [...new Set(chunks.map((chunk) => chunk.fileName).filter(Boolean))]
  const context = chunks.map((chunk, index) => `【资料${index + 1}｜${chunk.fileName}】\n${chunk.content}`).join('\n\n')
  const answer = await gatewayText({
    system: '你是股权投资中台的 AI 投研助手。只能基于用户问题和提供的授权资料作答；资料不足时明确指出缺口，不得编造事实。全文简体中文。',
    prompt: [
      `项目：${projectName}`,
      `问题：${question}`,
      context ? `授权资料：\n${context}` : '授权资料：本次未检索到匹配证据。',
    ].join('\n\n'),
    timeoutMs: 90_000,
  })
  return {
    answer,
    sources,
    confidence: sources.length ? 0.8 : null,
    evidenceCount: sources.length,
    projectName,
    disclaimer: sources.length
      ? 'AI 基于已授权项目资料作答，仅供辅助，不构成最终投资决策。'
      : '未检索到匹配项目证据，AI 仅提供辅助分析，不构成最终投资决策。',
  }
}

export type MeetingTodoSuggestion = {
  title: string
  owner?: string | null
  dueDate?: string | null
  priority?: '高' | '中' | '低' | null
}

type Minutes = { summary: string; conclusions: string[]; todos: MeetingTodoSuggestion[]; confidence: number }

function normalizeMeetingTodo(value: unknown): MeetingTodoSuggestion | null {
  if (typeof value === 'string') {
    const title = value.trim()
    return title ? { title } : null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const title = String(record.title || '').trim()
  if (!title) return null
  const priority = ['高', '中', '低'].includes(String(record.priority))
    ? String(record.priority) as MeetingTodoSuggestion['priority']
    : null
  return {
    title,
    owner: typeof record.owner === 'string' && record.owner.trim() ? record.owner.trim() : null,
    dueDate: typeof record.dueDate === 'string' && record.dueDate.trim() ? record.dueDate.trim() : null,
    priority,
  }
}

export async function meetingSummary(transcript: string): Promise<Minutes> {
  try {
    const result = await gatewayJson<Partial<Minutes> & { todos?: unknown[] }>({
      system: '你是投资中台的会议纪要助手。忠实原文，不臆造未提及事实。输出严格 JSON。',
      prompt: `请整理以下会议文本。字段：summary 字符串、conclusions 字符串数组、todos 对象数组、confidence 0到1数字。todos 每项字段为 title、owner、dueDate、priority；原文明确给出负责人或截止日时必须逐字保留，dueDate 统一为 YYYY-MM-DD，未给出则为 null，不得推测；priority 仅可为高、中、低，未给出则为 null。\n\n${transcript}`,
      timeoutMs: 120_000,
    })
    const summary = String(result.summary || '').trim()
    if (!summary) throw new Error('模型未返回有效会议摘要')
    return {
      summary,
      conclusions: Array.isArray(result.conclusions) ? result.conclusions.map(String).slice(0, 8) : [],
      // 兼容仍返回字符串数组的旧模型，并避免把对象用 String() 压成 [object Object]。
      todos: Array.isArray(result.todos)
        ? result.todos.map(normalizeMeetingTodo).filter((item): item is MeetingTodoSuggestion => Boolean(item)).slice(0, 8)
        : [],
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0.5)),
    }
  } catch (error) {
    console.warn('[aiService] meetingSummary failed:', (error as Error).message)
    throw error
  }
}
