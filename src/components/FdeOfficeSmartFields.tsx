import { GripVertical, Plus, Trash2 } from 'lucide-react'
import type { OfficeDefinition } from '../../server/src/contracts/fdeOfficeContract'
import { Button } from './ui'

type Person = { id: string; name: string; role: string }
type Attachment = { id: string; name: string }
export type LeaveBalance = { type: string; allowanceDays: number | null; usedDays: number; remainingDays: number | null }
type Props = {
  form: OfficeDefinition
  people: Person[]
  attachments: Attachment[]
  leaveBalances?: LeaveBalance[]
  changeDetail: (field: string, value: unknown) => void
  changeReason: (reason: string) => void
  changeTitle: (title: string) => void
}

const templates = {
  用印: {
    '合同签署': '因业务合作需要，现申请对《【文件名称】》加盖公司印章，用印份数为【份数】份。',
    '资质证明': '因办理【具体事项】需要，申请对相关资质证明材料加盖公司印章。',
    '对外公函': '因向【接收单位】出具公函，申请对《【公函名称】》加盖公司印章。',
    '证明文件': '因【具体事项】需要，申请对《【证明文件】》加盖公司印章。',
  },
  出差: {
    '参会': '前往【城市】参加【会议名称】，完成会议交流及会后总结。',
    '客户拜访': '前往【城市】拜访【客户名称】，就【洽谈事项】进行沟通。',
    '项目驻场': '前往【城市】开展【项目名称】驻场工作，完成【工作目标】。',
    '商务洽谈': '前往【城市】与【合作方】开展商务洽谈，推进【洽谈事项】。',
  },
} as const

function dateSpan(start?: string, end?: string) {
  if (!start || !end || end < start) return 0
  let count = 0
  for (let value = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`); value <= last; value += 86400000) {
    const day = new Date(value).getUTCDay()
    if (day !== 0 && day !== 6) count += 1
  }
  return count
}

function roundLeaveHours(start?: string, end?: string) {
  if (!start || !end) return ''
  const hours = (Date.parse(`${end}:00`) - Date.parse(`${start}:00`)) / 3600000
  if (!Number.isFinite(hours) || hours <= 0) return ''
  return String(Math.ceil(hours * 2) / 2)
}

function moneyTotal(values: string[]) {
  return values.reduce((sum, value) => sum + (Number(value) || 0), 0).toFixed(2).replace(/\.00$/, '')
}

export function FdeOfficeSmartFields({ form, people, attachments, leaveBalances = [], changeDetail, changeReason, changeTitle }: Props) {
  const d = form.details
  if (d.kind === '用印') return <section className="office-kind-section sm:col-span-2">
    <div className="office-section-title"><div><span>01</span><h3>用印信息</h3></div><small>简化申请</small></div>
    <div className="office-field-grid">
      <label><span className="label">印章类型 *</span><select className="input" value={d.sealType} onChange={e => { changeDetail('sealType', e.target.value); changeTitle(`${e.target.value || '用印'}申请`) }}><option value="">请选择</option>{['合同章', '公章', '法人章', '财务章', '人事章'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label><span className="label">经办人 *</span><select className="input" value={d.handlerId ?? ''} onChange={e => changeDetail('handlerId', e.target.value || undefined)}><option value="">请选择</option>{people.map(p => <option key={p.id} value={p.id}>{p.name} · {p.role}</option>)}</select></label>
      <label className="office-wide"><span className="label">用印事由 *</span><textarea className="textarea min-h-24" value={d.purpose} onChange={e => { changeDetail('purpose', e.target.value); changeReason(e.target.value) }} /></label>
      <label><span className="label">用印份数 *</span><input className="input" type="number" min="1" value={d.copies ?? 1} onChange={e => changeDetail('copies', Number(e.target.value) || 1)} /></label>
    </div>
  </section>

  if (d.kind === '出差') {
    const days = dateSpan(d.startDate, d.endDate)
    const itinerary = d.itinerary.length ? d.itinerary : d.origin && d.destination && d.startDate && d.endDate ? [
      { id: 'outbound', from: d.origin, to: d.destination, date: d.startDate, transport: d.travelMode },
      { id: 'return', from: d.destination, to: d.origin, date: d.endDate, transport: d.travelMode },
    ] : []
    return <section className="office-kind-section sm:col-span-2">
      <div className="office-section-title"><div><span>01</span><h3>智能行程</h3></div><small>{days ? `${days} 个工作日` : '简易模式'}</small></div>
      <div className="office-field-grid">
        <label><span className="label">出发城市 *</span><input className="input" value={d.origin} onChange={e => changeDetail('origin', e.target.value)} /></label>
        <label><span className="label">目的城市 *</span><input className="input" value={d.destination} onChange={e => changeDetail('destination', e.target.value)} /></label>
        <label><span className="label">出发日期 *</span><input className="input" type="date" value={d.startDate ?? ''} onChange={e => changeDetail('startDate', e.target.value || undefined)} /></label>
        <label><span className="label">返回日期 *</span><input className="input" type="date" value={d.endDate ?? ''} onChange={e => changeDetail('endDate', e.target.value || undefined)} /></label>
        <label><span className="label">交通方式</span><select className="input" value={d.travelMode} onChange={e => changeDetail('travelMode', e.target.value)}>{['高铁', '飞机', '自驾', '其他'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label><span className="label">出差人（可多选）</span><select multiple className="input h-28" value={d.travelerIds} onChange={e => changeDetail('travelerIds', [...e.target.selectedOptions].map(o => o.value))}>{people.map(p => <option key={p.id} value={p.id}>{p.name} · {p.role}</option>)}</select></label>
      </div>
      {itinerary.length > 0 && <div className="office-itinerary">{itinerary.map((item, index) => <div key={item.id} draggable onDragStart={event => event.dataTransfer.setData('text/plain', String(index))} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const from = Number(event.dataTransfer.getData('text/plain')); if (!Number.isInteger(from) || from === index) return; const ordered = itinerary.map(row => ({ ...row, id: /^[0-9a-f-]{36}$/i.test(row.id) ? row.id : crypto.randomUUID() })); const [moved] = ordered.splice(from, 1); ordered.splice(index, 0, moved); changeDetail('itinerary', ordered) }}><GripVertical size={15} /><b>{index + 1}</b><span>{item.from} → {item.to}</span><small>{item.date} · {item.transport}</small><button type="button" aria-label={`删除第 ${index + 1} 段行程`} onClick={() => changeDetail('itinerary', itinerary.filter((_, rowIndex) => rowIndex !== index).map(row => ({ ...row, id: /^[0-9a-f-]{36}$/i.test(row.id) ? row.id : crypto.randomUUID() })))}><Trash2 size={14} /></button></div>)}</div>}
      <div className="px-4 pb-4"><Button variant="secondary" onClick={() => changeDetail('itinerary', [...itinerary.map(row => ({ ...row, id: /^[0-9a-f-]{36}$/i.test(row.id) ? row.id : crypto.randomUUID() })), { id: crypto.randomUUID(), from: d.origin, to: d.destination, date: d.endDate ?? d.startDate ?? new Date().toISOString().slice(0, 10), transport: d.travelMode }])}><Plus className="h-4 w-4" />增加一段行程</Button></div>
      <div className="office-field-grid mt-4"><label><span className="label">出差事由模板</span><select className="input" value={d.purposeTemplate} onChange={e => { const key = e.target.value as keyof typeof templates['出差']; changeDetail('purposeTemplate', key); if (key) changeReason(templates['出差'][key]) }}><option value="">不使用模板</option>{Object.keys(templates['出差']).map(value => <option key={value}>{value}</option>)}</select></label><label><span className="label">会议通知链接</span><input className="input" type="url" value={d.invitationLink} onChange={e => changeDetail('invitationLink', e.target.value)} /></label></div>
    </section>
  }

  if (d.kind === '报销') return <section className="office-kind-section sm:col-span-2">
    <div className="office-section-title"><div><span>01</span><h3>费用明细</h3></div><small>总计 ¥{d.amount}</small></div>
    <div className="office-field-grid"><label><span className="label">关联前置单号</span><input className="input" value={d.linkedRequestId ?? ''} onChange={e => changeDetail('linkedRequestId', e.target.value || undefined)} placeholder="输入出差 / 招待 / 采购申请 ID" /></label><label><span className="label">电子发票 PDF 链接</span><input className="input" type="url" value={d.invoiceLink} onChange={e => changeDetail('invoiceLink', e.target.value)} /></label><label><span className="label">保存为我的模板</span><input className="input" value={d.templateName} onChange={e => changeDetail('templateName', e.target.value)} placeholder="例：月度交通补贴" /></label></div>
    <label className="block mt-4"><span className="label">报销项目说明</span><textarea className="textarea min-h-20" value={d.projectExplanation} onChange={e => changeDetail('projectExplanation', e.target.value)} placeholder="说明费用对应的项目、事项或业务成果" /></label>
    <div className="office-proof-links mt-4"><div className="office-section-title office-subtitle"><div><span>02</span><h3>证明材料链接</h3></div><small>可与下方文件一起提交</small></div>{d.proofLinks.map((link, index) => <div className="office-proof-link" key={index}><input className="input" type="url" aria-label={`证明材料链接 ${index + 1}`} placeholder="https://" value={link} onChange={e => changeDetail('proofLinks', d.proofLinks.map((value, row) => row === index ? e.target.value : value))}/><button type="button" aria-label={`删除证明材料链接 ${index + 1}`} onClick={() => changeDetail('proofLinks', d.proofLinks.filter((_, row) => row !== index))}><Trash2 size={15}/></button></div>)}<Button variant="secondary" onClick={() => changeDetail('proofLinks', [...d.proofLinks, ''])}><Plus className="h-4 w-4"/>添加材料链接</Button></div>
    <div className="expense-sheet">{d.items.map((item, index) => {
      const large = Number(item.amount) >= 1000
      const update = (field: string, value: unknown) => {
        const items = d.items.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row)
        changeDetail('items', items)
        if (field === 'amount') changeDetail('amount', moneyTotal(items.map(row => row.amount)))
      }
      return <div className={`expense-row ${large && !item.waterAttachmentId ? 'needs-water' : ''}`} key={item.id}>
        <b>{index + 1}</b>
        <input aria-label="发生日期" className="input" type="date" value={item.date} onChange={e => update('date', e.target.value)} />
        <input aria-label="费用类别" className="input" value={item.category} onChange={e => update('category', e.target.value)} placeholder="费用类别" />
        <input aria-label="明细说明" className="input" value={item.description} onChange={e => update('description', e.target.value)} placeholder="明细说明" />
        <input aria-label="金额" className="input" inputMode="decimal" value={item.amount} onChange={e => update('amount', e.target.value)} placeholder="金额" />
        <input aria-label="票据号" className="input" value={item.invoiceNumber} onChange={e => update('invoiceNumber', e.target.value)} placeholder="票据号" />
        <select aria-label="票据附件" className="input" value={item.attachmentId ?? ''} onChange={e => update('attachmentId', e.target.value || undefined)}><option value="">选票据</option>{attachments.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select>
        {large && <select aria-label="消费水单" className="input" value={item.waterAttachmentId ?? ''} onChange={e => update('waterAttachmentId', e.target.value || undefined)}><option value="">需附消费水单</option>{attachments.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select>}
        <span className="invoice-status">{item.verificationStatus}</span>
        <button type="button" aria-label="删除明细" onClick={() => { const items = d.items.filter((_, i) => i !== index); changeDetail('items', items); changeDetail('amount', moneyTotal(items.map(row => row.amount))) }}><Trash2 size={16} /></button>
      </div>
    })}</div>
    <Button variant="secondary" onClick={() => changeDetail('items', [...d.items, { id: crypto.randomUUID(), date: new Date().toISOString().slice(0, 10), category: '', description: '', amount: '0', invoiceNumber: '', verificationStatus: '待核验' }])}><Plus className="h-4 w-4" />增加明细</Button>
  </section>

  if (d.kind === '请假') {
    const computed = roundLeaveHours(d.startAt, d.endAt)
    const selectedBalance = leaveBalances.find(row => row.type === d.leaveType)
    return <section className="office-kind-section sm:col-span-2">
      <div className="office-section-title"><div><span>01</span><h3>日期与额度</h3></div><small>{computed ? `${computed} 小时` : '精确到 0.5 小时'}</small></div>
      <div className="leave-balance-strip">{leaveBalances.map(row => <div key={row.type} data-active={row.type === d.leaveType}><span>{row.type}</span><strong>{row.remainingDays == null ? '单独核定' : `${row.remainingDays} 天`}</strong><small>{row.allowanceDays == null ? '暂无固定额度' : `全年 ${row.allowanceDays} 天 · 已用 ${row.usedDays} 天`}</small></div>)}</div>
      <div className="office-field-grid">
        <label><span className="label">假期类型 *</span><select className="input" value={d.leaveType} onChange={e => changeDetail('leaveType', e.target.value)}><option value="">请选择</option>{['年假', '事假', '病假', '婚假', '产假', '调休'].map(value => { const balance = leaveBalances.find(row => row.type === value); return <option key={value}>{value}{balance?.remainingDays != null ? `（剩余 ${balance.remainingDays} 天）` : ''}</option>})}</select>{selectedBalance?.remainingDays != null && <small className="field-help">本次申请后预计剩余 {Math.max(0, selectedBalance.remainingDays - (Number(computed || d.hours || 0) / 8))} 天</small>}</label>
        <label><span className="label">开始时间 *</span><input className="input" type="datetime-local" value={d.startAt ?? ''} onChange={e => { changeDetail('startAt', e.target.value || undefined); changeDetail('hours', roundLeaveHours(e.target.value, d.endAt) || undefined) }} /></label>
        <label><span className="label">结束时间 *</span><input className="input" type="datetime-local" value={d.endAt ?? ''} onChange={e => { changeDetail('endAt', e.target.value || undefined); changeDetail('hours', roundLeaveHours(d.startAt, e.target.value) || undefined) }} /></label>
        <label><span className="label">请假时长</span><input className="input" readOnly value={computed || d.hours || ''} /></label>
      </div>
      <div className="office-section-title office-subtitle"><div><span>02</span><h3>工作交接</h3></div></div>
      <div className="office-field-grid"><label><span className="label">交接人</span><select className="input" value={d.handoverUserId ?? ''} onChange={e => changeDetail('handoverUserId', e.target.value || undefined)}><option value="">请选择</option>{people.map(p => <option key={p.id} value={p.id}>{p.name} · {p.role}</option>)}</select></label><label className="office-wide"><span className="label">交接事项</span><textarea className="textarea" value={d.handover} onChange={e => changeDetail('handover', e.target.value)} placeholder="日常工作由交接人代为处理，紧急事宜可电话联系我" /></label></div>
      {d.leaveType === '病假' && <label className="office-check mt-4"><input type="checkbox" checked={d.deferProof} onChange={e => changeDetail('deferProof', e.target.checked)} /><span>后补证明（1 个工作日内补齐）</span></label>}
    </section>
  }

  return <section className="office-kind-section sm:col-span-2"><div className="office-field-grid">{(['entity', 'counterparty', 'documentVersion', 'amount', 'currency', 'startDate', 'endDate', 'purpose'] as const).map(key => <label key={key}><span className="label">{{ entity: '申请主体', counterparty: '合同相对方', documentVersion: '合同版本', amount: '金额', currency: '币种', startDate: '开始日期', endDate: '结束日期', purpose: '用途' }[key]}</span><input className="input" type={key.endsWith('Date') ? 'date' : 'text'} value={String(d[key] ?? '')} onChange={e => changeDetail(key, e.target.value || (key.endsWith('Date') ? undefined : ''))} /></label>)}</div></section>
}
