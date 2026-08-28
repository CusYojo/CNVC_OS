import { useEffect, useRef, useState } from 'react'
import { officeExecutionCommand, officeExecutionLabels, type OfficeExecutionView } from '../../server/src/contracts/fdeOfficeExecutionContract'
import { apiGet } from '../lib/api'
import { formatShanghaiDateTime } from '../lib/dateTime'
import { Button, Card } from './ui'

type Attachment = { id: string; name: string; purpose: string; sha256: string; version: number }
type Props = { id: string; version: number; canWrite: boolean; attachments: Attachment[];
  run: (work: () => Promise<void>) => Promise<void>; write: (path: string, body: Record<string, unknown>) => Promise<unknown>; reload: () => Promise<void> }
const labels: Record<string, string> = { reference: '人工业务凭证编号', description: '实际办理说明', entity: '实际用印主体', sealType: '实际印章类型', copies: '实际份数', amount: '实际金额', currency: '实际币种', documentVersion: '实际签署文件版本' }
const readFile = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('文件读取失败')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file) })
export function FdeOfficeExecutionPanel({ id, version, canWrite, attachments, run, write, reload }: Props) {
  const base = `/oa/office/requests/${id}`, [view, setView] = useState<OfficeExecutionView | null>(null), [page, setPage] = useState(1)
  const [error, setError] = useState(''), [tick, setTick] = useState(0), [action, setAction] = useState<'record' | 'retry' | 'correct'>('record')
  const [outcome, setOutcome] = useState(''), [occurredAt, setOccurredAt] = useState(''), [reason, setReason] = useState(''), [facts, setFacts] = useState<Record<string, string>>({}), [selected, setSelected] = useState<string[]>([]), [confirmed, setConfirmed] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let active = true; setView(null); setError(''); setConfirmed(false)
    apiGet<OfficeExecutionView>(`${base}/executions?page=${page}`).then(result => { if (active) { setView(result); setAction(result.latestId ? 'correct' : 'record') } }).catch(e => { if (active) setError((e as Error).message) })
    return () => { active = false }
  }, [base, version, page, tick])
  useEffect(() => { const focus = () => { setView(null); setConfirmed(false); setTick(n => n + 1) }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus) }, [])
  const disabled = !canWrite || !view?.canRecord, available = attachments.filter(f => ['execution', 'signed'].includes(f.purpose))
  return <section className="mt-6 space-y-3 border-t pt-5">
    <h3 className="font-semibold">执行回执 · 人工事实记录</h3>
    <p className="text-xs text-slate-500">只登记人工实际办理及原件依据，不调用付款、用印、签署、订票或考勤系统。上传原件不等于执行成功；更正保留旧记录，不撤销外部事实。</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {!view && !error && <p role="status" className="text-sm">正在核对执行权限和原件…</p>}
    <Button variant="secondary" disabled={!canWrite} onClick={() => { setView(null); setTick(n => n + 1) }}>刷新执行记录</Button>
    {view && <>
      {!view.canRecord && <p role="status" className="text-sm text-amber-800">{view.blockedReason}</p>}
      {view.hiddenRecords > 0 && <p className="text-sm text-amber-800">本页 {view.hiddenRecords} 条回执因原件权限不可读，未显示事实内容。</p>}
      {!view.records.length && !view.hiddenRecords && <p className="text-sm text-slate-500">尚无执行回执，不能据批准状态认定已执行。</p>}
      {view.records.map(record => <Card key={record.id} className="space-y-2 p-3 text-xs">
        <p className="font-semibold">{officeExecutionLabels[record.action]} · {record.outcome === 'succeeded' ? '人工登记办理成功' : '人工登记办理失败'}</p>
        <p>办理时间 {formatShanghaiDateTime(record.occurredAt)} · 登记人 {record.actorName} · 登记时间 {formatShanghaiDateTime(record.recordedAt)}</p>
        {record.supersedesId && <p>关联上一记录：{record.supersedesId}（旧记录保留，不累计为重复付款）</p>}
        <p className="whitespace-pre-wrap">{record.reason}</p>
        {Object.entries(record.facts).map(([key, value]) => <p key={key}>{labels[key] ?? key}：{value}</p>)}
        {record.files.map(file => <p key={file.fileId}><a className="text-teal-800" href={`/api${base}/attachments/${file.fileId}/preview`} target="_blank" rel="noreferrer">{file.name} · 原件 V{file.version}</a><span className="ml-2 break-all text-slate-500">SHA-256 {file.sha256}</span></p>)}
      </Card>)}
      <div className="flex gap-2"><Button variant="secondary" disabled={page === 1 || !canWrite} onClick={() => setPage(n => n - 1)}>上一页回执</Button><span className="p-2 text-xs">第 {page} 页</span><Button variant="secondary" disabled={!view.hasMore || !canWrite} onClick={() => setPage(n => n + 1)}>下一页回执</Button></div>
      {view.canRecord && <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-4">
        <label className="block text-sm">上传执行证明原件<input type="file" className="mt-2 block" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(async () => { const dataBase64 = await readFile(file); if (!alive.current) return; await write(`${base}/attachments/${crypto.randomUUID()}`, { expectedVersion: version, reason: '上传人工执行证明原件，不认定执行完成', purpose: 'execution', name: file.name, dataBase64, declaredType: file.type || undefined }); if (alive.current) await reload() }) }} /></label>
        <p className="text-xs text-slate-500">在上方附件区显式管理原件授权，不自动向其他账号扩散。</p>
        <label className="block"><span className="label">登记动作</span><select className="input" value={action} onChange={e => { setAction(e.target.value as typeof action); setConfirmed(false) }}>{!view.latestId ? <option value="record">首次登记</option> : <><option value="correct">更正最新记录，保留旧记录</option>{view.records.find(r => r.id === view.latestId)?.outcome === 'failed' && <option value="retry">登记失败后的新重试事实</option>}</>}</select></label>
        <label className="block"><span className="label">实际办理结果</span><select className="input" value={outcome} onChange={e => { setOutcome(e.target.value); setConfirmed(false) }}><option value="">请选择，不默认成功</option><option value="succeeded">人工办理成功</option><option value="failed">人工办理失败</option></select></label>
        <label className="block"><span className="label">实际办理时间（上海）</span><input type="datetime-local" step="1" className="input" value={occurredAt} onChange={e => { setOccurredAt(e.target.value); setConfirmed(false) }} /></label>
        <div className="grid gap-3 sm:grid-cols-2">{view.fields.map(key => <label key={key}><span className="label">{labels[key] ?? key}{view.requiredFields.includes(key) ? '（必填）' : ''}</span><input className="input" value={facts[key] ?? ''} onChange={e => { setFacts({ ...facts, [key]: e.target.value }); setConfirmed(false) }} /></label>)}</div>
        <label className="block"><span className="label">办理 / 失败 / 更正依据（至少五字）</span><textarea className="textarea" value={reason} onChange={e => { setReason(e.target.value); setConfirmed(false) }} /></label>
        <div className="space-y-2"><p className="text-sm">明确关联执行原件（至少一份）</p>{available.map(file => <label key={file.id} className="block text-xs"><input type="checkbox" checked={selected.includes(file.id)} onChange={e => { setSelected(e.target.checked ? [...selected, file.id] : selected.filter(id => id !== file.id)); setConfirmed(false) }} /> {file.name} · V{file.version}</label>)}</div>
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />已核对实际事实及原件，本次仅登记记录，不触发外部业务，更正不会抹去原记录。</label>
        <Button disabled={disabled || !confirmed || !outcome || !occurredAt || reason.trim().length < 5 || !selected.length} onClick={() => void run(async () => {
          const input = officeExecutionCommand.parse({ clientRequestId: crypto.randomUUID(), expectedVersion: version, expectedLatestId: view.latestId, action, outcome,
            occurredAt: new Date(`${occurredAt.length === 16 ? `${occurredAt}:00` : occurredAt}+08:00`).toISOString(), reason,
            facts: Object.fromEntries(Object.entries(facts).filter(([, value]) => value.trim())), files: selected.map(id => { const f = available.find(row => row.id === id); return { fileId: id, version: f?.version, sha256: f?.sha256 } }) })
          await write(`${base}/executions`, input)
          if (alive.current) { setConfirmed(false); setReason(''); setOutcome(''); setSelected([]); setFacts({}); await reload() }
        })}>确认登记人工执行回执</Button>
      </fieldset>}
    </>}
  </section>
}
