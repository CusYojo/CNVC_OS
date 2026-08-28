import { useState } from 'react'
import { apiPost } from '../lib/api'
import { Button, Modal } from './ui'
import { useToast } from './Toast'
import { timeLocal, type AutoScheduleResult } from '../../server/src/contracts/fdeTimeContract'

export function FdeAutoSchedulePanel({ weekStart, requests, onChanged }: { weekStart: string; requests: Array<{ id: string; expectedVersion: number }>; onChanged: () => Promise<void> }) {
  const { showToast } = useToast(), [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ result: AutoScheduleResult; selection: { weekStart: string; requests: typeof requests }; clientRequestId: string } | null>(null)
  async function plan() {
    setBusy(true)
    try {
      const selection = { weekStart, requests }, result = await apiPost<AutoScheduleResult>('/leader-time/auto-schedule/preview', selection)
      setPreview({ result, selection, clientRequestId: crypto.randomUUID() })
    } catch (error) { showToast((error as Error).message, 'error') } finally { setBusy(false) }
  }
  async function save() {
    if (!preview) return
    setBusy(true)
    try {
      await apiPost('/leader-time/auto-schedule/apply', { clientRequestId: preview.clientRequestId, fingerprint: preview.result.fingerprint, selection: preview.selection })
      setPreview(null); await onChanged(); showToast('排程方案已保存；仍须指定领导确认')
    } catch (error) { showToast((error as Error).message, 'error'); await onChanged().catch(() => {}) } finally { setBusy(false) }
  }
  const local = (value: string | null) => value ? timeLocal(new Date(value)).replace('T', ' ') : '未排期'
  return <><div className="flex flex-wrap items-center gap-3 rounded-lg border border-[#dfe6e4] bg-white p-4"><Button variant="secondary" disabled={!requests.length || requests.length > 100} loading={busy} onClick={() => void plan()}>按优先级自动排程</Button><p className="text-xs text-slate-500">所选周最多 100 项，先预览再保存；保留已确认事项，无空档继续待排序。同优先级按最晚完成时间排序，历史期限未知排在最后；未明确优先级的需求须先补充。</p></div>
    <Modal open={Boolean(preview)} title="自动排程方案预览" onClose={() => { if (!busy) setPreview(null) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setPreview(null)}>取消</Button><Button loading={busy} disabled={!preview || preview.result.arranged + preview.result.overflow === 0} onClick={() => void save()}>保存为待确认方案</Button></>}>
      {preview && <div className="space-y-3"><p className="text-sm">拟排程 {preview.result.arranged} 项，无空档 {preview.result.overflow} 项，跳过 {preview.result.skipped} 项。</p><p className="text-xs text-slate-500">预览未写入日程。保存时重新检查占用与版本；不会代替领导确认或修改项目最终日期。</p>{preview.result.items.map(item => <article key={item.id} className="rounded-lg border border-slate-200 p-3"><h3 className="text-sm font-medium">{item.priority ?? '优先级待补充'} · {item.title}</h3><p className="mt-2 text-xs">{local(item.from)} → {local(item.scheduledStart)} · {item.durationMinutes} 分钟</p><p className="mt-1 text-xs text-slate-500">最晚完成：{item.latestFinish?local(item.latestFinish):'历史未记录'}</p><p className={`mt-2 text-xs ${item.result === 'overflow' ? 'text-amber-700' : 'text-slate-500'}`}>{item.reason}</p></article>)}</div>}
    </Modal></>
}
