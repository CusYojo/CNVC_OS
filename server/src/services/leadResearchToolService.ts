import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { leads } from '../db/schema.js'
import { collectCompanyIntel } from './inProcessAiWorkflowService.js'
import {
  verifyLeadPipelineRawEvent,
} from './leadPipelineEventService.js'
import type { PublicIntelResult } from './leadPublicIntelService.js'

export const LEAD_RESEARCH_HOST_TOOLSET_VERSION = 'lead-research-host-tools-v1'
export const LEAD_RESEARCH_HOST_TOOLS = [
  'read_immutable_lead_event',
  'read_existing_lead',
  'search_public_sources',
  'read_source_snippets',
] as const

function clipped(value: unknown, maxLength: number) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.normalize('NFKC').replace(/\u0000/g, '').slice(0, maxLength)
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

export async function readImmutableLeadEvent(eventId: string) {
  const verified = await verifyLeadPipelineRawEvent(eventId)
  if (!verified.exists || !verified.valid || !verified.event) {
    throw new Error(`immutable lead event is missing or invalid: ${eventId}`)
  }
  return {
    id: verified.event.id,
    sourceType: verified.event.sourceType,
    sourceId: verified.event.sourceId,
    contentHash: verified.event.contentHash,
    payload: verified.event.payload,
    sourceOccurredAt: verified.event.sourceOccurredAt,
  }
}

export async function readExistingLeadForResearch(leadId: string) {
  const [lead] = await db.select({
    id: leads.id,
    name: leads.name,
    companyName: leads.companyName,
    industry: leads.industry,
    businessRegion: leads.businessRegion,
    source: leads.source,
    summary: leads.summary,
    highlights: leads.highlights,
    risks: leads.risks,
    team: leads.team,
    fundingRounds: leads.fundingRounds,
    sources: leads.sources,
    radarProfile: leads.radarProfile,
  }).from(leads).where(eq(leads.id, leadId)).limit(1)
  if (!lead) throw new Error(`existing lead not found for research: ${leadId}`)
  return lead
}

export async function searchLeadPublicSources(input: {
  company: string
  topics?: string[]
  contextEvidence?: Array<{ title: string; snippet: string; url: string }>
}) {
  return await collectCompanyIntel(input)
}

export function readLeadSourceSnippets(input: {
  event: Awaited<ReturnType<typeof readImmutableLeadEvent>>
  lead?: Awaited<ReturnType<typeof readExistingLeadForResearch>> | null
  publicIntel?: PublicIntelResult | null
}) {
  const sources: Array<{
    sourceId: string
    sourceType: string
    title: string
    quote: string
    sourceUrl: string
    reliability: string
  }> = []
  const rawPayload = input.event.payload as Record<string, unknown>
  const rawQuote = [rawPayload.title, rawPayload.summary, rawPayload.article_text, rawPayload.articleText]
    .map((value) => clipped(value ?? '', 12_000).trim())
    .filter(Boolean)
    .join('\n') || clipped(rawPayload, 20_000)
  sources.push({
    sourceId: input.event.id,
    sourceType: input.event.sourceType,
    title: clipped(rawPayload.title || input.event.sourceId || '不可变原始事件', 500),
    quote: rawQuote,
    sourceUrl: clipped(rawPayload.link || rawPayload.url || '', 4_000),
    reliability: 'immutable-raw-event',
  })
  for (const [index, item] of objectArray(input.publicIntel?.searchEvidence).entries()) {
    const quote = clipped(item.snippet || '', 8_000).trim()
    const url = clipped(item.url || '', 4_000).trim()
    if (!quote && !url) continue
    sources.push({
      sourceId: `public-search:${index}:${url || clipped(item.title || '', 200)}`,
      sourceType: 'public-search',
      title: clipped(item.title || '公开搜索结果', 500),
      quote,
      sourceUrl: url,
      reliability: clipped(item.reliability || 'unverified-search-snippet', 64),
    })
  }
  for (const [index, item] of objectArray(input.lead?.sources).entries()) {
    const url = clipped(item.url || item.sourceUrl || '', 4_000).trim()
    const quote = clipped(item.excerpt || item.snippet || '', 8_000).trim()
    if (!url && !quote) continue
    sources.push({
      sourceId: `existing-lead-source:${index}:${url || clipped(item.title || '', 200)}`,
      sourceType: 'existing-lead-source',
      title: clipped(item.title || '已有线索来源', 500),
      quote,
      sourceUrl: url,
      reliability: clipped(item.reliability || 'unknown', 64),
    })
  }
  return sources.slice(0, 100)
}

export async function buildLeadResearchHostPackage(input: {
  eventId: string
  company: string
  leadId?: string
  topics?: string[]
  providedPublicIntel?: PublicIntelResult
  publicSearchPerformed?: boolean
}) {
  const event = await readImmutableLeadEvent(input.eventId)
  const lead = input.leadId ? await readExistingLeadForResearch(input.leadId) : null
  const publicIntel = input.providedPublicIntel ?? await searchLeadPublicSources({
    company: input.company,
    topics: input.topics,
    contextEvidence: objectArray(lead?.sources).map((source) => ({
      title: clipped(source.title || '', 500),
      snippet: clipped(source.excerpt || source.snippet || '', 2_000),
      url: clipped(source.url || source.sourceUrl || '', 4_000),
    })).filter((source) => source.title || source.snippet || source.url),
  })
  const sources = readLeadSourceSnippets({ event, lead, publicIntel })
  const hostPackage = {
    contractVersion: LEAD_RESEARCH_HOST_TOOLSET_VERSION,
    allowedTools: LEAD_RESEARCH_HOST_TOOLS,
    immutableEvent: event,
    existingLead: lead,
    sources,
  }
  return {
    ...hostPackage,
    prompt: `以下 JSON 是宿主受控工具生成的唯一输入。不得使用外部知识，不得调用任何工具。\n${clipped(hostPackage, 80_000)}`,
    hostToolCalls: 2
      + (input.leadId ? 1 : 0)
      + (input.providedPublicIntel && input.publicSearchPerformed === false ? 0 : 1),
    publicIntel,
  }
}
