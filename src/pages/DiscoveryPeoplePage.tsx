import { ArrowUpRight, LoaderCircle, Search, UsersRound } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiscoveryPerson, DiscoveryPersonKind } from '../../server/src/contracts/discoveryPeopleContract'
import { apiGet } from '../lib/api'
import './DiscoveryPeoplePage.css'

type Kind = DiscoveryPersonKind | 'all'
type PeopleResponse = { items: DiscoveryPerson[]; total: number; page: number; pageSize: number; totalPages: number; sourceNote: string }
const kinds: Array<{ value: Kind; label: string }> = [
  { value: 'all', label: '全部人物' }, { value: 'ranking', label: '知名榜单与奖项' },
  { value: 'research', label: '科研成果' }, { value: 'expert', label: '领域专家' },
]
const kindLabel: Record<DiscoveryPersonKind, string> = { ranking: '榜单与奖项', research: '科研成果', expert: '领域专家' }

export function DiscoveryPeoplePage() {
  const requestSerial = useRef(0)
  const [kind, setKind] = useState<Kind>('all')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [response, setResponse] = useState<PeopleResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => { setSubmittedQuery(query.trim()); setPage(1) }, 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const load = useCallback(async () => {
    const serial = ++requestSerial.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ kind, page: String(page), pageSize: '20' })
      if (submittedQuery) params.set('q', submittedQuery)
      const result = await apiGet<PeopleResponse>(`/discovery/people?${params.toString()}`)
      if (serial === requestSerial.current) setResponse(result)
    } catch (cause) {
      if (serial === requestSerial.current) setError(cause instanceof Error ? cause.message : '人物线索读取失败')
    } finally { if (serial === requestSerial.current) setLoading(false) }
  }, [kind, page, submittedQuery])

  useEffect(() => { void load(); return () => { requestSerial.current += 1 } }, [load])

  return <div className="discovery-people-page">
    <header className="discovery-people-hero">
      <div className="discovery-people-heading"><span><UsersRound aria-hidden="true" /></span><div><h1>人物发掘</h1><p>从官方奖项名录、领域专家与有原文证据的科研成果中寻找潜在合作线索</p></div></div>
    </header>
    <p className="discovery-people-disclaimer">科研人物线索，不代表创业或融资意愿；人物身份、机构关系及成果商业化状态需要另行核验。</p>
    <div className="discovery-people-toolbar">
      <div className="discovery-people-tabs" role="group" aria-label="人物来源分类">
        {kinds.map((item) => <button key={item.value} type="button" aria-pressed={kind === item.value} onClick={() => { setKind(item.value); setPage(1) }}>{item.label}</button>)}
      </div>
      <label className="discovery-people-search"><Search aria-hidden="true" /><input value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名、机构或领域" aria-label="搜索人物" /></label>
    </div>
    {response?.sourceNote && <p className="discovery-people-source-note">{response.sourceNote}</p>}
    <section className="discovery-people-results" aria-label="人物线索列表" aria-busy={loading}>
      {loading ? <div className="discovery-people-state"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取人物线索…</div>
        : error ? <div className="discovery-people-state" role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></div>
          : response?.items.length ? <div className="discovery-people-grid">{response.items.map((person) => <article className="discovery-people-card" key={person.identityKey}>
            <div className="discovery-people-card-head"><span>{kindLabel[person.kind]}</span><span>{person.identityStatus === 'source_confirmed' ? '官方名录' : person.identityStatus === 'algorithmic' ? '算法身份待核验' : '同名待核验'}</span></div>
            <h2>{person.name}</h2>
            <p className="discovery-people-organization">{person.organization || '机构待核验'}</p>
            <p className="discovery-people-field">{person.field || person.sourceLabel}</p>
            <div className="discovery-people-evidence"><strong>来源证据</strong>{person.evidence.slice(0, 3).map((item) => <a href={item.url} key={item.url} target="_blank" rel="noopener noreferrer">{item.title}<ArrowUpRight aria-hidden="true" /></a>)}
              {person.evidence.length > 3 && <small>另有 {person.evidence.length - 3} 项成果证据</small>}
            </div>
            <footer>{person.sourceLabel}{person.evidence[0]?.publishedAt ? ` · ${person.evidence[0].publishedAt}` : ''}</footer>
          </article>)}</div>
            : <div className="discovery-people-state">当前类别暂无可核验的人物记录，请调整筛选条件。</div>}
    </section>
    {response && response.totalPages > 1 && <nav className="discovery-people-pagination" aria-label="人物线索分页"><span>共 {response.total} 人 · 第 {response.page}/{response.totalPages} 页</span><div><button type="button" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>上一页</button><button type="button" disabled={page >= response.totalPages || loading} onClick={() => setPage(page + 1)}>下一页</button></div></nav>}
  </div>
}
