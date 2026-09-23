import { ArrowLeft, ArrowRight, Building2, LoaderCircle, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiGet } from '../lib/api'
import type { InstitutionTrackingProfile } from '../../server/src/services/institutionTrackingPresentation'
import './InstitutionTrackingPage.css'

type DirectoryResponse = { list: InstitutionTrackingProfile[] }

const institutionTypeLabels: Record<string, string> = {
  financial_vc: '财务 VC',
  cvc: '产业资本',
  local_government: '地方国资 / 基金',
  national_fund: '国家级基金',
  pe: 'PE',
  incubator: '孵化器',
  other: '其他',
}

function institutionTypeLabel(value: string): string {
  return institutionTypeLabels[value] || value || '机构类型待录入'
}

function useInstitutionData<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setData(null)
    void apiGet<T>(path).then((result) => {
      if (active) setData(result)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : '机构信息读取失败')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [path, retry])

  return { data, error, loading, retry: () => setRetry((value) => value + 1) }
}

function LoadingState() {
  return <div className="institution-tracking-state" role="status"><LoaderCircle className="institution-tracking-spinner" aria-hidden="true" />正在读取机构与投资项目…</div>
}

function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div className="institution-tracking-state" role="alert"><strong>机构追踪暂时无法显示</strong><p>{message}</p><button type="button" onClick={retry}>重试</button></div>
}

export function InstitutionTrackingDirectoryPage() {
  const { data, error, loading, retry } = useInstitutionData<DirectoryResponse>('/institutions')
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const needle = query.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
    return (data?.list ?? []).filter((institution) => !needle || [
      institution.name, ...institution.aliases, ...institution.focusIndustries,
    ].some((value) => value.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(needle)))
  }, [data, query])

  return <main className="institution-tracking-page">
    <header className="institution-tracking-header">
      <span className="institution-tracking-header-icon"><Building2 aria-hidden="true" /></span>
      <div><h1>机构追踪</h1><p>查看投资机构档案及新项目库自动关联的最近投资项目</p></div>
    </header>
    <div className="institution-tracking-toolbar">
      <label className="institution-tracking-search"><Search aria-hidden="true" /><span className="sr-only">搜索机构</span><input value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder="搜索机构名称、别名或赛道" />{query && <button type="button" aria-label="清空机构搜索" onClick={() => setQuery('')}><X aria-hidden="true" /></button>}</label>
      <span role="status">共 {data?.list.length ?? 0} 家机构</span>
    </div>
    {loading && !data ? <LoadingState /> : error ? <ErrorState message={error} retry={retry} />
      : visible.length ? <div className="institution-tracking-grid">{visible.map((institution) => <Link key={institution.key} className="institution-tracking-card" to={`/institutions/${institution.key}`}>
        <div className="institution-tracking-card-heading"><span className="institution-tracking-card-icon"><Building2 aria-hidden="true" /></span><div><h2>{institution.name}</h2><p>{institutionTypeLabel(institution.institutionType)}</p></div><ArrowRight aria-hidden="true" /></div>
        {institution.aliases.length > 0 && <p className="institution-tracking-aliases">别名：{institution.aliases.join('、')}</p>}
        <div className="institution-tracking-tags">{institution.focusIndustries.length ? institution.focusIndustries.map((industry) => <span key={industry}>{industry}</span>) : <span>赛道待补充</span>}</div>
        <div className="institution-tracking-card-footer"><span>关联投资项目 <strong>{institution.projectCount}</strong></span><span>{institution.latestInvestmentAt || '暂无投资日期'}</span></div>
      </Link>)}</div>
        : <div className="institution-tracking-state">{query ? '没有匹配的机构，请调整搜索词。' : '尚无机构档案或关联项目。'}</div>}
  </main>
}

export function InstitutionTrackingProfilePage() {
  const { institutionKey = '' } = useParams()
  const { data, error, loading, retry } = useInstitutionData<InstitutionTrackingProfile>(`/institutions/${institutionKey}`)

  return <main className="institution-tracking-page">
    <Link className="institution-tracking-back" to="/institutions"><ArrowLeft aria-hidden="true" />返回机构追踪</Link>
    {loading && !data ? <LoadingState /> : error ? <ErrorState message={error} retry={retry} /> : data && <>
      <header className="institution-tracking-header institution-tracking-profile-header">
        <span className="institution-tracking-header-icon"><Building2 aria-hidden="true" /></span>
        <div><h1>{data.name}</h1><p>{institutionTypeLabel(data.institutionType)}{data.tier ? ` · ${data.tier}` : ''}</p></div>
        <div className="institution-tracking-count"><strong>{data.projectCount}</strong><span>关联投资项目</span></div>
      </header>
      <section className="institution-tracking-overview" aria-label="机构概况">
        <div><span>别名 / 曾用名</span><strong>{data.aliases.join('、') || '暂无'}</strong></div>
        <div><span>最近投资日期</span><strong>{data.latestInvestmentAt || '暂无'}</strong></div>
        <div><span>关联赛道</span><strong>{data.focusIndustries.join('、') || '暂无'}</strong></div>
      </section>
      <section className="institution-tracking-history" aria-label="最近投资项目">
        <header><h2>最近投资项目</h2><p>按项目融资日期倒序；由新项目库的投资方字段自动关联，具体投资事实以原始来源为准。</p></header>
        {data.recentProjects.length ? <div className="institution-tracking-projects">{data.recentProjects.map((project) => <Link key={project.leadId} className="institution-tracking-project" to={`/sourcing/${project.leadId}`}>
          <div className="institution-tracking-project-top"><h3>{project.name}</h3><span>{project.announcedAt || '日期未披露'}</span></div>
          {project.companyName && project.companyName !== project.name && <p className="institution-tracking-company">{project.companyName}</p>}
          <div className="institution-tracking-project-facts"><span>{project.round || '轮次未披露'}</span><span>{project.amount || '金额未披露'}</span><span>{project.industry || '赛道待补充'}</span>{project.region && <span>{project.region}</span>}</div>
          {project.summary && <p className="institution-tracking-summary">{project.summary}</p>}
          <div className="institution-tracking-project-source"><span>{project.sourceChannel || '来源待补充'}</span><span>查看项目线索 <ArrowRight aria-hidden="true" /></span></div>
        </Link>)}</div> : <div className="institution-tracking-state">暂无关联投资项目。新项目库收录或编辑投资方后，会自动显示在这里。</div>}
      </section>
    </>}
  </main>
}
