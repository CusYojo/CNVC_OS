import { z } from 'zod'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { resolveAgentRuntimePolicy } from './aiCapabilityService.js'
import { requestAiGatewayWebSearchText } from './aiGatewayService.js'
import { resolveAiModelByKey, resolveAiModelRoute } from './aiModelSettingsService.js'
import {
  LEAD_COMPANY_INTEL_FIELDS,
  validLeadCompanyIntelValue,
  type LeadCompanyIntelEvidence,
  type LeadCompanyIntelField,
} from './leadCompanyIntelExtractionService.js'

export const LEAD_COMPANY_WEB_SEARCH_METHOD = 'codex-built-in-web-search-v2' as const

export function shouldAttemptLeadCompanyWebSearch(input: {
  priorMethod?: unknown
  priorStatus?: unknown
  missingFields: LeadCompanyIntelField[]
  retry?: boolean
  retryNoMatch?: boolean
  retryMissingIntroduction?: boolean
  companyIntroductionMissing?: boolean
}) {
  if (!input.missingFields.length) return false
  if (input.priorMethod !== LEAD_COMPANY_WEB_SEARCH_METHOD) return true
  if (input.retry) return true
  if (input.retryNoMatch && input.priorStatus === 'no_match') return true
  if (input.retryMissingIntroduction && input.companyIntroductionMissing) return true
  // A partially successful search must not make the remaining requested fields invisible
  // to ordinary follow-up runs. If that follow-up finds nothing, it is stored as no_match
  // and later retries remain opt-in instead of looping on every batch execution.
  return input.priorStatus === 'completed'
}

const responseSchema = z.object({
  companies: z.array(z.object({
    company: z.string().min(2).max(256),
    fields: z.array(z.object({
      field: z.enum(LEAD_COMPANY_INTEL_FIELDS),
      value: z.string().max(2_000),
      sourceUrls: z.array(z.string().url().max(4_000)).max(5),
    }).strict()).max(LEAD_COMPANY_INTEL_FIELDS.length),
  }).strict()).max(20),
}).strict()

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = (fenced || text).trim()
  try { return JSON.parse(candidate) as unknown } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1)) as unknown
    throw new Error('Codex 联网搜索未返回有效 JSON')
  }
}

function identity(value: unknown) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
}

export type CodexCompanyWebSearchResult = {
  company: string
  evidence: LeadCompanyIntelEvidence[]
  sources: Array<{ title: string; url: string; reliability: string }>
}

export async function searchCompaniesWithCodex(input: {
  companies: Array<{ company: string; requestedFields?: LeadCompanyIntelField[] }>
  model?: string
}): Promise<{ results: CodexCompanyWebSearchResult[]; model: string; error?: string }> {
  const companies = input.companies.slice(0, 20).map((item) => ({
    company: item.company.normalize('NFKC').trim(),
    requestedFields: [...new Set(item.requestedFields || LEAD_COMPANY_INTEL_FIELDS)],
  }))
  if (!companies.length) return { results: [], model: input.model || process.env.LLM_MODEL || 'gpt-5.6-sol' }
  const policy = await resolveAgentRuntimePolicy('ai-document')
  const configured = input.model
    ? await resolveAiModelByKey(input.model)
    : await resolveAiModelRoute(policy.modelRouteKey)
  const model = (configured?.model || input.model || process.env.LLM_MODEL || 'gpt-5.6-sol')
    .replace(/^zeelin-oai\//, '').replace(/^zeelin\//, '')
  const apiKey = configured?.apiKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''
  const baseUrl = configured?.baseUrl || process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1'
  if (!apiKey) throw new Error('未配置 LLM_API_KEY/OPENAI_API_KEY')
  try {
    const response = await requestAiGatewayWebSearchText({
      baseUrl,
      apiKey,
      model,
      timeoutMs: Math.min(600_000, Math.max(180_000, policy.timeoutMs, companies.length * 30_000)),
      maxTokens: Math.min(16_000, 1_200 + companies.length * 700),
      maxToolCalls: Math.min(20, Math.max(3, companies.length * 2)),
      messages: [{
        role: 'user',
        content: [
          '你是企业公开信息研究员。对输入中的每个中国公司名称执行有针对性的联网搜索；输入可能是品牌、集团简称或历史名称。',
          '先解析并核实对应的当前工商法律主体，再填写其他字段。companyName必须是来源直接支持的当前工商全称；主体不唯一、主体不一致、冲突或找不到时全部留空。公司介绍用40至300字客观概括主营业务、产品与定位，不写宣传口号。',
          '每个非空字段必须提供1至5个直接来源URL。官网必须是企业自有域名。统一社会信用代码必须为18位。',
          '严格返回单一JSON对象，不要Markdown。格式：{"companies":[{"company":"原样公司名","fields":[{"field":"字段名","value":"值","sourceUrls":["https://直接来源"]}]}]}。',
          `输入：${JSON.stringify(companies)}`,
        ].join('\n'),
      }],
    })
    const parsed = responseSchema.parse(extractJson(response.text))
    const allowedSources = new Map(response.sources.map((source) => [source.url, source]))
    const requested = new Map(companies.map((item) => [identity(item.company), new Set(item.requestedFields)]))
    const results: CodexCompanyWebSearchResult[] = []
    for (const company of parsed.companies) {
      const requestedFields = requested.get(identity(company.company))
      if (!requestedFields) continue
      const evidence: LeadCompanyIntelEvidence[] = []
      for (const field of company.fields) {
        const value = field.value.normalize('NFKC').replace(/\s+/g, ' ').trim()
        if (!value || !requestedFields.has(field.field)) continue
        const sourceUrl = field.sourceUrls.find((url) => allowedSources.has(url)) || ''
        if (!sourceUrl || !validLeadCompanyIntelValue(field.field, value, field.field === 'website' ? value : sourceUrl)) continue
        evidence.push({ field: field.field, value, quote: value, sourceUrl })
      }
      const sourceUrls = [...new Set(evidence.map((item) => item.sourceUrl))]
      results.push({
        company: company.company,
        evidence,
        sources: sourceUrls.map((url) => ({
          title: allowedSources.get(url)?.title || new URL(url).hostname,
          url,
          reliability: 'Codex 内置联网搜索来源，字段已绑定直接 URL',
        })),
      })
    }
    return { results, model }
  } catch (error) {
    return { results: [], model, error: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 2_000) }
  }
}
