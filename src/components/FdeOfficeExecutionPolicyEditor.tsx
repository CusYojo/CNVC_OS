import { officeExecutionFields, type OfficeExecutionPolicy } from '../../server/src/contracts/fdeOfficeExecutionContract'
import { Button } from './ui'

type Props = { kind: keyof typeof officeExecutionFields; value: OfficeExecutionPolicy | undefined; onChange: (value: OfficeExecutionPolicy | undefined) => void;
  roles: Array<{ id: string; name: string }>; people: Array<{ id: string; name: string; role: string }> }
export function FdeOfficeExecutionPolicyEditor({ kind, value, onChange, roles, people }: Props) {
  return <section className="space-y-3 rounded-xl border border-amber-200 p-4">
    <h3 className="text-sm font-semibold">独立执行记录规则</h3>
    {!value ? <Button variant="secondary" onClick={() => onChange({ enabled: false, roleIds: [], userIds: [], scope: 'applicant_department', requiredFields: [], authorizationNote: '' })}>添加执行记录规则（默认关闭）</Button> : <>
      <label className="block text-sm"><input type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })} /> 已取得业务确认，明确启用本规则的人工执行记录</label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label><span className="label">执行业务岗位（必选）</span><select multiple className="input h-28" value={value.roleIds} onChange={e => onChange({ ...value, roleIds: [...e.target.selectedOptions].map(o => o.value) })}>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label><span className="label">明确指定账号（必选，同时须具有上述岗位）</span><select multiple className="input h-28" value={value.userIds} onChange={e => onChange({ ...value, userIds: [...e.target.selectedOptions].map(o => o.value) })}>{people.map(p => <option key={p.id} value={p.id}>{p.name} · {p.role}</option>)}</select></label>
        <label><span className="label">授权组织范围</span><select className="input" value={value.scope} onChange={e => onChange({ ...value, scope: e.target.value as OfficeExecutionPolicy['scope'] })}><option value="applicant_department">申请人提交时所属部门</option><option value="institution">机构内</option></select></label>
      </div>
      <div className="flex flex-wrap gap-3">{officeExecutionFields[kind].map(key => <label key={key} className="text-xs"><input type="checkbox" checked={value.requiredFields.includes(key)} onChange={e => onChange({ ...value, requiredFields: e.target.checked ? [...value.requiredFields, key] : value.requiredFields.filter(k => k !== key) })} /> 执行必填：{key}</label>)}</div>
      <label className="block"><span className="label">业务授权依据（至少十字，不能用演示规则代替）</span><textarea className="textarea" value={value.authorizationNote} onChange={e => onChange({ ...value, authorizationNote: e.target.value })} /></label>
      <Button variant="secondary" onClick={() => onChange(undefined)}>本草稿不配置执行记录</Button>
    </>}
  </section>
}
