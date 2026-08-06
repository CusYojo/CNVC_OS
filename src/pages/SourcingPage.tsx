import { Bot, CheckCircle2, ExternalLink, FileSpreadsheet, FileUp, FolderInput, Globe2, RefreshCw, ShieldCheck, Sparkles, UploadCloud, UsersRound } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useEffect, useRef, useState } from 'react'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, DataTable, Drawer, FileUpload, Modal, PageHeader, ProgressBar, SearchInput, StatusBadge, TableCell, Tabs } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'
import { apiPost, apiGet } from '../lib/api'
import type { Lead, LeadScoreJobStatus, LeadScoring } from '../types'

// 当前创投新闻来源只有 36氪，因此仅展示具体有效渠道；其他创投媒体恢复后再加入。
const CHANNEL_OPTIONS: string[] = ['36氪', '机构公众号', '高校公众号', '论文']
const INDUSTRY_OPTIONS: string[] = [
  '人工智能', '具身智能/机器人', '半导体/芯片', '前沿技术', '产业升级', '先进制造',
  '企业服务', '医疗健康', '生物医药', '新能源', '新材料', '汽车出行',
  '消费科技', '文化娱乐', '教育', '农业科技',
]
const REGION_OPTIONS: string[] = [
  '北京', '上海', '天津', '重庆',
  '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '广西', '海南',
  '四川', '贵州', '云南', '西藏', '陕西', '甘肃',
  '青海', '宁夏', '新疆', '香港', '澳门', '台湾',
]
const verificationTone = (status: Lead['verificationStatus']) => status === '已核验' ? 'green' : status === '部分核验' ? 'amber' : 'slate'
const ACTIVE_SCORE_JOB_STATUSES: LeadScoreJobStatus[] = ['queued', 'running', 'retrying']
const isScoreJobActive = (status?: LeadScoreJobStatus) => Boolean(status && ACTIVE_SCORE_JOB_STATUSES.includes(status))
const scoreJobLabel = (status?: LeadScoreJobStatus) => status === 'queued'
  ? '排队中…'
  : status === 'retrying'
    ? '自动重试中…'
    : '更新中…'

function SourceLink({ url, children }: { url?: string | null; children: React.ReactNode }) {
  // 容错：来源 url 可能缺失（AI 采集 / 部分线索无链接），无 url 时降级为不可点击的灰色标签，避免 startsWith 崩溃白屏
  if (!url) return <span className="inline-flex items-center gap-1 text-slate-400">{children}</span>
  const external = url.startsWith('http')
  return <a href={url} target={external ? '_blank' : undefined} rel="noreferrer" onClick={(event) => event.stopPropagation()} className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-800 hover:underline">{children}<ExternalLink className="h-3 w-3" /></a>
}

const LEAD_PLACEHOLDERS = new Set([
  '',
  '待核验',
  '待核实',
  '未披露',
  '未披露/待核实',
  '未披露/待验证',
  '未识别/待核实',
  '未公开',
  '待人工确认',
  '待工商核验',
  '主体待确认',
  '融资轮次待核实',
  '不适用',
  '无',
  '-',
  'N/A',
  'null',
])

function meaningfulLeadText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const items = value.map(meaningfulLeadText).filter((item): item is string => Boolean(item))
    return items.length ? items.join('、') : undefined
  }
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim()
  if (LEAD_PLACEHOLDERS.has(text)) return undefined
  if (/(?:未披露|未公开|待核验|待核实|待确认|待验证|待工商核验|通常不公开)/.test(text)) return undefined
  if (/^(?:暂?未|尚未|无法|通常不).*(?:披露|公开|获取|识别|核验|确认|查询)/.test(text)) return undefined
  return text
}

function formatPoolEnteredAt(value?: string) {
  if (!value) return '待确认'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).replace(/\//g, '-')
}

function getLeadIdentity(lead: Lead) {
  const isPaper = lead.radarProfile?.channel === '论文'
  const translatedPaperTitle = isPaper ? meaningfulLeadText(lead.radarProfile?.paperMeta?.titleZh) : undefined
  const companySubject = translatedPaperTitle
    ?? meaningfulLeadText(lead.scoring?.registry?.companyName)
    ?? meaningfulLeadText(lead.companyName)
    ?? meaningfulLeadText(lead.name)
    ?? (isPaper ? '论文标题待翻译' : '公司主体')
  const projectName = translatedPaperTitle
    ?? meaningfulLeadText(lead.radarProfile?.profile?.projectName)
    ?? meaningfulLeadText(lead.scoring?.projectName)
    ?? meaningfulLeadText(lead.name)
    ?? companySubject
  return { companySubject, projectName }
}

function getLeadFundingDisplay(lead: Lead) {
  const researchedRounds = Array.isArray(lead.scoring?.fundingRoundsResearched)
    ? lead.scoring.fundingRoundsResearched
    : []
  const researched = researchedRounds.find((round) => [
    round.round,
    round.date,
    round.amount,
    round.valuation,
    round.investors,
  ].some((value) => meaningfulLeadText(value)))
  if (researched) {
    return {
      round: meaningfulLeadText(researched.round),
      date: meaningfulLeadText(researched.date),
      amount: meaningfulLeadText(researched.amount),
      valuation: meaningfulLeadText(researched.valuation),
      investors: meaningfulLeadText(researched.investors),
      legacy: undefined,
    }
  }

  const profile = lead.radarProfile?.profile
  const radarDisplay = {
    round: meaningfulLeadText(profile?.projectRound),
    date: undefined,
    amount: meaningfulLeadText(profile?.financingAmount),
    valuation: meaningfulLeadText(profile?.latestValuation),
    investors: meaningfulLeadText(profile?.institutions),
    legacy: undefined,
  }
  if (radarDisplay.round || radarDisplay.amount || radarDisplay.valuation || radarDisplay.investors) return radarDisplay

  return {
    round: undefined,
    date: undefined,
    amount: undefined,
    valuation: undefined,
    investors: undefined,
    legacy: meaningfulLeadText(lead.financing),
  }
}

function getLeadBasicFacts(lead: Lead) {
  const funding = getLeadFundingDisplay(lead)
  const registry = lead.scoring?.registry ?? {}
  return [
    ['地区', meaningfulLeadText(lead.region) ?? meaningfulLeadText(registry.regLocation) ?? meaningfulLeadText(registry.registeredAddress)],
    ['行业', meaningfulLeadText(lead.industry)],
    ['融资轮次', funding.round],
    ['融资金额', funding.amount],
    ['最新估值', lead.valuationDisplay?.value ?? funding.valuation],
    ['成立时间', meaningfulLeadText(registry.foundedAt) ?? meaningfulLeadText(lead.foundedAt)],
    ['注册资本', meaningfulLeadText(registry.registeredCapital) ?? meaningfulLeadText(lead.registeredCapital)],
    ['法定代表人', meaningfulLeadText(registry.legalRepresentative) ?? meaningfulLeadText(lead.legalRepresentative)],
    ['注册地址', meaningfulLeadText(registry.registeredAddress) ?? meaningfulLeadText(lead.registeredAddress)],
  ].filter((item): item is [string, string] => Boolean(item[1]))
}

function getUsefulShareholders(lead: Lead) {
  const rows = lead.scoring?.structuredShareholders?.length
    ? lead.scoring.structuredShareholders
    : lead.shareholders ?? []
  return rows
    .map((item) => ({
      name: meaningfulLeadText(item.name),
      percentage: meaningfulLeadText(item.percentage),
      type: meaningfulLeadText(item.type),
      sourceUrl: item.sourceUrl,
    }))
    .filter((item): item is typeof item & { name: string } => Boolean(item.name))
}

function getUsefulCompetitors(lead: Lead) {
  return (lead.scoring?.competitors ?? [])
    .filter((item) => {
      if (item.is_self) return false
      const vstatus = (item as unknown as Record<string, unknown>).verificationStatus as string | undefined
      // 经过完整证据校验的 → 直接通过
      if (vstatus === 'evidence-backed') return true
      // 显式被拒绝的 → 不展示
      if (vstatus === 'rejected') return false
      // 历史数据：有实质竞争依据 + 证据的保留，否则视为空壳丢弃
      const basis = String((item as unknown as Record<string, unknown>).comparisonBasis ?? '').trim()
      const evidence = String((item as unknown as Record<string, unknown>).evidence ?? '').trim()
      if (basis.length < 15 || evidence.length < 10) return false
      // 仅行业层面的弱依据不展示（同属XX行业、均为XX企业等）
      if (/^(同属|均为|同在|都属于|属于同一).{1,10}(行业|领域|赛道|市场|企业|公司)[，。]?$/.test(basis)) return false
      return true
    })
    .map((item) => ({
      ...item,
      name: meaningfulLeadText(item.name),
      tech: meaningfulLeadText(item.tech),
      product: meaningfulLeadText(item.product),
      funding: meaningfulLeadText(item.funding),
      differentiation: meaningfulLeadText(item.differentiation),
    }))
    .filter((item): item is typeof item & { name: string } => Boolean(item.name))
}

function getUsefulFundingRounds(lead: Lead) {
  const rows = lead.scoring?.fundingRoundsResearched?.length
    ? lead.scoring.fundingRoundsResearched
    : lead.fundingRounds ?? []
  return rows
    .map((item) => ({
      round: meaningfulLeadText(item.round),
      date: meaningfulLeadText(item.date),
      amount: meaningfulLeadText(item.amount),
      valuation: meaningfulLeadText(item.valuation),
      investors: meaningfulLeadText(item.investors),
      sourceUrl: item.sourceUrl,
    }))
    .filter((item) => Boolean(item.round || item.date || item.amount || item.valuation || item.investors))
}

function getUsefulTeam(lead: Lead) {
  const rows = lead.scoring?.structuredTeam?.length
    ? lead.scoring.structuredTeam
    : lead.founders ?? []
  return rows
    .map((item) => ({
      name: meaningfulLeadText(item.name),
      title: meaningfulLeadText(item.title),
      background: meaningfulLeadText(item.background),
    }))
    .filter((item): item is typeof item & { name: string } => Boolean(item.name))
}

function normalizedSourceUrlKey(value: unknown) {
  const raw = meaningfulLeadText(value)
  if (!raw) return ''
  try {
    const url = new URL(raw, window.location.origin)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|from$|source$|ref$|refer$|share_|scene$|clicktime$|enterid$)/i.test(key)) {
        url.searchParams.delete(key)
      }
    }
    url.searchParams.sort()
    return url.toString().replace(/\/$/, '').toLocaleLowerCase()
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/$/, '').toLocaleLowerCase()
  }
}

function normalizedSourceTitleKey(value: unknown) {
  const title = meaningfulLeadText(value)
  if (!title || ['公开信息来源', '来源证据', '雷达原文'].includes(title)) return ''
  return title
    .replace(/^(?:36氪|硬氪)?(?:首发|前线)?\s*[|｜丨:：-]\s*/i, '')
    .replace(/[\s“”"'「」『』|｜丨:：,，。！？!?·\-—_]/g, '')
    .toLocaleLowerCase()
}

function getUsefulSources(lead: Lead) {
  const rows = [
    ...(lead.scoring?.researchSources ?? []).map((item) => ({
      title: meaningfulLeadText(item.title) ?? '公开信息来源',
      url: meaningfulLeadText(item.url),
      excerpt: meaningfulLeadText(item.excerpt),
      meta: '公开信息',
    })),
    ...(lead.sources ?? []).map((item) => ({
      title: meaningfulLeadText(item.title) ?? '来源证据',
      url: meaningfulLeadText(item.url),
      excerpt: meaningfulLeadText(item.excerpt),
      meta: [meaningfulLeadText(item.publisher), meaningfulLeadText(item.publishedAt), meaningfulLeadText(item.accessedAt)].filter(Boolean).join(' · '),
    })),
    ...(meaningfulLeadText(lead.radarProfile?.link) ? [{
      title: meaningfulLeadText(lead.radarProfile?.sourceName) ?? '雷达原文',
      url: meaningfulLeadText(lead.radarProfile?.link),
      excerpt: meaningfulLeadText(lead.radarProfile?.thesis),
      meta: [meaningfulLeadText(lead.radarProfile?.sourceGroup), meaningfulLeadText(lead.radarProfile?.publishedAt)].filter(Boolean).join(' · '),
    }] : []),
  ].filter((item): item is typeof item & { url: string } => Boolean(item.url))
  const seenUrls = new Set<string>()
  const seenTitles = new Set<string>()
  return rows.filter((item) => {
    const urlKey = normalizedSourceUrlKey(item.url)
    const titleKey = normalizedSourceTitleKey(item.title)
    if ((urlKey && seenUrls.has(urlKey)) || (titleKey && seenTitles.has(titleKey))) return false
    if (urlKey) seenUrls.add(urlKey)
    if (titleKey) seenTitles.add(titleKey)
    return true
  })
}

function LeadDetailPanel({
  lead,
  detailTab,
  onTabChange,
  onRunScore,
  scoreRefreshing,
}: {
  lead: Lead
  detailTab: string
  onTabChange: (tab: string) => void
  onRunScore: (lead: Lead) => void
  scoreRefreshing: boolean
}) {
  const identity = getLeadIdentity(lead)
  const facts = getLeadBasicFacts(lead)
  const shareholders = getUsefulShareholders(lead)
  const fundingRounds = getUsefulFundingRounds(lead)
  const competitors = getUsefulCompetitors(lead)
  const team = getUsefulTeam(lead)
  const sources = getUsefulSources(lead)
  const paperMeta = lead.radarProfile?.channel === '论文' ? lead.radarProfile.paperMeta : undefined
  const paperAbstractZh = meaningfulLeadText(paperMeta?.abstractZh)
  const summaryText = paperAbstractZh || meaningfulLeadText(lead.summary)
  const website = meaningfulLeadText(lead.scoring?.officialSite) ?? meaningfulLeadText(lead.website)
  const originalPaperTitle = meaningfulLeadText(paperMeta?.titleOriginal) ?? meaningfulLeadText(paperMeta?.title)
  const tabs = [
    { id: 'overview', label: '项目概览' },
    ...(shareholders.length || fundingRounds.length ? [{ id: 'funding', label: '股权融资', count: shareholders.length + fundingRounds.length }] : []),
    ...(team.length ? [{ id: 'team', label: '核心团队', count: team.length }] : []),
    ...(sources.length ? [{ id: 'sources', label: '来源证据', count: sources.length }] : []),
  ]
  const visibleTab = tabs.some((item) => item.id === detailTab) ? detailTab : 'overview'
  const valuationSourceUrl = lead.valuationDisplay?.sourceUrl

  return <div>
    <div className="rounded-xl bg-brand-50 p-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {meaningfulLeadText(lead.industry) && <Badge tone="blue">{lead.industry}</Badge>}
            <Badge tone={verificationTone(lead.verificationStatus)}>{lead.verificationStatus}</Badge>
            <StatusBadge status={lead.status} />
          </div>
          <p className="mt-3 truncate text-lg font-semibold text-slate-900" title={identity.companySubject}>{identity.companySubject}</p>
          {identity.projectName !== identity.companySubject && meaningfulLeadText(identity.projectName) &&
            <p className="mt-1 truncate text-sm text-slate-500" title={identity.projectName}>项目：{identity.projectName}</p>}
          {summaryText && <p className="mt-4 text-sm leading-6 text-brand-900">{summaryText}</p>}
          {paperAbstractZh && lead.summary && <p className="mt-2 text-xs leading-5 text-slate-400 line-clamp-2">{lead.summary}</p>}
          {website && <div className="mt-3 text-xs"><SourceLink url={website}>公司官网</SourceLink></div>}
        </div>
        {lead.analysisStatus === 'ready' &&
          <div className="shrink-0 text-right">
            <p className="text-3xl font-semibold text-brand-700">{lead.score}<span className="ml-1 text-sm font-normal text-brand-400">/ 100</span></p>
            <p className="text-[10px] text-brand-500">AI 综合评分 · 非投决结论</p>
          </div>}
      </div>
    </div>

    <div className="mt-5"><Tabs tabs={tabs} value={visibleTab} onChange={onTabChange} /></div>

    {visibleTab === 'overview' && <div className="mt-5 space-y-5">
      {paperMeta && <section className="rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold text-slate-800">论文信息</h3>
          {paperMeta.pdfUrl && <SourceLink url={paperMeta.pdfUrl}>查看 PDF 原文</SourceLink>}
        </div>
        {originalPaperTitle && <div className="mt-3"><p className="text-xs text-slate-400">英文原题</p><p className="mt-1 text-sm leading-6 text-slate-700">{originalPaperTitle}</p></div>}
        <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
          {paperMeta.authors?.length ? <div><p className="text-xs text-slate-400">作者</p><p className="mt-1 leading-6 text-slate-700">{paperMeta.authors.join('、')}</p></div> : null}
          {paperMeta.categories?.length ? <div><p className="text-xs text-slate-400">分类</p><p className="mt-1 leading-6 text-slate-700">{paperMeta.categories.join('、')}</p></div> : null}
        </div>
      </section>}
      {facts.length > 0 && <section className="rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">基本情况</h3>
          {valuationSourceUrl && <SourceLink url={valuationSourceUrl}>{lead.valuationDisplay?.sourceLabel ?? '估值来源'}</SourceLink>}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-x-6 gap-y-4">
          {facts.map(([label, value]) => <div key={label}>
            <p className="text-xs text-slate-400">{label}</p>
            <p className="mt-1 text-sm font-medium leading-5 text-slate-700">{value}</p>
          </div>)}
        </div>
      </section>}

      <section className="rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-800">竞对信息</h3>
          <span className="text-xs text-slate-400">仅展示有公开证据的直接竞对</span>
        </div>
        {competitors.length > 0 ? <div className="mt-3 space-y-3">
          {competitors.map((item, index) => <div key={`${item.name}-${index}`} className="rounded-lg bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2"><p className="text-sm font-medium text-slate-800">{item.name}</p><Badge tone="green">{item.matchType === 'substitute' ? '替代方案' : '直接竞对'}</Badge></div>
              {item.sourceRef && <SourceLink url={item.sourceUrl}>{item.sourceRef}</SourceLink>}
            </div>
            <div className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
              {item.comparisonBasis && <p><span className="text-slate-400">可比依据：</span>{item.comparisonBasis}</p>}
              {item.tech && <p><span className="text-slate-400">技术：</span>{item.tech}</p>}
              {item.product && <p><span className="text-slate-400">定位：</span>{item.product}</p>}
              {item.funding && <p><span className="text-slate-400">融资：</span>{item.funding}</p>}
              {item.differentiation && <p><span className="text-slate-400">对比：</span>{item.differentiation}</p>}
              {item.evidence && <p><span className="text-slate-400">证据：</span>{item.evidence}</p>}
            </div>
          </div>)}
        </div> : <div className="mt-3 rounded-lg bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
          暂未检索到能同时证明目标客户、使用场景和产品替代关系的可靠竞对。可点击底部“补充公开信息”重新检索；系统不会用同赛道公司凑数。
        </div>}
      </section>

      {lead.scoring?.dimensions?.length ? <section className="rounded-xl border border-brand-200 bg-brand-50/40 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500">一级市场评分（多维度加总）</p>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-bold text-brand-700">{lead.scoring.total}</span>
              <span className="text-sm text-slate-400">/ 100</span>
              {meaningfulLeadText(lead.scoring.verdict) && <Badge tone="blue">{lead.scoring.verdict}</Badge>}
            </div>
          </div>
          <button onClick={() => onRunScore(lead)} disabled={scoreRefreshing} className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs text-brand-700 hover:bg-brand-100 disabled:opacity-50">
            {scoreRefreshing ? '评分中…' : '重新评分'}
          </button>
        </div>
        {meaningfulLeadText(lead.scoring.overall_comment) && <p className="mt-3 text-sm leading-6 text-slate-700">{lead.scoring.overall_comment}</p>}
        <div className="mt-4 grid grid-cols-2 gap-3">
          {lead.scoring.dimensions.map((dimension) => <div key={dimension.key} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-slate-700">{dimension.name}</span>
              <span className="font-semibold text-brand-700">{dimension.score}/{dimension.max}</span>
            </div>
            <div className="mt-2"><ProgressBar value={Math.round((dimension.score / dimension.max) * 100)} /></div>
          </div>)}
        </div>
      </section> : <button onClick={() => onRunScore(lead)} disabled={scoreRefreshing} className="w-full rounded-xl border border-dashed border-brand-300 bg-brand-50/40 p-4 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50">
        {scoreRefreshing ? `AI 评分${scoreJobLabel(lead.scoreJob?.status)}` : lead.scoreJob?.status === 'failed' ? '重新生成 AI 评分' : '开始 AI 评分'}
      </button>}
      {lead.scoreJob?.status === 'failed' &&
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">AI 评分暂未完成。系统已自动重试，仍可点击上方按钮重新生成。</p>}

      {(lead.highlights ?? []).map(meaningfulLeadText).filter(Boolean).length > 0 && <section>
        <h3 className="text-sm font-semibold text-slate-800">投资亮点</h3>
        <div className="mt-3 space-y-2">
          {(lead.highlights ?? []).map(meaningfulLeadText).filter((item): item is string => Boolean(item)).map((item) =>
            <p key={item} className="flex gap-2 text-xs leading-5 text-slate-600"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />{item}</p>)}
        </div>
      </section>}
      {(lead.risks ?? []).map(meaningfulLeadText).filter(Boolean).length > 0 && <section>
        <h3 className="text-sm font-semibold text-slate-800">风险与核验任务</h3>
        <div className="mt-3 space-y-2">
          {(lead.risks ?? []).map(meaningfulLeadText).filter((item): item is string => Boolean(item)).map((item) =>
            <p key={item} className="flex gap-2 text-xs leading-5 text-slate-600"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />{item}</p>)}
        </div>
      </section>}
    </div>}

    {visibleTab === 'funding' && <div className="mt-5 space-y-5">
      {shareholders.length > 0 && <section>
        <h3 className="text-sm font-semibold text-slate-800">过往 / 当前股东</h3>
        <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
          {shareholders.map((item, index) => <div key={`${item.name}-${index}`} className="grid grid-cols-[1.2fr_0.8fr_1fr_auto] gap-3 border-t border-slate-100 px-4 py-3 text-sm first:border-t-0">
            <span className="font-medium text-slate-700">{item.name}</span>
            <span className="text-slate-500">{item.percentage}</span>
            <span className="text-slate-500">{item.type}</span>
            {item.sourceUrl ? <SourceLink url={item.sourceUrl}>来源</SourceLink> : <span />}
          </div>)}
        </div>
      </section>}
      {fundingRounds.length > 0 && <section>
        <h3 className="text-sm font-semibold text-slate-800">融资历史</h3>
        <div className="mt-3 space-y-3">
          {fundingRounds.map((round, index) => <div key={`${round.round}-${round.date}-${index}`} className="rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <div>{round.round && <Badge tone="blue">{round.round}</Badge>}{round.date && <span className="ml-2 text-xs text-slate-400">{round.date}</span>}</div>
              {round.sourceUrl && <SourceLink url={round.sourceUrl}>融资来源</SourceLink>}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
              {round.amount && <div><p className="text-xs text-slate-400">金额</p><p className="mt-1 text-slate-700">{round.amount}</p></div>}
              {round.valuation && <div><p className="text-xs text-slate-400">估值</p><p className="mt-1 text-slate-700">{round.valuation}</p></div>}
              {round.investors && <div><p className="text-xs text-slate-400">投资方</p><p className="mt-1 text-slate-700">{round.investors}</p></div>}
            </div>
          </div>)}
        </div>
      </section>}
    </div>}

    {visibleTab === 'team' && <div className="mt-5 space-y-3">
      {team.map((member, index) => <div key={`${member.name}-${index}`} className="flex gap-4 rounded-xl border border-slate-200 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700"><UsersRound className="h-5 w-5" /></span>
        <div>
          <div className="flex items-center gap-2"><p className="font-medium text-slate-800">{member.name}</p>{member.title && <Badge tone="slate">{member.title}</Badge>}</div>
          {member.background && <p className="mt-2 text-sm leading-6 text-slate-600">{member.background}</p>}
        </div>
      </div>)}
    </div>}

    {visibleTab === 'sources' && <div className="mt-5 space-y-3">
      {sources.map((source) => <div key={source.url} className="rounded-xl border border-slate-200 p-4">
        <div className="flex items-start justify-between gap-3">
          <div><p className="font-medium text-slate-800">{source.title}</p>{source.meta && <p className="mt-1 text-xs text-slate-400">{source.meta}</p>}</div>
          <SourceLink url={source.url}>打开源地址</SourceLink>
        </div>
        {source.excerpt && <p className="mt-3 text-sm leading-6 text-slate-600">{source.excerpt}</p>}
      </div>)}
    </div>}
  </div>
}

export function SourcingPage() {
  const { showToast } = useToast()
  const leads = useAppStore((state) => state.leads)
  const leadPagination = useAppStore((state) => state.leadPagination) || { total: 0, page: 1, pageSize: 50, totalPages: 1 }
  const fetchLeads = useAppStore((state) => state.fetchLeads)
  const fetchLeadStats = useAppStore((state) => state.fetchLeadStats)
  const leadStats = useAppStore((state) => state.leadStats) || { total: 0, verified: 0, highPriority: 0, avgCompleteness: 0 }
  const fetchLeadDetail = useAppStore((state) => state.fetchLeadDetail)
  const mergeLeadLocal = useAppStore((state) => state.mergeLeadLocal)
  const hydrateFromServer = useAppStore((state) => state.hydrateFromServer)
  const addLead = useAppStore((state) => state.addLead)
  const updateLead = useAppStore((state) => state.updateLead)
  const convertLead = useAppStore((state) => state.convertLead)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('')  // '' = 最新, 'score' = 按评分
  const [channel, setChannel] = useState('')  // 渠道筛选（服务端按 radar_profile.channel 精确匹配）
  const [industry, setIndustry] = useState('')  // 行业检索(服务端 ILIKE 模糊匹配)
  const [region, setRegion] = useState('')  // 地区业务标签（服务端按注册地/项目画像匹配）
  const [filtering, setFiltering] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState('')  // 关键词服务端检索(debounce 后)
  const [selected, setSelected] = useState<Lead | null>(null)
  const [convertingLeadId, setConvertingLeadId] = useState<string | null>(null)
  const [enrichingLeadId, setEnrichingLeadId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState('overview')
  const scoringLeadIds = useAppStore((state) => state.scoringLeadIds) || []
  const startScoring = useAppStore((state) => state.startScoring)
  const [showUpload, setShowUpload] = useState(false)
  const [showCollect, setShowCollect] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [collectName, setCollectName] = useState('')
  const [collecting, setCollecting] = useState(false)
  const [upload, setUpload] = useState<{ name: string; progress: number; stage: string } | null>(null)
  const isAuthed = useAuthStore((s) => s.isAuthenticated)
  useEffect(() => { if (isAuthed) hydrateFromServer() }, [isAuthed, hydrateFromServer])
  // 翻页: 监听 page 变化拉分页数据
  // 翻页: 监听 page 变化拉分页数据; 翻页后滚到表格顶部,避免用户迷失在长列表里
  const tableRef = useRef<HTMLDivElement | null>(null)
  // 关键词 debounce:输入停顿 350ms 后触发服务端全库检索,并回到第 1 页
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedQuery(query); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [query])
  useEffect(() => {
    if (!isAuthed) return
    let active = true
    // 渠道、业务标签、排序和关键词检索全部走服务端，避免只筛当前页。
    setFiltering(true)
    void fetchLeads(page, 50, channel, sort, debouncedQuery, '', industry, region)
      .catch((error) => {
        if (active) showToast(`筛选失败：${(error as Error).message}`, 'error')
      })
      .finally(() => {
        if (active) setFiltering(false)
      })
    // 全局统计(顶部卡片,聚合全库)
    void fetchLeadStats()
    // 滚到表格顶部(略低于 PageHeader, 留 80px 缓冲)
    window.scrollTo({ top: (tableRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 80, behavior: 'smooth' })
    return () => { active = false }
  }, [isAuthed, page, sort, debouncedQuery, channel, industry, region, fetchLeads, fetchLeadStats, showToast])

  // 页面刷新后根据数据库里的 scoreJob 接续轮询；服务端会对已在执行的任务去重。
  useEffect(() => {
    if (!isAuthed) return
    for (const lead of leads) {
      if (isScoreJobActive(lead.scoreJob?.status) && !scoringLeadIds.includes(lead.id)) {
        void startScoring(lead.id)
      }
    }
  }, [isAuthed, leads, scoringLeadIds, startScoring])

  const filtered = leads

  const syncRadar = async () => {
    setSyncing(true)
    try {
      const r = await apiPost<{
        ok: boolean
        fetched: number
        reviewed: number
        candidateTotal: number
        pagesFetched: number
        backfillComplete: boolean | null
        created: number
        updated: number
        unchanged: number
        skipped: number
        duplicates: number
        batchDuplicates: number
        databaseDuplicates: number
        filtered: number
        deferred: number
        invalid: number
        aiAccepted: number
        aiRejected: number
        aiReview: number
        aiFailed: number
        scoringIds: string[]
        scoringQueued: number
      }>('/leads/sync-radar', {
        limit: 50,
        incrementalPages: 1,
        backfillPages: 0,
      }, {
        signal: AbortSignal.timeout(10 * 60_000),
      })
      const scoringIds = Array.isArray(r.scoringIds) ? r.scoringIds : []
      if (scoringIds.length) {
        void Promise.all(scoringIds.map((leadId) => startScoring(leadId)))
          .then(() => fetchLeadStats())
      }
      // hydrateFromServer 故意不拉分页线索；同步后回到最新一页并显式重拉列表与统计，
      // 保证新线索（含待分析记录）立即出现在用户当前视野。
      setPage(1)
      await Promise.all([
        fetchLeads(1, 50, channel, sort, debouncedQuery, '', industry, region),
        fetchLeadStats(),
      ])
      const duplicateDetail = r.duplicates
        ? `，重复 ${r.duplicates} 条（本批 ${r.batchDuplicates}，库内历史 ${r.databaseDuplicates}）`
        : ''
      showToast(
        `雷达同步完成：抓取 ${r.fetched} 条，AI 审查 ${r.reviewed} 条，通过 ${r.aiAccepted} 条，拒绝 ${r.aiRejected} 条，待复核 ${r.aiReview} 条${r.aiFailed ? `，审查失败 ${r.aiFailed} 条（保留待重试）` : ''}；新增 ${r.created} 条，更新 ${r.updated} 条，无变化 ${r.unchanged} 条${duplicateDetail}${r.invalid ? `，无效 ${r.invalid} 条` : ''}${scoringIds.length ? `；${scoringIds.length} 条 AI 综合评分正在更新` : ''}；列表与统计已刷新`,
        'success',
      )
    } catch (err) {
      showToast(`雷达同步失败：${(err as Error).message}`, 'error')
    } finally {
      setSyncing(false)
    }
  }

  const runScore = async (lead: Lead) => {
    showToast('AI 评分中（约 2-5 分钟）,可切换项目/页面,回来会自动更新…')
    // 评分状态+轮询全在 store(startScoring),不依赖本组件生命周期,切走再回来不中断
    await startScoring(lead.id)
    // 完成后 store 已 merge 新 scoring 进 leads;若当前正看着这条,刷新 selected 展示
    const fresh = await fetchLeadDetail(lead.id)
    if (fresh) setSelected((prev) => (prev && prev.id === lead.id ? fresh : prev))
  }

  const convertSelectedLead = async () => {
    if (!selected || selected.poolStatus === '已转专属项目') return
    setConvertingLeadId(selected.id)
    try {
      const project = await convertLead(selected.id)
      if (!project) {
        showToast('该线索已转为我的专属项目', 'info')
        return
      }
      setSelected((prev) => prev && prev.id === selected.id
        ? { ...prev, poolStatus: '已转专属项目', convertedProjectId: project.id }
        : prev)
      showToast(`已将「${selected.name}」转为我的专属项目`, 'success')
    } catch (error) {
      showToast(`转为专属项目失败：${(error as Error).message}`, 'error')
    } finally {
      setConvertingLeadId(null)
    }
  }

  const enrichSelectedLead = async () => {
    if (!selected) return
    setEnrichingLeadId(selected.id)
    try {
      const { lead, intel } = await apiPost<{
        lead: Lead
        intel: {
          fundingRounds: unknown[]
          shareholders: unknown[]
          competitors: unknown[]
        }
      }>(`/leads/${selected.id}/enrich-public-info`, {})
      setSelected(lead)
      mergeLeadLocal(selected.id, lead)
      const valuationCount = getUsefulFundingRounds(lead).filter((item) => item.valuation).length
      showToast(
        `公开信息已补充：估值 ${valuationCount ? `${valuationCount} 条` : '未发现明确披露'}，股东 ${intel.shareholders?.length ?? 0} 条，竞对 ${intel.competitors?.length ?? 0} 条`,
        'success',
      )
    } catch (error) {
      showToast(`补充公开信息失败：${(error as Error).message}`, 'error')
    } finally {
      setEnrichingLeadId(null)
    }
  }

  const collectIntel = async () => {
    const company = collectName.trim()
    if (company.length < 2) return showToast('请输入公司全称（至少 2 字）', 'error')
    setCollecting(true)
    try {
      const { lead, intel } = await apiPost<{ lead: { id: string; name: string; score: number; summary: string; sources: Array<{ title: string; url: string; reliability: string; category?: string; excerpt?: string }>; fundingRounds: unknown[] }; intel: { registeredCapital: string; legalRepresentative: string; foundedAt: string; confidence: number } }>(
        '/leads/collect', { company },
      )
      const created = await addLead({
        name: lead.name,
        companyName: company,
        channel: '新闻',
        poolStatus: '公共池',
        source: 'AI 情报采集（必应公开信息）',
        sourceUrl: (lead.sources[0]?.url) ?? '',
        industry: '待人工确认',
        round: '未披露',
        region: '待核验',
        website: '待核验',
        foundedAt: intel.foundedAt || '待核验',
        registeredCapital: intel.registeredCapital || '待核验',
        legalRepresentative: intel.legalRepresentative || '待核验',
        creditCode: '待工商核验',
        registrationStatus: '待工商核验',
        registeredAddress: '待核验',
        companyType: '待核验',
        score: lead.score,
        completeness: Math.round((intel.confidence ?? 0) * 100),
        verificationStatus: '待核验',
        lastVerifiedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        riskTags: [],
        status: lead.score > 0 ? '成功' : '待处理',
        summary: lead.summary,
        team: intel.legalRepresentative && intel.legalRepresentative !== '待核验' ? intel.legalRepresentative : '待核验',
        product: '待核验',
        financing: '待核验',
        highlights: [],
        risks: [],
        suggestion: '公开信息初采，建议人工补充工商与财务核验后再评估。',
        shareholders: [],
        founders: [],
        fundingRounds: [],
        companyNews: [],
        sources: lead.sources.map((x, i) => ({ id: `s-${i}`, title: x.title, url: x.url, publisher: '公开来源', accessedAt: new Date().toLocaleDateString('zh-CN'), category: '权威媒体' as const, reliability: (x.reliability === '高' || x.reliability === '中' ? x.reliability : '待核验') as '高' | '中' | '待核验', excerpt: x.excerpt ?? '' })),
      })
      setShowCollect(false)
      setCollectName('')
      setSelected(created)
      showToast(`已采集「${company}」公开情报并入库（置信度 ${Math.round((intel.confidence ?? 0) * 100)}%）`)
    } catch (err) {
      showToast(`情报采集失败：${(err as Error).message}`, 'error')
    } finally {
      setCollecting(false)
    }
  }

  const parseFile = (file: File) => {
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]?BP.*/i, '') || '新项目线索'
    setUpload({ name: file.name, progress: 8, stage: '正在安全上传文件' })
    const stages = [[28, '提取 BP 文本、表格与图片'], [50, '识别公司、团队与融资信息'], [70, '搜索公开来源并建立证据链'], [90, '生成项目卡片与六维初筛']] as const
    stages.forEach(([progress, stage], index) => window.setTimeout(() => setUpload({ name: file.name, progress, stage }), 450 * (index + 1)))
    window.setTimeout(async () => {
      const created = await addLead({
        name,
        companyName: `${name}（主体待工商核验）`,
        channel: '微信群',
        poolStatus: '公共池',
        source: '用户上传 BP',
        sourceUrl: `/knowledge?file=${encodeURIComponent(file.name)}`,
        industry: '待人工确认',
        round: '未披露',
        region: '待核验',
        website: '待核验',
        foundedAt: '待工商核验',
        registeredCapital: '待工商核验',
        legalRepresentative: '待工商核验',
        creditCode: '待工商核验',
        registrationStatus: '待工商核验',
        registeredAddress: '待工商核验',
        companyType: '待工商核验',
        score: 76,
        completeness: 46,
        verificationStatus: '待核验',
        lastVerifiedAt: new Date().toISOString().slice(0, 10),
        riskTags: ['公开来源不足', '财务待核验'],
        status: '成功',
        summary: '已从企业材料抽取基础项目描述；在连接可靠公开来源前，不将企业自述标记为已核验事实。',
        team: 'BP 中存在团队介绍，姓名、履历、任职和持股关系待逐项核验。',
        product: '已识别产品描述，客户案例与产品指标需要外部证据或原始合同支持。',
        financing: '融资金额与估值未找到可独立核验来源。',
        highlights: ['企业材料已完成结构化', '已自动生成公开信息核验清单', '可在详情中继续补充核验信息'],
        risks: ['公司主体未完成工商核验', '客户与收入信息仅来自企业材料', '融资和估值未找到独立来源'],
        suggestion: '建议先补齐主体、团队、客户和融资四类来源，再决定是否发起初筛审批。',
        shareholders: [{ name: '待工商穿透', percentage: '待核验', type: '未核验' }],
        founders: [{ name: '待核验', title: '创始团队', background: '来自企业材料，待访谈和证明文件核验。' }],
        fundingRounds: [{ round: '未披露', date: '待核验', amount: '未披露', valuation: '未披露', investors: ['待核验'], sourceUrl: `/knowledge?file=${encodeURIComponent(file.name)}` }],
        companyNews: [],
        sources: [{ id: `src-${Date.now()}`, title: file.name, url: `/knowledge?file=${encodeURIComponent(file.name)}`, publisher: '项目方', accessedAt: new Date().toISOString().slice(0, 10), category: '企业材料', reliability: '待核验', excerpt: '用户上传企业材料；其中所有数据默认属于企业自述。' }],
      })
      setUpload({ name: file.name, progress: 100, stage: '解析完成；已标记信息缺口与证据等级' })
      setSelected(created)
      setDetailTab('overview')
      window.setTimeout(() => setShowUpload(false), 600)
      showToast('BP 解析完成；未核验字段已明确标记')
    }, 2300)
  }

  // 旧版详情 JSX 暂留在文件中便于后续删除；运行时只启用上方的精简详情面板。
  const renderLegacyDetail = false as boolean

  return (
    <div>
      <PageHeader title="项目获取池 · 公共线索池" description="按渠道及合伙人关注的行业、地区筛选线索，并优先查看估值、AI 综合评分与更新时间。" actions={<><Button variant="secondary" onClick={syncRadar} loading={syncing}><RefreshCw className="h-4 w-4" />从雷达同步</Button><Button variant="secondary" onClick={() => showToast('批量导入模板已准备')}><FileSpreadsheet className="h-4 w-4" />批量导入</Button><Button onClick={() => { setUpload(null); setShowUpload(true) }}><UploadCloud className="h-4 w-4" />上传 BP</Button></>} />

      <div className="mb-5 grid grid-cols-3 gap-4">
        {([
          ['有效公共池线索', leadStats.total, '已通过入池质量过滤', Globe2, undefined],
          ['已有多源证据', leadStats.verified, '主体明确且至少有 2 条来源', ShieldCheck, undefined],
          ['综合 AI 评分 ≥60', leadStats.highPriority, '100 分制 · 点击按最新综合评分排序', Sparkles, () => { setSort('score'); setPage(1) }],
        ] as [string, string | number, string, typeof Globe2, (() => void) | undefined][]).map(([label, value, note, Icon, onClick]) => { const MetricIcon = Icon; const clickable = !!onClick; return <Card key={String(label)} className={`p-4 ${clickable ? 'cursor-pointer transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md' : ''}`}><div onClick={onClick} role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}><div className="flex items-center justify-between"><p className="text-sm font-medium text-slate-500">{label}</p><span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-600"><MetricIcon className="h-4 w-4" /></span></div><p className="mt-2 text-2xl font-semibold text-ink">{value}</p><p className="mt-1 text-xs text-slate-400">{note}</p></div></Card> })}
      </div>

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput className="w-[340px]" placeholder="全库检索：公司、项目、行业、投资方…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select
            aria-label="渠道筛选"
            className="input w-36"
            value={channel}
            onChange={(event) => { setChannel(event.target.value); setPage(1) }}
          >
            <option value="">全部渠道</option>
            {CHANNEL_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select
            aria-label="行业筛选"
            className="input w-40"
            value={industry}
            onChange={(event) => { setIndustry(event.target.value); setPage(1) }}
          >
            <option value="">全部行业</option>
            {INDUSTRY_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select
            aria-label="地区筛选"
            className="input w-36"
            value={region}
            onChange={(event) => { setRegion(event.target.value); setPage(1) }}
          >
            <option value="">全部地区</option>
            {REGION_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select className="input w-36" value={sort} onChange={(event) => { setSort(event.target.value); setPage(1) }} title="排序方式"><option value="">最新入池</option><option value="score">按 AI 总分↓</option></select>
          {(channel || industry || region) && <button className="text-xs text-brand-600 hover:text-brand-800 hover:underline" onClick={() => { setChannel(''); setIndustry(''); setRegion(''); setPage(1) }}>清空筛选</button>}
          <div className="ml-auto rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            {filtering ? '正在筛选…' : `当前结果 ${leadPagination.total} 条`}
          </div>
        </div>
      </Card>

      <div ref={tableRef}>
        <Card className="overflow-hidden">
        <DataTable headers={['主体名称 / 项目', '行业 / 地区标签', '融资 / 估值', 'AI 综合评分', '入池时间', '详情']}>
          {filtered.map((lead) => {
            const { companySubject } = getLeadIdentity(lead)
            const funding = getLeadFundingDisplay(lead)
            const valuationValue = lead.valuationDisplay?.value ?? funding.valuation
            const financingAmount = funding.amount
            const fundingValue = valuationValue ?? financingAmount
            const fundingValueLabel = valuationValue ? '估值' : financingAmount ? '融资金额' : ''
            const fundingStatus = fundingValue
              ? 'available'
              : lead.valuationDisplay?.status ?? (lead.analysisStatus === 'pending' ? 'pending' : 'unavailable')
            const scoreRefreshing = scoringLeadIds.includes(lead.id) || isScoreJobActive(lead.scoreJob?.status)
            const industryTags = lead.businessTags?.industry?.length ? lead.businessTags.industry : [lead.industry || '待确认']
            const regionTags = lead.businessTags?.region?.length ? lead.businessTags.region : [lead.region || '待确认']
            return <tr key={lead.id} className="hover:bg-slate-50">
              <TableCell><button className="min-w-[240px] text-left" onClick={async () => { setSelected(lead); setDetailTab('overview'); const d = await fetchLeadDetail(lead.id); if (d) setSelected(d) }}><span className="block max-w-[260px] truncate font-medium text-slate-800 hover:text-brand-700" title={companySubject}>{companySubject}</span></button></TableCell>
              <TableCell><div className="flex max-w-[240px] flex-wrap gap-1">{industryTags.slice(0, 2).map((tag) => <Badge key={`industry-${tag}`} tone="blue">{tag}</Badge>)}{regionTags.slice(0, 1).map((tag) => <span key={`region-${tag}`} title={tag === '待确认' ? '暂无可靠地区证据' : [lead.regionSource, lead.regionConfidence && `可信度${lead.regionConfidence}`].filter(Boolean).join(' · ')}><Badge tone={tag === '待确认' ? 'slate' : 'green'}>{tag}</Badge></span>)}</div></TableCell>
              <TableCell><div className="max-w-[200px]">
                {fundingStatus === 'available' && fundingValue
                  ? <p className="truncate font-medium text-slate-700" title={`${fundingValueLabel}：${fundingValue}`}>{fundingValue}</p>
                  : fundingStatus === 'pending' ? <Badge tone="amber">待核验</Badge> : <span className="text-xs text-slate-400">暂无公开融资或估值</span>}
                {(fundingValueLabel || funding.round) && <p className="mt-1 truncate text-xs text-slate-400">{[fundingValueLabel, funding.round].filter(Boolean).join(' · ')}</p>}
              </div></TableCell>
              <TableCell>{scoreRefreshing
                ? <Badge tone={lead.scoreJob?.status === 'retrying' ? 'amber' : 'blue'}>{scoreJobLabel(lead.scoreJob?.status)}</Badge>
                : lead.scoreJob?.status === 'failed'
                ? <Badge tone="amber">待重新生成</Badge>
                : lead.analysisStatus === 'ready'
                ? <div className="w-28"><div className="mb-1 flex items-baseline justify-between"><strong className="text-base text-brand-700">{lead.score}</strong><span className="text-xs text-slate-400">/ 100</span></div><ProgressBar value={Math.max(0, Math.min(100, lead.score))} /></div>
                : <Badge tone="amber">待分析</Badge>}</TableCell>
              <TableCell><span className="whitespace-nowrap text-xs text-slate-500">{formatPoolEnteredAt(lead.poolEnteredAt)}</span></TableCell>
              <TableCell><Button size="sm" variant="secondary" onClick={async () => { setSelected(lead); setDetailTab('overview'); const d = await fetchLeadDetail(lead.id); if (d) setSelected(d) }}>详情</Button></TableCell>
            </tr>
          })}
        </DataTable>
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs text-slate-400">
          <span>第 {leadPagination.page}/{leadPagination.totalPages} 页 · 共 {leadPagination.total} 条 (本页 {filtered.length}) · 详情按需加载完整情报</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(1)} disabled={leadPagination.page <= 1} className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-40 hover:bg-slate-50">« 首页</button>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={leadPagination.page <= 1} className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-40 hover:bg-slate-50">上一页</button>
            <span className="text-slate-500">第 <input type="number" min={1} max={leadPagination.totalPages} value={page} onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1 && v <= leadPagination.totalPages) setPage(v) }} className="w-12 rounded border border-slate-200 px-1 text-center" /> / {leadPagination.totalPages} 页</span>
            <button onClick={() => setPage((p) => Math.min(leadPagination.totalPages, p + 1))} disabled={leadPagination.page >= leadPagination.totalPages} className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-40 hover:bg-slate-50">下一页</button>
            <button onClick={() => setPage(leadPagination.totalPages)} disabled={leadPagination.page >= leadPagination.totalPages} className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-40 hover:bg-slate-50">末页 »</button>
          </div>
          <span>数据仅用于产品演示与初筛，不替代尽调</span>
        </div>
        </Card>
      </div>

      <Modal open={showCollect} title="AI 情报采集" onClose={() => !collecting && setShowCollect(false)}>
        <div className="space-y-4">
          <p className="text-sm leading-6 text-slate-500">输入公司全称，系统将实时检索公开信息（公司简介、工商、融资、动态），由 AI 结构化整理并标注来源。<strong className="text-slate-700">未获取到依据的字段会标注「待核验」，不做推测填充。</strong></p>
          <label className="block"><span className="label">公司全称</span><input className="input mt-1 w-full" placeholder="如：北京旷视科技有限公司" value={collectName} onChange={(e) => setCollectName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') collectIntel() }} /></label>
          {collecting && <div className="flex items-center gap-2 rounded-lg bg-brand-50 p-3 text-sm text-brand-700"><RefreshCw className="h-4 w-4 animate-spin" />正在检索公开信息并结构化，约需 30~90 秒…</div>}
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setShowCollect(false)} disabled={collecting}>取消</Button><Button onClick={collectIntel} loading={collecting}><Sparkles className="h-4 w-4" />开始采集</Button></div>
        </div>
      </Modal>

      <Modal open={showUpload} title="上传并解析 BP" onClose={() => { if (!upload || upload.progress === 100) setShowUpload(false) }}>
        <FileUpload onFile={parseFile} accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" />
        {upload && <div className="mt-5 rounded-xl border border-slate-200 p-4"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-blue-50 text-blue-600"><FileUp className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-slate-700">{upload.name}</p><p className="mt-1 text-xs text-slate-400">{upload.stage}</p></div><span className="text-sm font-medium text-brand-600">{upload.progress}%</span></div><div className="mt-4"><ProgressBar value={upload.progress} tone={upload.progress === 100 ? 'green' : 'blue'} /></div></div>}
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-brand-50 p-3 text-xs leading-5 text-brand-700"><Bot className="mt-0.5 h-4 w-4 shrink-0" />解析结果会先标记为“企业材料 / 待核验”。官网、监管、客户访谈等来源补齐后，才提升核验等级。</div>
      </Modal>

      <Drawer
        open={!!selected}
        title={selected?.name ?? '公司情报'}
        onClose={() => setSelected(null)}
        width="w-[900px]"
        footer={selected && <>
          <Button variant="secondary" onClick={() => { updateLead(selected.id, { lastVerifiedAt: new Date().toISOString().slice(0, 10) }); showToast('已刷新核验时间；源数据未被无依据改写') }}><RefreshCw className="h-4 w-4" />刷新核验</Button>
          <Button
            variant="secondary"
            onClick={enrichSelectedLead}
            loading={enrichingLeadId === selected.id}
            disabled={enrichingLeadId === selected.id}
          >
            <Globe2 className="h-4 w-4" />
            补充公开信息
          </Button>
          <Button
            onClick={convertSelectedLead}
            loading={convertingLeadId === selected.id}
            disabled={selected.poolStatus === '已转专属项目' || convertingLeadId === selected.id}
          >
            <FolderInput className="h-4 w-4" />
            {selected.poolStatus === '已转专属项目' ? '已转为我的专属项目' : '转为我的专属项目'}
          </Button>
        </>}
      >
        {selected && <LeadDetailPanel
          lead={selected}
          detailTab={detailTab}
          onTabChange={setDetailTab}
          onRunScore={runScore}
          scoreRefreshing={scoringLeadIds.includes(selected.id) || isScoreJobActive(selected.scoreJob?.status)}
        />}
        {selected && renderLegacyDetail && <div>
          <div className="rounded-xl bg-brand-50 p-4"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><Badge tone="blue">{selected.industry}</Badge><Badge tone={verificationTone(selected.verificationStatus)}>{selected.verificationStatus}</Badge><StatusBadge status={selected.status} /></div><p className="mt-3 max-w-[600px] truncate text-lg font-semibold text-slate-900" title={getLeadIdentity(selected).companySubject}>{getLeadIdentity(selected).companySubject}</p><p className="mt-1 max-w-[600px] truncate text-sm text-slate-500" title={getLeadIdentity(selected).projectName}>项目：{getLeadIdentity(selected).projectName}</p><p className="mt-1 text-sm text-slate-500">{selected.region} · {selected.round} · 更新于 {selected.lastVerifiedAt}</p></div><div className="text-right"><p className="text-3xl font-semibold text-brand-700">{selected.score}<span className="ml-1 text-sm font-normal text-brand-400">/ 100</span></p><p className="text-[10px] text-brand-500">AI 综合评分 · 非投决结论</p></div></div><p className="mt-4 text-sm leading-6 text-brand-900">{selected.summary}</p><div className="mt-3"><SourceLink url={selected.scoring?.officialSite && selected.scoring.officialSite !== '待核验' ? selected.scoring.officialSite : selected.website}>公司官网</SourceLink></div></div>

          <div className="mt-5"><Tabs tabs={[
            { id: 'overview', label: '项目概览' },
            { id: 'registry', label: '工商信息' },
            { id: 'team', label: '核心团队' },
            { id: 'funding', label: '股权融资' },
            { id: 'news', label: '公司动态', count: (selected.scoring?.structuredNews?.length ?? (selected.companyNews ?? []).length) || undefined },
            { id: 'sources', label: '来源证据', count: (selected.sources ?? []).length || undefined },
          ]} value={detailTab} onChange={setDetailTab} /></div>

          {detailTab === 'overview' && <div className="mt-5 space-y-5">{(selected.scoring && Array.isArray(selected.scoring.dimensions) && selected.scoring.dimensions.length) ? <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-4"><div className="flex items-center justify-between"><div><span className="text-xs text-slate-500">一级市场评分（多维度加总）</span><div className="mt-1 flex items-baseline gap-2"><span className="text-4xl font-bold text-brand-700">{selected.scoring.total}</span><span className="text-sm text-slate-400">/ 100</span><Badge tone={selected.scoring.total >= 80 ? 'green' : selected.scoring.total >= 65 ? 'blue' : selected.scoring.total >= 50 ? 'amber' : 'slate'}>{selected.scoring.verdict}</Badge></div></div><div className="text-right text-xs text-slate-500">{selected.scoring.rank && <div>同赛道分位 <strong className="text-brand-700">{selected.scoring.rank.percentile}%</strong><div className="mt-0.5 text-[10px]">{selected.scoring.rank.industry} · 第 {selected.scoring.rank.position}/{selected.scoring.rank.peers_count}</div></div>}<button onClick={() => runScore(selected)} disabled={scoringLeadIds.includes(selected.id)} className="mt-2 rounded-lg border border-brand-300 px-2.5 py-1 text-[11px] text-brand-700 hover:bg-brand-100 disabled:opacity-50">{scoringLeadIds.includes(selected.id) ? '评分中…' : '重新评分'}</button></div></div><p className="mt-3 text-sm leading-6 text-slate-700">{selected.scoring.overall_comment}</p><div className="mt-4 space-y-3">{selected.scoring.dimensions.map((dim) => <div key={dim.key} className="rounded-lg border border-slate-200 p-3"><div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold text-slate-800">{dim.name}</span><span className="text-sm font-bold text-brand-700">{dim.score}<span className="text-xs font-normal text-slate-400"> / {dim.max}</span></span></div><ProgressBar value={Math.round((dim.score / dim.max) * 100)} /><div className="mt-2 space-y-1.5">{dim.items.map((it) => <div key={it.name} className="grid grid-cols-[1fr_auto] gap-2 border-t border-slate-50 pt-1.5 text-xs"><div><span className="font-medium text-slate-600">{it.name}</span><span className="ml-1 text-slate-400">{it.score}/{it.max}</span><p className="mt-0.5 leading-5 text-slate-400">{it.reason}</p></div></div>)}</div></div>)}</div>{selected.scoring.competitors && selected.scoring.competitors.length > 0 && <div className="mt-4"><h4 className="mb-2 text-sm font-semibold text-slate-800">竞品对标（技术差异化 · 一级市场可投资性）</h4><div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full text-xs"><thead><tr className="bg-slate-50 text-slate-500"><th className="p-2 text-left font-medium">公司</th><th className="p-2 text-left font-medium">技术路线</th><th className="p-2 text-left font-medium">产品/阶段</th><th className="p-2 text-left font-medium">融资/背书</th><th className="p-2 text-left font-medium">差异化 / 可投资性</th></tr></thead><tbody>{selected.scoring.competitors.map((c, ci) => <tr key={`${c.name}-${ci}`} className={`border-t border-slate-100 ${c.is_self ? 'bg-brand-50/50' : ''}`}><td className="p-2 align-top font-medium text-slate-700">{c.is_self && <span className="mr-1 rounded bg-brand-600 px-1 py-0.5 text-[9px] text-white">本项目</span>}{c.name}</td><td className="p-2 align-top leading-5 text-slate-500">{c.tech}</td><td className="p-2 align-top leading-5 text-slate-500">{c.product}</td><td className="p-2 align-top leading-5 text-slate-500">{c.funding}</td><td className="p-2 align-top leading-5 text-slate-500">{c.differentiation}</td></tr>)}</tbody></table></div></div>}</div> : <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-center"><p className="text-sm text-slate-600">尚未按标准评分</p><p className="mt-1 text-xs text-slate-400">点击下方按钮，AI 将依据《赛智伯乐一级市场评分标准》对本项目 7 大维度严格打分，给出总分、各维度得分与原因、同赛道分位排名。</p><button onClick={() => runScore(selected)} disabled={scoringLeadIds.includes(selected.id)} className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">{scoringLeadIds.includes(selected.id) ? 'AI 评分中（约 2-5 分钟）…' : '开始 AI 评分'}</button></div>}{selected.radarProfile && <div className="rounded-xl border border-slate-200 p-4 space-y-4"><div className="flex items-center gap-2"><Badge tone="blue">雷达情报</Badge>{selected.radarProfile.decisionLabel && <Badge tone="green">{selected.radarProfile.decisionLabel}</Badge>}{selected.radarProfile.sourceName && <span className="text-xs text-slate-400">{selected.radarProfile.sourceGroup} · {selected.radarProfile.sourceName}{selected.radarProfile.publishedAt ? ` · ${selected.radarProfile.publishedAt}` : ''}</span>}</div>{selected.radarProfile.thesis && <p className="text-xs leading-6 text-slate-500">{selected.radarProfile.thesis}</p>}{selected.radarProfile.profile && <div><h4 className="mb-2 text-sm font-semibold text-slate-800">项目画像</h4><div className="grid grid-cols-3 gap-x-4 gap-y-2 rounded-lg bg-slate-50 p-3 text-xs">{[['项目名称', selected.radarProfile.profile.projectName], ['项目轮次', selected.radarProfile.profile.projectRound], ['融资金额', selected.radarProfile.profile.financingAmount], ['最新估值', selected.radarProfile.profile.latestValuation], ['机构', selected.radarProfile.profile.institutions], ['行业', selected.radarProfile.profile.industry]].filter(([, v]) => v).map(([k, v]) => <div key={k}><p className="text-slate-400">{k}</p><p className="mt-0.5 font-medium text-slate-700">{v}</p></div>)}</div></div>}{selected.radarProfile.disclosure && Object.keys(selected.radarProfile.disclosure).length > 0 && <div><h4 className="mb-2 text-sm font-semibold text-slate-800">披露状态</h4><div className="space-y-1 rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-600">{[['轮次/阶段', selected.radarProfile.disclosure.round_or_stage], ['金额/估值', selected.radarProfile.disclosure.amount_or_valuation], ['投资方', selected.radarProfile.disclosure.investors], ['股权/股东', selected.radarProfile.disclosure.ownership_or_cap_table], ['收入/客户', selected.radarProfile.disclosure.revenue_or_customers]].filter(([, v]) => v).map(([k, v]) => <p key={k}><span className="text-slate-400">{k}：</span>{v}</p>)}</div></div>}{Array.isArray(selected.radarProfile.nextActions) && selected.radarProfile.nextActions.length > 0 && <div><h4 className="mb-2 text-sm font-semibold text-slate-800">下一步尽调动作</h4><div className="space-y-1.5">{selected.radarProfile.nextActions.map((a, i) => <p key={i} className="flex gap-2 text-xs leading-5 text-slate-600"><span className="mt-0.5 shrink-0 text-brand-500">{i + 1}.</span>{a}</p>)}</div></div>}{selected.radarProfile.profile?.lab && <div><h4 className="mb-1 text-sm font-semibold text-slate-800">实验室</h4><p className="text-xs leading-6 text-slate-500">{selected.radarProfile.profile.lab}</p></div>}{selected.radarProfile.articleText && <details className="rounded-lg border border-slate-100 p-3"><summary className="cursor-pointer text-sm font-semibold text-slate-800">正文全文（{selected.radarProfile.articleTextLength} 字）</summary><p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-600">{selected.radarProfile.articleText}</p></details>}{selected.radarProfile.link && <SourceLink url={selected.radarProfile.link}>查看原文</SourceLink>}</div>}<div className="grid grid-cols-2 gap-4"><div><h3 className="text-sm font-semibold text-slate-800">投资亮点</h3><div className="mt-3 space-y-2">{(selected.highlights ?? []).map((item) => <p key={item} className="flex gap-2 text-xs leading-5 text-slate-600"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />{item}</p>)}</div></div><div><h3 className="text-sm font-semibold text-slate-800">风险与核验任务</h3><div className="mt-3 space-y-2">{(selected.risks ?? []).map((item) => <p key={item} className="flex gap-2 text-xs leading-5 text-slate-600"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />{item}</p>)}</div></div></div><div className="grid grid-cols-2 gap-4">{[['团队', selected.team || (selected.scoring?.structuredTeam?.length ? selected.scoring.structuredTeam.map((t) => `${t.name}（${t.title}）`).join('；') : '') || (selected.radarProfile?.team?.length ? selected.radarProfile.team.map((t) => t.name).join('、') : '')], ['产品与服务', selected.product || selected.scoring?.whatIsIt || selected.summary || ''], ['融资口径', selected.financing || (selected.scoring?.fundingRoundsResearched?.length ? selected.scoring.fundingRoundsResearched.map((f) => `${f.round} ${f.amount}（${f.investors}）`).join('；') : '') || '未披露融资信息'], ['AI 建议', selected.suggestion || selected.scoring?.overall_comment || '尚未生成 AI 建议，可点击上方「开始 AI 评分」']].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-100 p-4"><h3 className="text-sm font-semibold text-slate-800">{label}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{value || '待核验'}</p></div>)}</div></div>}

          {detailTab === 'registry' && <div className="mt-5"><div className="mb-3 flex items-center gap-2 text-xs text-amber-700"><ShieldCheck className="h-4 w-4" />“待工商核验”不会被系统猜测补全；接入合规工商数据源后再升级状态。</div><div className="grid grid-cols-2 gap-x-8 gap-y-0 rounded-xl border border-slate-200 p-5">{[
            ['目标公司', selected.scoring?.registry?.companyName || selected.companyName], ['成立时间', selected.scoring?.registry?.foundedAt || selected.foundedAt], ['注册资本', selected.scoring?.registry?.registeredCapital || selected.registeredCapital], ['法定代表人', selected.scoring?.registry?.legalRepresentative || selected.legalRepresentative], ['统一社会信用代码', selected.scoring?.registry?.creditCode || selected.creditCode], ['登记状态', selected.scoring?.registry?.registrationStatus || selected.registrationStatus], ['公司类型', selected.companyType], ['注册地址', selected.registeredAddress],
          ].map(([label, value]) => <div key={label} className="grid grid-cols-[120px_1fr] border-b border-slate-100 py-3 text-sm"><span className="text-slate-400">{label}</span><span className="text-slate-700">{value}</span></div>)}</div></div>}

          {detailTab === 'team' && <div className="mt-5 space-y-3">{((selected.scoring?.structuredTeam?.length ? selected.scoring.structuredTeam : selected.founders) ?? []).map((founder) => <div key={founder.name} className="flex gap-4 rounded-xl border border-slate-200 p-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700"><UsersRound className="h-5 w-5" /></span><div><div className="flex items-center gap-2"><p className="font-medium text-slate-800">{founder.name}</p><Badge tone="slate">{founder.title}</Badge></div><p className="mt-2 text-sm leading-6 text-slate-600">{founder.background}</p></div></div>)}{!((selected.scoring?.structuredTeam?.length ? selected.scoring.structuredTeam : selected.founders) ?? []).length && <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-400">暂无核心团队信息（待核验）</div>}</div>}

          {detailTab === 'funding' && <div className="mt-5 space-y-5"><section><h3 className="text-sm font-semibold text-slate-800">股东信息</h3><div className="mt-3 overflow-hidden rounded-xl border border-slate-200"><div className="grid grid-cols-3 bg-slate-50 px-4 py-3 text-xs font-medium text-slate-500"><span>股东</span><span>持股</span><span>类型 / 口径</span></div>{((selected.scoring?.structuredShareholders?.length ? selected.scoring.structuredShareholders : selected.shareholders) ?? []).map((item) => <div key={item.name} className="grid grid-cols-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-700"><span>{item.name}</span><span>{item.percentage}</span><span>{item.type}</span></div>)}</div></section><section><h3 className="text-sm font-semibold text-slate-800">融资历史</h3><div className="mt-3 space-y-3">{((selected.scoring?.fundingRoundsResearched?.length ? selected.scoring.fundingRoundsResearched : selected.fundingRounds) ?? []).map((round) => <div key={`${round.round}-${round.date}`} className="rounded-xl border border-slate-200 p-4"><div className="flex items-center justify-between"><div><Badge tone="blue">{round.round}</Badge><span className="ml-2 text-xs text-slate-400">{round.date}</span></div>{round.sourceUrl && <SourceLink url={round.sourceUrl}>融资来源</SourceLink>}</div><div className="mt-3 grid grid-cols-3 gap-3 text-sm"><div><p className="text-xs text-slate-400">金额</p><p className="mt-1">{round.amount}</p></div><div><p className="text-xs text-slate-400">估值</p><p className="mt-1">{round.valuation}</p></div><div><p className="text-xs text-slate-400">投资方</p><p className="mt-1">{Array.isArray(round.investors) ? round.investors.join('、') : (round.investors || '待核验')}</p></div></div></div>)}</div></section></div>}

          {detailTab === 'news' && <div className="mt-5 space-y-3">{((selected.scoring?.structuredNews?.length ? selected.scoring.structuredNews.map((n) => ({ date: n.date, title: n.title, summary: n.summary, type: '动态', sourceName: n.sourceName, sourceUrl: n.sourceUrl })) : selected.companyNews) ?? []).map((news) => <div key={`${news.date}-${news.title}`} className="grid grid-cols-[90px_1fr_130px] gap-4 rounded-xl border border-slate-200 p-4"><div><p className="text-sm font-medium text-slate-700">{news.date}</p><Badge tone="slate">{news.type}</Badge></div><div><p className="font-medium text-slate-800">{news.title}</p><p className="mt-2 text-sm leading-6 text-slate-500">{news.summary}</p></div><div className="text-right text-xs"><p className="mb-2 text-slate-400">{news.sourceName}</p>{news.sourceUrl && <SourceLink url={news.sourceUrl}>查看原文</SourceLink>}</div></div>)}{!((selected.scoring?.structuredNews?.length ? selected.scoring.structuredNews : selected.companyNews) ?? []).length && <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-400">暂无经过来源标注的公司动态</div>}</div>}

          {detailTab === 'sources' && <div className="mt-5 space-y-3"><div className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">可靠性用于描述"来源本身"，不代表来源中的企业自述已经被第三方验证。所有链接均保留访问日期。</div>{selected.scoring?.researchSources?.length ? selected.scoring.researchSources.map((s, i) => <div key={`rs-${i}`} className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between"><div><Badge tone="blue">入库来源</Badge><p className="mt-2 font-medium text-slate-800">{s.title}</p></div>{s.url && <SourceLink url={s.url}>打开源地址</SourceLink>}</div><p className="mt-3 text-sm leading-6 text-slate-600">{s.excerpt}</p></div>) : (selected.sources ?? []).map((source) => <div key={source.id} className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><Badge tone={source.reliability === '高' ? 'green' : source.reliability === '中' ? 'amber' : 'slate'}>{source.reliability}可靠性</Badge><Badge tone="blue">{source.category}</Badge></div><p className="mt-2 font-medium text-slate-800">{source.title}</p><p className="mt-1 text-xs text-slate-400">{source.publisher} · 发布 {source.publishedAt ?? '未标注'} · 访问 {source.accessedAt}</p></div><SourceLink url={source.url}>打开源地址</SourceLink></div><p className="mt-3 text-sm leading-6 text-slate-600">{source.excerpt}</p></div>)}</div>}
        </div>}
      </Drawer>
    </div>
  )
}
