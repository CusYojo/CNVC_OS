import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { Button, Modal } from './ui'

type Subject = 'company' | 'project' | 'team' | 'lab' | 'paper'
type Review = {
  id: string; status: string; reason: string; createdAt: string; reviewerUserName?: string
  event: { id: string; sourceType: string; sourceId: string; payload: Record<string, unknown> }
  pipeline: { status: string; leadId?: string }
  triggerDecision: { subjectType?: Subject; subjectName?: string; legalName?: string; reason: string; evidence: { claim: string; quote: string }[] }
  resolution?: { outcome: string; reason: string } | null
  existingLeads: { id: string; name: string; companyName?: string }[]
}
type Listing = { list: Review[]; total: number; totalPages: number }
const roles = ['系统管理员', '投资总监', '投资经理', '风控与法务', '投委会秘书']
const text = (value: unknown) => typeof value === 'string' ? value : ''
function safeUrl(value: unknown) {
  try { const url = new URL(text(value)); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}

export function LeadReviewPanel() {
  const role = useAuthStore(s => s.user?.role || '')
  const userId = useAuthStore(s => s.user?.id)
  const allowed = roles.includes(role)
  const [status, setStatus] = useState('pending')
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<Review | null>(null)
  const [subjectType, setSubjectType] = useState<Subject>('company')
  const [name, setName] = useState('')
  const [legalName, setLegalName] = useState('')
  const [reason, setReason] = useState('')
  const [quote, setQuote] = useState('')
  const [claim, setClaim] = useState('')
  const [target, setTarget] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState('')
  // Keep the exact request on uncertain failures; retry never invents a new key.
  const [pending, setPending] = useState<{ reviewId: string; body: Record<string, unknown> } | null>(null)
  useEffect(() => {
    let active = true
    if (!allowed) return
    setLoading(true); setError(''); setData(null)
    api<Listing>(`/lead-pipeline/reviews?status=${status}&page=${page}&pageSize=20`)
      .then(result => { if (active) setData(result) })
      .catch(e => { if (active) setError(e.message || '复核列表读取失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [allowed, role, userId, status, page, refresh])
  function open(row: Review) {
    setSelected(row); setSubjectType(row.triggerDecision.subjectType || 'company')
    setName(row.triggerDecision.subjectName || ''); setLegalName(row.triggerDecision.legalName || '')
    setReason(''); setClaim(''); setQuote(''); setTarget(''); setConfirmed(false); setSubmitError(''); setPending(null)
  }
  async function submit(outcome: 'accept' | 'reject') {
    if (!selected || busy) return
    const request = pending || { reviewId: selected.id, body: {
      idempotencyKey: crypto.randomUUID(), outcome, reason: reason.trim(),
      ...(outcome === 'accept' ? { subjectType, subjectName: name.trim(), legalName: legalName.trim() || null,
        targetLeadId: target || null, evidence: [{ sourceId: selected.event.id, sourceType: selected.event.sourceType,
          claim: claim.trim(), quote: quote.trim(), sourceUrl: safeUrl(selected.event.payload.link) || null }] } : {}),
    } }
    setPending(request); setBusy(true); setSubmitError('')
    try {
      await api(`/lead-pipeline/reviews/${encodeURIComponent(request.reviewId)}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) })
      setSelected(null); setPending(null); setNotice(request.body.outcome === 'accept' ? '复核已保存，线索已入池或合并。可在“已处理”中查看结果。' : '已拒绝该线索，处理理由已保存。')
      setRefresh(n => n + 1)
    } catch (e) {
      const failure = e as { message?: string; status?: number }
      setSubmitError(failure.message || '提交失败')
      // Validation failures are definitive; network/server failures may have committed.
      if (failure.status && failure.status >= 400 && failure.status < 500 && failure.status !== 408) setPending(null)
    } finally { setBusy(false) }
  }
  if (!allowed) return <div className="fde-card p-6">当前角色无权查看线索复核，请联系管理员核对权限。</div>
  const payload = selected?.event.payload || {}
  const sourceUrl = safeUrl(payload.link || payload.url)
  const locked = busy || Boolean(pending)
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">线索人工复核</h2><p className="text-sm text-slate-500">核对来源与证据后，决定是否加入线索池。待复核记录尚未正式入池。</p></div>
      <div className="flex gap-2"><select aria-label="复核状态" value={status} onChange={e => { setStatus(e.target.value); setPage(1) }} className="rounded border p-2"><option value="pending">待复核</option><option value="resolved">已处理</option></select><Button variant="secondary" onClick={() => setRefresh(n => n + 1)}>刷新</Button></div></div>
    {notice && <p role="status" className="text-emerald-700">{notice}</p>}
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {loading ? <p role="status">正在读取复核记录…</p> : data && <>
      <p className="text-sm text-slate-500">共 {data.total} 条</p>
      {!data.list.length && <div className="fde-card p-8 text-center text-slate-500">暂无{status === 'pending' ? '待复核' : '已处理'}记录</div>}
      {data.list.map(row => <article key={row.id} className="fde-card space-y-2 p-4">
        <div className="flex items-start justify-between gap-4"><h3 className="font-semibold">{text(row.event.payload.title) || row.triggerDecision.subjectName || '未命名线索'}</h3><Button variant="secondary" onClick={() => open(row)}>{row.status === 'pending' ? '查看并复核' : '查看结果'}</Button></div>
        <p className="text-sm text-slate-500">{row.event.payload.source === 'weixin_link' ? '微信输入' : row.event.sourceType} · {text(row.event.payload.source_name) || '未注明来源'} · {new Date(row.createdAt).toLocaleString('zh-CN')}</p>
        <p className="text-sm">{row.resolution?.reason || row.reason}</p>
        {row.pipeline.leadId && <Link className="text-teal-700 underline" to={`/sourcing/${row.pipeline.leadId}`}>查看入池项目</Link>}
      </article>)}
      <div className="flex items-center gap-3"><Button variant="secondary" disabled={page <= 1 || loading} onClick={() => setPage(n => n - 1)}>上一页</Button><span>{page} / {Math.max(1, data.totalPages)}</span><Button variant="secondary" disabled={page >= data.totalPages || loading} onClick={() => setPage(n => n + 1)}>下一页</Button><Button variant="secondary" disabled={page >= data.totalPages || loading} onClick={() => setPage(data.totalPages)}>末页（最新）</Button></div>
    </>}
    <Modal open={Boolean(selected)} title="线索来源与人工复核" width="max-w-5xl" onClose={() => { if (!locked) setSelected(null) }}>
      {selected && <div className="space-y-4">
        <h3 className="font-semibold">{text(payload.title) || name}</h3>
        <p>来源：{payload.source === 'weixin_link' ? '微信输入' : selected.event.sourceType} · {text(payload.source_name) || '未注明'}</p>
        {text(payload.submitted_by) && <p className="text-sm text-slate-500">提交账号：{text(payload.submitted_by)}</p>}
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer" className="break-all text-teal-700 underline">打开原文：{sourceUrl}</a>}
        <div className="rounded bg-amber-50 p-3"><strong>复核原因</strong><p className="mt-1 whitespace-pre-wrap">{selected.reason}</p></div>
        <details open><summary className="cursor-pointer font-medium">提取正文</summary><div className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded border p-3 text-sm">{text(payload.article_text) || text(payload.summary) || '该来源未提供正文，请查看原文。'}</div></details>
        {text(payload.article_markdown) && <details><summary className="cursor-pointer">查看 Markdown 原文</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-sm">{text(payload.article_markdown)}</pre></details>}
        <details><summary className="cursor-pointer">AI 审核证据（供核对）</summary>{selected.triggerDecision.evidence.map((e, i) => <blockquote key={i} className="my-2 border-l-2 pl-3"><p>{e.claim}</p><p className="whitespace-pre-wrap text-sm text-slate-500">{e.quote}</p></blockquote>)}</details>
        {selected.status !== 'pending' ? <div><p>处理结果：{selected.resolution?.outcome === 'accept' ? '已接受' : '已拒绝'}</p><p>处理人：{selected.reviewerUserName || '未注明'}</p><p>{selected.resolution?.reason}</p></div> : <>
          <fieldset disabled={locked} className="space-y-3 disabled:opacity-60">
            <div className="grid gap-3 sm:grid-cols-2"><label>主体类型<select className="mt-1 block w-full rounded border p-2" value={subjectType} onChange={e => setSubjectType(e.target.value as Subject)}><option value="company">公司</option><option value="project">项目</option><option value="team">团队</option><option value="lab">实验室</option><option value="paper">论文</option></select></label><label>主体名称<input maxLength={128} className="mt-1 block w-full rounded border p-2" value={name} onChange={e => setName(e.target.value)} /></label></div>
            <label className="block">公司法定名称（如适用）<input maxLength={128} className="mt-1 block w-full rounded border p-2" value={legalName} onChange={e => setLegalName(e.target.value)} /></label>
            {selected.existingLeads.length > 0 && <label className="block">已有同名线索<select className="mt-1 block w-full rounded border p-2" value={target} onChange={e => setTarget(e.target.value)}><option value="">由系统核对，存在歧义时停止</option>{selected.existingLeads.map(lead => <option key={lead.id} value={lead.id}>合并至 {lead.companyName || lead.name}（{lead.id.slice(0, 8)}）</option>)}</select></label>}
            <label className="block">核验事实（确认入池必填）<input maxLength={8000} className="mt-1 block w-full rounded border p-2" value={claim} onChange={e => setClaim(e.target.value)} placeholder="例如：已核实公司主体及本次投资事件" /></label>
            <label className="block">原文证据（确认入池必填）<textarea maxLength={8000} rows={3} className="mt-1 block w-full rounded border p-2" value={quote} onChange={e => setQuote(e.target.value)} placeholder="从上方正文复制支持该事实的原文，不能用改写后的摘要代替" /></label>
            <label className="block">处理理由（必填）<textarea maxLength={8000} rows={3} className="mt-1 block w-full rounded border p-2" value={reason} onChange={e => setReason(e.target.value)} placeholder="说明核验依据、如何解决待复核问题，或拒绝原因" /></label>
            <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对来源、主体和证据，确认本次处理意见。</label>
          </fieldset>
          {submitError && <p role="alert" className="text-red-600">{submitError}</p>}
          {pending && !busy ? <div><p className="text-sm">上次提交结果尚未确认，请重试原请求。表单暂时锁定，避免重复处理。</p><Button onClick={() => submit(pending.body.outcome as 'accept' | 'reject')}>重试原请求</Button></div> : <div className="flex gap-3"><Button loading={busy} disabled={locked || !confirmed || reason.trim().length < 2 || !name.trim() || !claim.trim() || !quote.trim()} onClick={() => submit('accept')}>确认入池</Button><Button variant="danger" disabled={locked || !confirmed || reason.trim().length < 2} onClick={() => submit('reject')}>拒绝入池</Button></div>}
        </>}
      </div>}
    </Modal>
  </section>
}
