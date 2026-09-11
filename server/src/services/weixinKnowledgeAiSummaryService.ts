import { requestAiGatewayText } from './aiGatewayService.js'
import { resolveAiModelByKey } from './aiModelSettingsService.js'
import { extractWeixinKnowledgeSummary } from './weixinKnowledgeExtractionService.js'

export const WEIXIN_SUMMARY_MODEL = 'Doubao-seed-2-0-mini'

type SummaryRoute = { baseUrl: string; apiKey: string; model: string; timeoutMs: number }
type SummaryDependencies = {
  resolveModel: () => Promise<SummaryRoute | null>
  requestText: typeof requestAiGatewayText
}

function summarySource(text: string, limit = 24_000) {
  if (text.length <= limit) return text
  const head = text.slice(0, 12_000)
  const middleStart = Math.max(12_000, Math.floor(text.length / 2) - 3_000)
  return `${head}\n\n[中段]\n${text.slice(middleStart, middleStart + 6_000)}\n\n[末段]\n${text.slice(-6_000)}`
}

export function normalizeWeixinAiSummary(value: string, publisher: string) {
  const clean = value.trim()
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^摘要[：:]\s*/i, '')
    .replace(/\s+/g, ' ')
    .slice(0, 470)
  return clean ? `微信收录 · ${publisher || '公众号'}\n${clean}`.slice(0, 500) : ''
}

export async function summarizeWeixinKnowledge(
  text: string,
  publisher: string,
  dependencies: Partial<SummaryDependencies> = {},
) {
  const fallback = () => extractWeixinKnowledgeSummary(text, publisher)
  try {
    const resolveModel = dependencies.resolveModel || (() => resolveAiModelByKey(WEIXIN_SUMMARY_MODEL))
    const route = await resolveModel()
    if (!route || route.model !== WEIXIN_SUMMARY_MODEL) return fallback()
    const requestText = dependencies.requestText || requestAiGatewayText
    const result = await requestText({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: WEIXIN_SUMMARY_MODEL,
      messages: [
        {
          role: 'system',
          content: '你是企业知识库编辑。仅依据原文，用中文归纳200至400字摘要。直接输出摘要正文，不要标题、列表、Markdown或评价。优先说明主体、核心事项、关键数据、进展、结论与风险；忽略公众号按钮、广告、图片占位、页眉页脚。不得补充原文没有的事实。',
        },
        { role: 'user', content: summarySource(text) },
      ],
      maxTokens: 600,
      timeoutMs: Math.min(route.timeoutMs || 60_000, 90_000),
    })
    return normalizeWeixinAiSummary(result, publisher) || fallback()
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'weixin_knowledge_ai_summary_fallback',
      model: WEIXIN_SUMMARY_MODEL,
      code: String((error as { code?: unknown; status?: unknown }).code
        || (error as { status?: unknown }).status || 'AI_SUMMARY_FAILED').slice(0, 64),
    }))
    return fallback()
  }
}
