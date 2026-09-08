import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { officeExpenseCategories, officeExpenseSupportingMaterial, officeLeaveDays, type OfficeDefinition } from '../../server/src/contracts/fdeOfficeContract'
import { Button } from './ui'

type Person = { id: string; name: string; role: string }
type Attachment = { id: string; name: string }
export type LeaveBalance = { type: string; allowanceDays: number | null; usedDays: number; remainingDays: number | null }
export type TravelRequestOption = { id: string; requestNo: string; title: string; projectName: string | null; startDate: string | null; endDate: string | null; destination: string }
type Props = {
  form: OfficeDefinition
  people: Person[]
  attachments: Attachment[]
  travelRequests?: TravelRequestOption[]
  leaveBalances?: LeaveBalance[]
  uploadExpenseMaterial?: (itemId: string, field: 'attachmentId' | 'waterAttachmentId', file: File) => void
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

export function FdeOfficeSmartFields({ form, people, attachments, travelRequests = [], leaveBalances = [], uploadExpenseMaterial, changeDetail, changeReason, changeTitle }: Props) {
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
      <div className="office-field-grid mt-4"><label className="office-wide"><span className="label">出差事由模板</span><select className="input" value={d.purposeTemplate} onChange={e => { const key = e.target.value as keyof typeof templates['出差']; changeDetail('purposeTemplate', key); if (key) changeReason(templates['出差'][key]) }}><option value="">不使用模板</option>{Object.keys(templates['出差']).map(value => <option key={value}>{value}</option>)}</select></label></div>
    </section>
  }

  if (d.kind === '报销') return <section className="office-kind-section expense-application sm:col-span-2">
    <div className="office-section-title"><div><span>01</span><h3>报销信息</h3></div><small>总计 ¥{d.amount}</small></div>
    <div className="expense-core-fields">
      <label data-office-field="reason"><span className="label">报销原因 *</span><textarea className="textarea min-h-24" value={form.reason} onChange={e => changeReason(e.target.value)} placeholder="说明本次报销的业务原因" /></label>
      <label data-office-field="projectExplanation"><span className="label">报销事项说明 *</span><textarea className="textarea min-h-24" value={d.projectExplanation} onChange={e => changeDetail('projectExplanation', e.target.value)} placeholder="说明费用发生事项及对应成果" /></label>
      <label data-office-field="linkedRequestId" className="expense-travel-link"><span className="label">关联出差申请（可选）</span><select className="input" value={d.linkedRequestId ?? ''} onChange={e => changeDetail('linkedRequestId', e.target.value || undefined)}><option value="">不关联出差申请</option>{travelRequests.map(request => <option key={request.id} value={request.id}>{request.requestNo} · {request.destination || request.title}{request.startDate ? ` · ${request.startDate}${request.endDate && request.endDate !== request.startDate ? ` 至 ${request.endDate}` : ''}` : ''}</option>)}</select>{d.linkedRequestId && !travelRequests.some(request => request.id === d.linkedRequestId) && <small className="field-help">当前关联单已保留；如不可选，可能已取消或不在本人权限内。</small>}</label>
    </div>
    <div className="expense-requirements" aria-label="报销材料要求"><span><b>机票</b>发票 + 行程单</span><span><b>酒店</b>发票 + 住宿单</span><span><b>打车</b>发票 + 行程单</span><span><b>其他</b>发票</span></div>
    <div className="office-section-title office-subtitle"><div><span>02</span><h3>报销事项</h3></div><small>{d.items.length} 项</small></div>
    <div className="expense-sheet">{d.items.map((item, index) => {
      const supportingMaterial = officeExpenseSupportingMaterial(item.category)
      const update = (field: string, value: unknown) => {
        const items = d.items.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row)
        changeDetail('items', items)
        if (field === 'amount') changeDetail('amount', moneyTotal(items.map(row => row.amount)))
      }
      return <article className={`expense-row ${supportingMaterial && !item.waterAttachmentId ? 'needs-supporting' : ''}`} key={item.id}>
        <header><b>报销事项 {index + 1}</b><button type="button" aria-label={`删除报销事项 ${index + 1}`} onClick={() => { const items = d.items.filter((_, i) => i !== index); changeDetail('items', items); changeDetail('amount', moneyTotal(items.map(row => row.amount))) }}><Trash2 size={15} />删除</button></header>
        <div className="expense-row-fields">
          <label><span className="label">费用类型 *</span><select aria-label="费用类型" className="input" value={item.category} onChange={e => { const category = e.target.value; changeDetail('items', d.items.map((row, rowIndex) => rowIndex === index ? { ...row, category, waterAttachmentId: officeExpenseSupportingMaterial(category) ? row.waterAttachmentId : undefined } : row)) }}>{!officeExpenseCategories.includes(item.category as typeof officeExpenseCategories[number]) && <option value={item.category}>{item.category}</option>}{officeExpenseCategories.map(category => <option key={category}>{category}</option>)}</select></label>
          <label><span className="label">发生日期 *</span><input aria-label="发生日期" className="input" type="date" value={item.date} onChange={e => update('date', e.target.value)} /></label>
          <label><span className="label">金额（元）*</span><input aria-label="金额" className="input" inputMode="decimal" value={item.amount} onChange={e => update('amount', e.target.value)} placeholder="0.00" /></label>
          <label className="expense-description"><span className="label">事项说明 *</span><input aria-label="事项说明" className="input" value={item.description} onChange={e => update('description', e.target.value)} placeholder="例：前往上海参加项目尽调" /></label>
        </div>
        <div className="expense-material-fields">
          <label><span className="label">发票 PDF *</span><div className="expense-material-control"><select aria-label="发票 PDF" className="input" value={item.attachmentId ?? ''} onChange={e => update('attachmentId', e.target.value || undefined)}><option value="">选择已上传发票</option>{attachments.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select>{uploadExpenseMaterial && <label className="expense-inline-upload">上传<input type="file" accept=".pdf,application/pdf" aria-label={`上传报销事项 ${index + 1} 发票 PDF`} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadExpenseMaterial(item.id, 'attachmentId', file) }} /></label>}</div></label>
          {supportingMaterial && <label><span className="label">{supportingMaterial} PDF *</span><div className="expense-material-control"><select aria-label={`${supportingMaterial} PDF`} className="input" value={item.waterAttachmentId ?? ''} onChange={e => update('waterAttachmentId', e.target.value || undefined)}><option value="">选择已上传{supportingMaterial}</option>{attachments.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select>{uploadExpenseMaterial && <label className="expense-inline-upload">上传<input type="file" accept=".pdf,application/pdf" aria-label={`上传报销事项 ${index + 1} ${supportingMaterial} PDF`} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadExpenseMaterial(item.id, 'waterAttachmentId', file) }} /></label>}</div></label>}
        </div>
      </article>
    })}</div>
    <Button variant="secondary" onClick={() => changeDetail('items', [...d.items, { id: crypto.randomUUID(), date: new Date().toISOString().slice(0, 10), category: '其他', description: '', amount: '0', invoiceNumber: '', verificationStatus: '待核验' }])}><Plus className="h-4 w-4" />增加报销事项</Button>
  </section>

  if (d.kind === '请假') {
    const computed = roundLeaveHours(d.startAt, d.endAt)
    const selectedBalance = leaveBalances.find(row => row.type === d.leaveType)
    return <section className="office-kind-section sm:col-span-2">
      <div className="office-section-title"><div><span>01</span><h3>请假信息</h3></div><small>{computed ? `${computed} 小时` : '精确到 0.5 小时'}</small></div>
      <div className="office-field-grid"><label data-office-field="reason" className="office-wide"><span className="label">申请原因 *</span><textarea className="textarea min-h-24" value={form.reason} onChange={e => changeReason(e.target.value)} placeholder="请填写请假原因" /></label></div>
      <div className="leave-balance-strip">{leaveBalances.map(row => <div key={row.type} data-active={row.type === d.leaveType}><span>{row.type}</span><strong>{row.remainingDays == null ? '单独核定' : `${row.remainingDays} 天`}</strong><small>{row.allowanceDays == null ? '暂无固定额度' : `全年 ${row.allowanceDays} 天 · 已用 ${row.usedDays} 天`}</small></div>)}</div>
      <div className="office-field-grid">
        <label><span className="label">假期类型 *</span><select className="input" value={d.leaveType} onChange={e => changeDetail('leaveType', e.target.value)}><option value="">请选择</option>{['年假', '事假', '病假', '婚假', '产假', '调休'].map(value => { const balance = leaveBalances.find(row => row.type === value); return <option key={value} value={value}>{value}{balance?.remainingDays != null ? `（剩余 ${balance.remainingDays} 天）` : ''}</option>})}</select>{selectedBalance?.remainingDays != null && <small className="field-help">本次申请后预计剩余 {Math.max(0, selectedBalance.remainingDays - officeLeaveDays(computed || d.hours))} 天</small>}</label>
        <label><span className="label">开始时间 *</span><input className="input" type="datetime-local" value={d.startAt ?? ''} onChange={e => { changeDetail('startAt', e.target.value || undefined); changeDetail('hours', roundLeaveHours(e.target.value, d.endAt) || undefined) }} /></label>
        <label><span className="label">结束时间 *</span><input className="input" type="datetime-local" value={d.endAt ?? ''} onChange={e => { changeDetail('endAt', e.target.value || undefined); changeDetail('hours', roundLeaveHours(d.startAt, e.target.value) || undefined) }} /></label>
        <label><span className="label">请假时长</span><input className="input" readOnly value={computed || d.hours || ''} /></label>
      </div>
      {d.leaveType === '病假' && <label className="office-check mt-4"><input type="checkbox" checked={d.deferProof} onChange={e => changeDetail('deferProof', e.target.checked)} /><span>后补证明（1 个工作日内补齐）</span></label>}
    </section>
  }

  return <section className="office-kind-section sm:col-span-2"><div className="office-field-grid">{(['entity', 'counterparty', 'documentVersion', 'amount', 'currency', 'startDate', 'endDate', 'purpose'] as const).map(key => <label key={key}><span className="label">{{ entity: '申请主体', counterparty: '合同相对方', documentVersion: '合同版本', amount: '金额', currency: '币种', startDate: '开始日期', endDate: '结束日期', purpose: '用途' }[key]}</span><input className="input" type={key.endsWith('Date') ? 'date' : 'text'} value={String(d[key] ?? '')} onChange={e => changeDetail(key, e.target.value || (key.endsWith('Date') ? undefined : ''))} /></label>)}</div></section>
}
