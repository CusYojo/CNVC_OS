import { Building2, Check, ChevronRight, Database, Download, FileText, KeyRound, LockKeyhole, Plus, RefreshCw, Search, Settings, ShieldCheck, UserCog, Users, Workflow } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useMemo, useState } from 'react'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, DataTable, Modal, PageHeader, SearchInput, StatusBadge, TableCell, Tabs } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'

const tabItems = [
  { id: 'users', label: '用户管理' },
  { id: 'org', label: '组织管理' },
  { id: 'roles', label: '角色权限' },
  { id: 'dicts', label: '数据字典' },
  { id: 'templates', label: '模板管理' },
  { id: 'audit', label: '审计日志' },
]

const dictionaryGroups = [
  { name: '项目阶段', code: 'PROJECT_STAGE', values: ['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出', '放弃'] },
  { name: '融资轮次', code: 'FINANCING_ROUND', values: ['天使轮', 'Pre-A', 'A 轮', 'B 轮', 'C 轮', 'Pre-IPO'] },
  { name: '风险等级', code: 'RISK_LEVEL', values: ['低', '中', '高'] },
  { name: '项目来源', code: 'PROJECT_SOURCE', values: ['机构推荐', 'FA', 'BP 邮箱', '行业会议', '产业方推荐', '手工录入'] },
  { name: '会议类型', code: 'MEETING_TYPE', values: ['项目沟通会', '立项会', '尽调会', '投委会', '董事会', '专家访谈'] },
]

const permissionRows = ['项目查看', '项目新增 / 编辑', '敏感估值字段', 'AI 问答与摘要', '材料生成 / 下载', '风险处置', '系统配置']
const roleColumns = ['投资经理', '投资总监', '风控法务', '系统管理员']

export function SystemPage() {
  const users = useAppStore((state) => state.users)
  const templates = useAppStore((state) => state.templates)
  const logs = useAppStore((state) => state.auditLogs)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const toggleUserStatus = useAppStore((state) => state.toggleUserStatus)
  const addUser = useAppStore((state) => state.addUser)
  const addAudit = useAppStore((state) => state.addAudit)
  const { showToast } = useToast()
  const [tab, setTab] = useState('users')
  const [query, setQuery] = useState('')
  const [showUser, setShowUser] = useState(false)
  const [permissions, setPermissions] = useState<Record<string, boolean>>({})
  const [userForm, setUserForm] = useState({ name: '', email: '', department: '科技投资组', role: '投资经理' })
  const filteredUsers = useMemo(() => users.filter((user) => !query || `${user.name}${user.email}${user.department}`.includes(query)), [users, query])
  const filteredLogs = useMemo(() => logs.filter((log) => !query || `${log.user}${log.module}${log.action}${log.target}`.includes(query)), [logs, query])

  const createUser = () => {
    if (!userForm.name || !userForm.email) return showToast('请填写姓名和邮箱', 'error')
    addUser({ ...userForm, status: '启用' })
    setShowUser(false)
    setUserForm({ name: '', email: '', department: '科技投资组', role: '投资经理' })
    showToast('用户已创建并分配默认权限')
  }

  const renderUsers = () => (
    <>
      <div className="mb-4 flex items-center gap-3"><SearchInput className="w-[320px]" placeholder="搜索姓名、邮箱或部门…" value={query} onChange={(event) => setQuery(event.target.value)} /><select className="input w-40"><option>全部部门</option><option>科技投资组</option><option>先进制造组</option><option>医疗投资组</option><option>平台运营部</option></select><select className="input w-36"><option>全部角色</option><option>投资经理</option><option>投资总监</option><option>分析师</option><option>系统管理员</option></select><Button variant="secondary" className="ml-auto"><Download className="h-4 w-4" />批量导入</Button><Button onClick={() => setShowUser(true)}><Plus className="h-4 w-4" />新增用户</Button></div>
      <Card className="overflow-hidden"><DataTable headers={['用户', '部门', '角色', '账号状态', '最后登录', '操作']}>{filteredUsers.map((user) => <tr key={user.id} className="hover:bg-slate-50"><TableCell><span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{user.name.slice(-2)}</span><span><span className="block font-medium text-slate-700">{user.name}{user.id === currentUser.id && <span className="ml-2 text-[10px] text-brand-500">当前用户</span>}</span><span className="mt-1 block text-xs text-slate-400">{user.email}</span></span></span></TableCell><TableCell>{user.department}</TableCell><TableCell><Badge tone={user.role === '系统管理员' ? 'purple' : 'blue'}>{user.role}</Badge></TableCell><TableCell><StatusBadge status={user.status} /></TableCell><TableCell>{user.lastLogin}</TableCell><TableCell><div className="flex items-center gap-2"><button className="text-xs text-brand-600">编辑</button><button disabled={user.id === currentUser.id} onClick={() => { toggleUserStatus(user.id); showToast(`用户已${user.status === '启用' ? '禁用' : '启用'}`) }} className="text-xs text-slate-500 disabled:opacity-30">{user.status === '启用' ? '禁用' : '启用'}</button><button className="text-xs text-slate-500">重置密码</button></div></TableCell></tr>)}</DataTable></Card>
    </>
  )

  const renderOrg = () => (
    <div className="grid grid-cols-[280px_1fr] gap-5">
      <Card className="p-4"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">组织架构</h3><Button size="sm" variant="secondary"><Plus className="h-3.5 w-3.5" /></Button></div><div className="mt-4 space-y-1"><div className="rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700"><span className="block">浙江赛智伯乐股权投资管理有限公司</span><span className="mt-1 block text-[9px] font-normal text-brand-500">Zhejiang Saizhi Cybernaut Equity Investment Management Co., Ltd.</span></div>{['投资业务部', '投研中心', '风险控制部', '平台运营部'].map((dept, index) => <div key={dept}><button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><ChevronRight className="h-3.5 w-3.5 text-slate-400" />{dept}<span className="ml-auto text-xs text-slate-400">{[14, 6, 5, 4][index]}</span></button>{index === 0 && <div className="ml-6 space-y-1">{['科技投资组', '先进制造组', '医疗投资组'].map((team) => <button key={team} className="block w-full rounded-lg px-3 py-2 text-left text-xs text-slate-500 hover:bg-slate-50">{team}</button>)}</div>}</div>)}</div></Card>
      <Card className="p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold text-slate-800">投资业务部</h3><p className="mt-1 text-xs text-slate-400">负责项目获取、研究、尽调与投资决策执行</p></div><Button variant="secondary" size="sm">编辑部门</Button></div><div className="mt-6 grid grid-cols-3 gap-4">{[['部门负责人', '陈思齐', UserCog], ['团队数量', '3 个', Users], ['在职成员', '14 人', Users]].map(([label, value, Icon]) => { const C = Icon as typeof Users; return <div key={label as string} className="rounded-xl bg-slate-50 p-4"><C className="h-4 w-4 text-brand-600" /><p className="mt-3 text-xs text-slate-400">{label as string}</p><p className="mt-1 font-semibold text-slate-700">{value as string}</p></div> })}</div><div className="mt-6"><h4 className="text-sm font-semibold text-slate-700">部门成员</h4><div className="mt-3 divide-y divide-slate-100">{users.filter((user) => user.department.includes('投资组')).map((user) => <div key={user.id} className="flex items-center py-3"><span className="grid h-8 w-8 place-items-center rounded-full bg-brand-50 text-xs text-brand-700">{user.name.slice(-2)}</span><span className="ml-3 text-sm font-medium text-slate-700">{user.name}</span><Badge tone="blue">{user.department}</Badge><span className="ml-auto text-xs text-slate-400">{user.role}</span></div>)}</div></div></Card>
    </div>
  )

  const renderRoles = () => (
    <Card className="overflow-hidden"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h3 className="font-semibold text-slate-800">角色权限矩阵</h3><p className="mt-1 text-xs text-slate-400">控制菜单、操作、数据范围和敏感字段权限</p></div><Button onClick={() => { addAudit('系统管理', '权限变更', '保存角色权限矩阵'); showToast('角色权限已保存并写入审计日志') }}>保存权限</Button></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-slate-200 bg-slate-50"><th className="px-5 py-3 text-left text-xs text-slate-500">权限项</th>{roleColumns.map((role) => <th key={role} className="px-5 py-3 text-center text-xs text-slate-500">{role}</th>)}</tr></thead><tbody>{permissionRows.map((permission, row) => <tr key={permission} className="border-b border-slate-100 last:border-0"><td className="px-5 py-4 font-medium text-slate-700">{permission}</td>{roleColumns.map((role, col) => { const key = `${row}-${col}`; const defaultChecked = col === 3 || (row < 2 && col < 3) || (row === 3 && col < 2) || (row === 4 && col < 2) || (row === 5 && col > 0); const checked = permissions[key] ?? defaultChecked; return <td key={role} className="px-5 py-4 text-center"><button onClick={() => setPermissions({ ...permissions, [key]: !checked })} className={`mx-auto grid h-5 w-5 place-items-center rounded border ${checked ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-transparent'}`}><Check className="h-3.5 w-3.5" /></button></td> })}</tr>)}</tbody></table></div><div className="border-t border-slate-100 bg-slate-50 px-5 py-4"><div className="grid grid-cols-3 gap-4 text-xs"><div className="flex gap-2"><LockKeyhole className="h-4 w-4 text-slate-400" /><span><strong className="block text-slate-600">数据范围</strong><span className="mt-1 block text-slate-400">本人 / 团队 / 部门 / 全部</span></span></div><div className="flex gap-2"><KeyRound className="h-4 w-4 text-slate-400" /><span><strong className="block text-slate-600">字段权限</strong><span className="mt-1 block text-slate-400">估值和金额按角色脱敏</span></span></div><div className="flex gap-2"><ShieldCheck className="h-4 w-4 text-slate-400" /><span><strong className="block text-slate-600">变更审计</strong><span className="mt-1 block text-slate-400">每次保存记录操作人</span></span></div></div></div></Card>
  )

  const renderDicts = () => <div className="grid grid-cols-2 gap-4">{dictionaryGroups.map((group) => <Card key={group.code} className="p-5"><div className="flex items-start justify-between"><div><h3 className="text-sm font-semibold text-slate-800">{group.name}</h3><p className="mt-1 text-[10px] text-slate-400">{group.code}</p></div><button className="text-xs text-brand-600">管理</button></div><div className="mt-4 flex flex-wrap gap-2">{group.values.map((value) => <Badge key={value}>{value}</Badge>)}<button className="rounded-md border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-400">+ 添加</button></div></Card>)}</div>

  const renderTemplates = () => <Card className="overflow-hidden"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h3 className="font-semibold text-slate-800">机构模板</h3><p className="mt-1 text-xs text-slate-400">管理上会材料、会议纪要和 AI Prompt 模板</p></div><Button><Plus className="h-4 w-4" />上传模板</Button></div><DataTable headers={['模板名称', '模板类型', '当前版本', '状态', '更新时间', '操作']}>{templates.map((template) => <tr key={template.id}><TableCell><span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-50 text-brand-600"><FileText className="h-4 w-4" /></span><span className="font-medium text-slate-700">{template.name}</span></span></TableCell><TableCell><Badge tone="blue">{template.type}</Badge></TableCell><TableCell>{template.version}</TableCell><TableCell><StatusBadge status={template.status} /></TableCell><TableCell>{template.updatedAt}</TableCell><TableCell><div className="flex gap-3"><button className="text-xs text-brand-600">编辑</button><button className="text-xs text-slate-500">版本记录</button><button className="text-xs text-slate-500">停用</button></div></TableCell></tr>)}</DataTable></Card>

  const renderAudit = () => <><div className="mb-4 flex gap-3"><SearchInput className="w-[340px]" placeholder="搜索用户、模块、操作或对象…" value={query} onChange={(event) => setQuery(event.target.value)} /><select className="input w-40"><option>全部模块</option><option>项目管理</option><option>AI 工具箱</option><option>风险预警</option><option>系统管理</option></select><input className="input w-44" value="2026-06-01 至今" readOnly /><Button variant="secondary" className="ml-auto"><Download className="h-4 w-4" />导出日志</Button></div><Card className="overflow-hidden"><DataTable headers={['操作时间', '操作用户', '模块', '操作类型', '对象 / 内容', 'IP 地址']}>{filteredLogs.slice(0, 30).map((log) => <tr key={log.id}><TableCell><span className="whitespace-nowrap text-xs">{log.createdAt}</span></TableCell><TableCell><span className="font-medium text-slate-700">{log.user}</span></TableCell><TableCell><Badge>{log.module}</Badge></TableCell><TableCell>{log.action}</TableCell><TableCell><span className="block max-w-[420px] truncate">{log.target}</span></TableCell><TableCell><span className="font-mono text-xs text-slate-400">{log.ip}</span></TableCell></tr>)}</DataTable></Card></>

  const contents: Record<string, () => React.ReactNode> = { users: renderUsers, org: renderOrg, roles: renderRoles, dicts: renderDicts, templates: renderTemplates, audit: renderAudit }

  return (
    <div>
      <PageHeader title="系统管理" description="维护组织、账号、权限、字典、模板与审计记录，支撑一期安全上线。" actions={<Button variant="secondary"><Database className="h-4 w-4" />数据源状态</Button>} />
      <Card className="mb-5 px-4"><Tabs tabs={tabItems.map((item) => ({ ...item, count: item.id === 'users' ? users.length : item.id === 'templates' ? templates.length : item.id === 'audit' ? logs.length : undefined }))} value={tab} onChange={(value) => { setTab(value); setQuery('') }} /></Card>
      {contents[tab]?.()}
      <Modal open={showUser} title="新增系统用户" onClose={() => setShowUser(false)} footer={<><Button variant="secondary" onClick={() => setShowUser(false)}>取消</Button><Button onClick={createUser}>创建用户</Button></>}>
        <div className="space-y-4"><label><span className="label">姓名</span><input className="input" value={userForm.name} onChange={(event) => setUserForm({ ...userForm, name: event.target.value })} /></label><label><span className="label">工作邮箱</span><input className="input" type="email" value={userForm.email} onChange={(event) => setUserForm({ ...userForm, email: event.target.value })} /></label><div className="grid grid-cols-2 gap-4"><label><span className="label">所属部门</span><select className="input" value={userForm.department} onChange={(event) => setUserForm({ ...userForm, department: event.target.value })}><option>科技投资组</option><option>先进制造组</option><option>医疗投资组</option><option>风险控制部</option><option>平台运营部</option></select></label><label><span className="label">角色</span><select className="input" value={userForm.role} onChange={(event) => setUserForm({ ...userForm, role: event.target.value })}><option>投资经理</option><option>投资总监</option><option>分析师</option><option>风控法务</option><option>系统管理员</option></select></label></div><p className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">创建后账号默认启用，系统会发送首次登录邀请。此演示版本不会实际发送邮件。</p></div>
      </Modal>
    </div>
  )
}
