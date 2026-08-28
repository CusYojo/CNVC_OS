import {
  Building2, Check, Database, FileText, Plus, RefreshCw, RotateCcw, Search, UserCog, Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FDE_ROLE_CATEGORIES, type FdeRoleCategory } from '../../server/src/contracts/fdeGovernanceContract'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, DataTable, Modal, PageHeader, SearchInput, StatusBadge, TableCell, Tabs } from '../components/ui'
import { apiGet, apiPatch, apiPost, apiPut } from '../lib/api'
import { formatShanghaiDateTime } from '../lib/dateTime'
import { getSystemWorkspace, resolveSystemTab } from '../lib/systemWorkspaces'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore } from '../store/useAuthStore'
import type { User } from '../types'
import { FdePolicyPanel } from '../components/FdePolicyPanel'
import { FdeTypePolicyPanel } from '../components/FdeTypePolicyPanel'
import { FdeOfficePolicyPanel } from '../components/FdeOfficePolicyPanel'
import { FdeResponsibilityPolicyPanel } from '../components/FdeResponsibilityPolicyPanel'
import '../components/fde-workspace.css'

type Department = {
  id: string; code: string; name: string; parentId: string | null; managerUserId: string | null;
  description: string | null; status: '启用' | '禁用'; sortOrder: number; version: number; memberCount: number;
}
type Permission = { id: string; code: string; name: string; module: string; action: string; description: string | null }
type Role = {
  id: string; code: string; name: string; description: string | null; dataScope: 'self' | 'department' | 'all';
  builtIn: boolean; status: '启用' | '禁用'; version: number; memberCount: number; permissionIds: string[];
  fdeCategory: FdeRoleCategory | null;
}
type DictionaryItem = {
  id: string; groupId: string; value: string; label: string; sortOrder: number; status: '启用' | '禁用';
  builtIn: boolean; version: number;
}
type DictionaryGroup = {
  id: string; code: string; name: string; description: string | null; status: '启用' | '禁用';
  version: number; items: DictionaryItem[];
}
type RoleBinding = { userId: string; roleId: string; isPrimary: boolean }
type Administration = { departments: Department[]; roles: Role[]; permissions: Permission[]; dictionaries: DictionaryGroup[]; userRoleBindings: RoleBinding[] }
type LeadRatingHistory = {
  id: string; snapshotId: string; snapshotHash: string; ratingSchemaVersion: string;
  status: string; result: unknown; completedAt: string;
}
type LeadRatingHistoryResponse = { leadId: string; ratings: LeadRatingHistory[]; total: number }

const emptyAdministration: Administration = { departments: [], roles: [], permissions: [], dictionaries: [], userRoleBindings: [] }
const field = 'input w-full'
const tabItems = [
  { id: 'users', label: '用户管理' }, { id: 'org', label: '组织管理' },
  { id: 'roles', label: '角色权限' }, { id: 'dicts', label: '数据字典' },
  { id: 'templates', label: '模板管理' }, { id: 'audit', label: '审计日志' },
  { id: 'rating-recovery', label: 'V3评分恢复' },
  { id: 'workflow-rules', label: '流程与周期规则' },
  { id: 'type-rules', label: '非投资流程模板' },
  { id: 'office-rules', label: '办公审批规则' },
  { id: 'responsibility-rules', label: '责任规则' },
]
const categoryLabel = (category: string | null) => FDE_ROLE_CATEGORIES.find((item) => item.code === category)?.label ?? '兼容角色（未映射）'

function displayTime(value: string | null | undefined) {
  if (!value) return '尚未登录'
  try { return formatShanghaiDateTime(value) } catch { return '—' }
}

function ratingHistoryScore(value: unknown) {
  const result = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const ratingV3 = result.ratingV3 && typeof result.ratingV3 === 'object' && !Array.isArray(result.ratingV3)
    ? result.ratingV3 as Record<string, unknown> : {}
  const computed = ratingV3.computed && typeof ratingV3.computed === 'object' && !Array.isArray(ratingV3.computed)
    ? ratingV3.computed as Record<string, unknown> : {}
  const score = Number(computed.score ?? result.total)
  return Number.isFinite(score) ? score : null
}

export function SystemPage() {
  const users = useAppStore((state) => state.users)
  const templates = useAppStore((state) => state.templates)
  const logs = useAppStore((state) => state.auditLogs)
  const hydrate = useAppStore((state) => state.hydrateFromServer)
  const currentUser = useAuthStore((state) => state.user)
  const { showToast } = useToast()
  const [administration, setAdministration] = useState<Administration>(emptyAdministration)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const tab = resolveSystemTab(requestedTab)
  useEffect(() => {
    if (requestedTab !== 'operations' && requestedTab !== 'integrations-overview') return
    const next = new URLSearchParams(searchParams)
    next.set('tab', 'audit')
    setSearchParams(next, { replace: true })
  }, [requestedTab, searchParams, setSearchParams])
  const workspace = getSystemWorkspace(tab)
  const setTab = (value: string) => { const next = new URLSearchParams(searchParams); next.set('tab', value); setSearchParams(next); setQuery('') }
  const [query, setQuery] = useState('')
  useEffect(() => { setQuery('') }, [tab])
  const [userModal, setUserModal] = useState<{ mode: 'create' | 'edit'; user?: User } | null>(null)
  const [userForm, setUserForm] = useState({ name: '', email: '', department: '', role: '', password: '', status: '启用' as '启用' | '禁用' })
  const [passwordUser, setPasswordUser] = useState<User | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [departmentModal, setDepartmentModal] = useState<Department | 'create' | null>(null)
  const [departmentForm, setDepartmentForm] = useState({ code: '', name: '', parentId: '', description: '', sortOrder: '0', status: '启用' as '启用' | '禁用' })
  const [roleModal, setRoleModal] = useState<Role | 'create' | null>(null)
  const [roleForm, setRoleForm] = useState({ code: '', name: '', description: '', dataScope: 'self' as Role['dataScope'], fdeCategory: '' as FdeRoleCategory | '', status: '启用' as '启用' | '禁用', permissionIds: [] as string[] })
  const [bindingUser, setBindingUser] = useState<User | null>(null)
  const [bindingForm, setBindingForm] = useState({ primaryRoleId: '', roleIds: [] as string[], expectedRoleIds: [] as string[], expectedPrimaryRoleId: null as string | null })
  const [dictionaryModal, setDictionaryModal] = useState<DictionaryGroup | 'create' | null>(null)
  const [dictionaryForm, setDictionaryForm] = useState({ code: '', name: '', description: '', status: '启用' as '启用' | '禁用' })
  const [itemModal, setItemModal] = useState<{ group: DictionaryGroup; item?: DictionaryItem } | null>(null)
  const [itemForm, setItemForm] = useState({ value: '', label: '', sortOrder: '0', status: '启用' as '启用' | '禁用' })
  const [ratingLeadId, setRatingLeadId] = useState('')
  const [ratingHistory, setRatingHistory] = useState<LeadRatingHistory[]>([])
  const [ratingHistoryLoading, setRatingHistoryLoading] = useState(false)
  const [ratingRestoreTarget, setRatingRestoreTarget] = useState<LeadRatingHistory | null>(null)
  const [ratingRestoreReason, setRatingRestoreReason] = useState('')

  const refreshAdministration = useCallback(async () => {
    setLoading(true)
    try { setAdministration(await apiGet<Administration>('/system-administration')) }
    catch (error) { showToast((error as Error).message, 'error') }
    finally { setLoading(false) }
  }, [showToast])
  useEffect(() => { void refreshAdministration() }, [refreshAdministration])

  async function mutate(action: () => Promise<unknown>, success: string, refreshUsers = false) {
    setBusy(true)
    try {
      await action()
      if (refreshUsers) await hydrate()
      await refreshAdministration()
      showToast(success)
      return true
    } catch (error) {
      showToast((error as Error).message, 'error')
      return false
    } finally { setBusy(false) }
  }

  const normalizedQuery = query.trim().toLowerCase()
  const matches = (value: string) => !normalizedQuery || value.toLowerCase().includes(normalizedQuery)
  const filteredUsers = useMemo(() => users.filter((user) => matches(`${user.name}${user.email}${user.department}${user.role}`)), [users, normalizedQuery])
  const filteredTemplates = useMemo(() => templates.filter((item) => matches(`${item.name}${item.type}${item.version}`)), [templates, normalizedQuery])
  const filteredLogs = useMemo(() => logs.filter((item) => matches(`${item.user}${item.module}${item.action}${item.target}`)), [logs, normalizedQuery])
  const enabledRoles = administration.roles.filter((role) => role.status === '启用')
  const enabledDepartments = administration.departments.filter((department) => department.status === '启用')

  function openUser(user?: User) {
    setUserForm(user ? { ...user, password: '' } : {
      name: '', email: '', department: enabledDepartments[0]?.name || '', role: enabledRoles[0]?.name || '', password: '', status: '启用',
    })
    setUserModal({ mode: user ? 'edit' : 'create', user })
  }

  async function saveUser() {
    const editing = userModal?.mode === 'edit' && userModal.user
    const ok = await mutate(
      () => editing
        ? apiPatch(`/users/${editing.id}`, { name: userForm.name, role: userForm.role, department: userForm.department, status: userForm.status })
        : apiPost('/users', { name: userForm.name, email: userForm.email, role: userForm.role, department: userForm.department, password: userForm.password }),
      editing ? '用户身份已更新，原会话已按需失效。' : '用户已创建并纳入组织与角色关系。', true,
    )
    if (ok) setUserModal(null)
  }

  function openDepartment(department?: Department) {
    setDepartmentForm(department ? {
      code: department.code, name: department.name, parentId: department.parentId || '', description: department.description || '',
      sortOrder: String(department.sortOrder), status: department.status,
    } : { code: '', name: '', parentId: '', description: '', sortOrder: '0', status: '启用' })
    setDepartmentModal(department || 'create')
  }

  async function saveDepartment() {
    const editing = departmentModal !== 'create' ? departmentModal : null
    const payload = {
      name: departmentForm.name, parentId: departmentForm.parentId || null, description: departmentForm.description || null,
      sortOrder: Number(departmentForm.sortOrder), status: departmentForm.status,
    }
    const ok = await mutate(
      () => editing
        ? apiPatch(`/system-administration/departments/${editing.id}`, { ...payload, expectedVersion: editing.version })
        : apiPost('/system-administration/departments', { ...payload, code: departmentForm.code }),
      editing ? '部门已更新。' : '部门已创建。',
    )
    if (ok) setDepartmentModal(null)
  }

  function openRole(role?: Role) {
    setRoleForm(role ? {
      code: role.code, name: role.name, description: role.description || '', dataScope: role.dataScope,
      status: role.status, permissionIds: role.permissionIds, fdeCategory: role.fdeCategory ?? '',
    } : { code: '', name: '', description: '', dataScope: 'self', fdeCategory: '', status: '启用', permissionIds: [] })
    setRoleModal(role || 'create')
  }

  async function saveRole() {
    const editing = roleModal !== 'create' ? roleModal : null
    const payload = {
      name: roleForm.name, description: roleForm.description || null, dataScope: roleForm.dataScope,
      status: roleForm.status, permissionIds: roleForm.permissionIds,
      fdeCategory: roleForm.fdeCategory || null,
    }
    const ok = await mutate(
      () => editing
        ? apiPatch(`/system-administration/roles/${editing.id}`, { ...payload, expectedVersion: editing.version })
        : apiPost('/system-administration/roles', { ...payload, code: roleForm.code }),
      editing ? '角色权限已保存。' : '角色已创建。',
    )
    if (ok) setRoleModal(null)
  }

  function openBindings(user: User) {
    const bindings = administration.userRoleBindings.filter((item) => item.userId === user.id)
    const primaryRoleId = bindings.find((item) => item.isPrimary)?.roleId ?? null
    setBindingForm({ primaryRoleId: primaryRoleId ?? '', roleIds: bindings.map((item) => item.roleId), expectedRoleIds: bindings.map((item) => item.roleId), expectedPrimaryRoleId: primaryRoleId })
    setBindingUser(user)
  }

  async function saveBindings() {
    if (!bindingUser) return
    const ok = await mutate(() => apiPut(`/system-administration/users/${bindingUser.id}/roles`, bindingForm), '角色绑定已保存；相关旧会话已失效。', true)
    if (ok) setBindingUser(null)
  }

  function openDictionary(group?: DictionaryGroup) {
    setDictionaryForm(group ? { code: group.code, name: group.name, description: group.description || '', status: group.status }
      : { code: '', name: '', description: '', status: '启用' })
    setDictionaryModal(group || 'create')
  }

  async function saveDictionary() {
    const editing = dictionaryModal !== 'create' ? dictionaryModal : null
    const payload = { name: dictionaryForm.name, description: dictionaryForm.description || null, status: dictionaryForm.status }
    const ok = await mutate(
      () => editing
        ? apiPatch(`/system-administration/dictionaries/${editing.id}`, { ...payload, expectedVersion: editing.version })
        : apiPost('/system-administration/dictionaries', { ...payload, code: dictionaryForm.code }),
      editing ? '字典分组已更新。' : '字典分组已创建。',
    )
    if (ok) setDictionaryModal(null)
  }

  async function saveDictionaryItem() {
    if (!itemModal) return
    const payload = { label: itemForm.label, sortOrder: Number(itemForm.sortOrder), status: itemForm.status }
    const ok = await mutate(
      () => itemModal.item
        ? apiPatch(`/system-administration/dictionary-items/${itemModal.item.id}`, { ...payload, expectedVersion: itemModal.item.version })
        : apiPost(`/system-administration/dictionaries/${itemModal.group.id}/items`, { ...payload, value: itemForm.value }),
      itemModal.item ? '字典项已更新。' : '字典项已新增。',
    )
    if (ok) setItemModal(null)
  }

  async function loadRatingHistory() {
    const leadId = ratingLeadId.trim()
    if (!leadId) return
    setRatingHistoryLoading(true)
    try {
      const result = await apiGet<LeadRatingHistoryResponse>(`/leads/${leadId}/ratings/history?page=1&pageSize=50`)
      setRatingHistory(result.ratings)
      if (!result.ratings.length) showToast('该线索尚无可恢复的V3历史评级。')
    } catch (error) {
      setRatingHistory([])
      showToast((error as Error).message, 'error')
    } finally { setRatingHistoryLoading(false) }
  }

  async function restoreRatingHistory() {
    if (!ratingRestoreTarget || ratingRestoreReason.trim().length < 4) return
    setBusy(true)
    try {
      await apiPost(`/leads/${ratingLeadId.trim()}/ratings/history/${ratingRestoreTarget.id}/restore`, {
        reason: ratingRestoreReason.trim(),
      })
      setRatingRestoreTarget(null)
      setRatingRestoreReason('')
      await loadRatingHistory()
      showToast('已恢复所选V3历史评级；事实、证据和快照未被修改。')
    } catch (error) {
      showToast((error as Error).message, 'error')
    } finally { setBusy(false) }
  }

  const toolbar = (placeholder: string, actions?: React.ReactNode) => <div className="mb-4 flex items-center gap-3">
    <SearchInput className="w-[360px]" placeholder={placeholder} value={query} onChange={(event) => setQuery(event.target.value)} />
    <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-400"><Database className="h-3.5 w-3.5" />MySQL 权威数据</span>
    {actions}
  </div>

  const renderUsers = () => <>
    {toolbar('搜索姓名、邮箱、部门或角色…', <Button onClick={() => openUser()}><Plus className="h-4 w-4" />新增用户</Button>)}
    <Card className="overflow-hidden"><DataTable headers={['用户', '部门', '角色', '账号状态', '最后登录', '操作']}>
      {filteredUsers.map((user) => <tr key={user.id}>
        <TableCell><span className="font-medium text-slate-700">{user.name}{user.id === currentUser?.id && <span className="ml-2 text-[10px] text-brand-500">当前用户</span>}</span><span className="mt-1 block text-xs text-slate-400">{user.email}</span></TableCell>
        <TableCell>{user.department}</TableCell><TableCell><div className="flex flex-wrap gap-1">{administration.userRoleBindings.filter((item) => item.userId === user.id).map((binding) => <Badge key={binding.roleId} tone={binding.isPrimary ? 'blue' : 'slate'}>{administration.roles.find((role) => role.id === binding.roleId)?.name ?? '未知角色'}{binding.isPrimary ? ' · 主' : ''}</Badge>)}</div></TableCell>
        <TableCell><StatusBadge status={user.status} /></TableCell><TableCell>{displayTime(user.lastLogin)}</TableCell>
        <TableCell><div className="flex flex-wrap gap-3"><button className="text-xs text-brand-600" onClick={() => openUser(user)}>编辑</button><button className="text-xs text-brand-600" onClick={() => openBindings(user)}>角色与范围</button><button className="text-xs text-slate-500" onClick={() => { setPasswordUser(user); setNewPassword('') }}>重置密码</button></div></TableCell>
      </tr>)}
    </DataTable></Card>
  </>

  const renderOrganization = () => <>
    <div className="mb-4 flex justify-end"><Button onClick={() => openDepartment()}><Plus className="h-4 w-4" />新增部门</Button></div>
    <Card className="overflow-hidden"><DataTable headers={['部门', '编码', '上级部门', '成员', '状态', '排序', '操作']}>
      {administration.departments.map((department) => <tr key={department.id}>
        <TableCell><span className="font-medium text-slate-700">{department.name}</span><span className="mt-1 block text-xs text-slate-400">{department.description || '—'}</span></TableCell>
        <TableCell><span className="font-mono text-xs">{department.code}</span></TableCell>
        <TableCell>{administration.departments.find((item) => item.id === department.parentId)?.name || '顶级部门'}</TableCell>
        <TableCell>{department.memberCount}</TableCell><TableCell><StatusBadge status={department.status} /></TableCell><TableCell>{department.sortOrder}</TableCell>
        <TableCell><button className="text-xs text-brand-600" onClick={() => openDepartment(department)}>编辑</button></TableCell>
      </tr>)}
    </DataTable></Card>
  </>

  const renderRoles = () => <>
    <div className="mb-4 flex items-center gap-3"><p className="text-xs text-slate-500">机构角色决定职责资格；项目分工与资源 ACL 决定实际可见内容。管理员身份不自动授予投资资料。</p><Button className="ml-auto" onClick={() => openRole()}><Plus className="h-4 w-4" />新增角色</Button></div>
    <Card className="overflow-x-auto"><DataTable headers={['角色', '编码', 'FDE 职责类别', '数据范围', '成员', '权限数', '状态', '操作']}>
      {administration.roles.map((role) => <tr key={role.id}>
        <TableCell><span className="font-medium text-slate-700">{role.name}</span>{role.builtIn && <Badge tone="slate">内置</Badge>}<span className="mt-1 block text-xs text-slate-400">{role.description || '—'}</span></TableCell>
        <TableCell><span className="font-mono text-xs">{role.code}</span></TableCell><TableCell><Badge>{categoryLabel(role.fdeCategory)}</Badge></TableCell><TableCell>{role.dataScope === 'all' ? '授权全量' : role.dataScope === 'department' ? '本部门' : '本人/项目职责'}</TableCell>
        <TableCell>{role.memberCount}</TableCell><TableCell>{role.permissionIds.length}</TableCell><TableCell><StatusBadge status={role.status} /></TableCell>
        <TableCell><button className="text-xs text-brand-600" onClick={() => openRole(role)}>配置权限</button></TableCell>
      </tr>)}
    </DataTable></Card>
  </>

  const renderDictionaries = () => <>
    <div className="mb-4 flex justify-end"><Button onClick={() => openDictionary()}><Plus className="h-4 w-4" />新增字典</Button></div>
    <div className="grid grid-cols-2 gap-4">{administration.dictionaries.map((group) => <Card key={group.id} className="p-5">
      <div className="flex items-start"><div><h3 className="font-semibold text-slate-800">{group.name}</h3><p className="mt-1 font-mono text-[10px] text-slate-400">{group.code} · v{group.version}</p></div><StatusBadge status={group.status} /><button className="ml-auto text-xs text-brand-600" onClick={() => openDictionary(group)}>编辑</button></div>
      <div className="mt-4 space-y-2">{group.items.map((item) => <button key={item.id} className="flex w-full items-center rounded-lg bg-slate-50 px-3 py-2 text-left text-xs" onClick={() => { setItemModal({ group, item }); setItemForm({ value: item.value, label: item.label, sortOrder: String(item.sortOrder), status: item.status }) }}><span className="font-medium text-slate-700">{item.label}</span><span className="ml-2 font-mono text-slate-400">{item.value}</span><StatusBadge status={item.status} /><span className="ml-auto text-slate-400">#{item.sortOrder}</span></button>)}</div>
      <button className="mt-3 text-xs text-brand-600" onClick={() => { setItemModal({ group }); setItemForm({ value: '', label: '', sortOrder: String((group.items.at(-1)?.sortOrder || 0) + 10), status: '启用' }) }}>+ 新增字典项</button>
    </Card>)}</div>
  </>

  const renderTemplates = () => <>{toolbar('搜索模板名称、类型或版本…')}<Card className="overflow-hidden"><DataTable headers={['模板名称', '输出类型', '版本', '状态', '更新时间']}>
    {filteredTemplates.map((template) => <tr key={template.id}><TableCell><span className="flex items-center gap-3"><FileText className="h-4 w-4 text-brand-600" /><span className="font-medium text-slate-700">{template.name}</span></span></TableCell><TableCell><Badge tone="blue">{template.type}</Badge></TableCell><TableCell>{template.version}</TableCell><TableCell><StatusBadge status={template.status} /></TableCell><TableCell>{displayTime(template.updatedAt)}</TableCell></tr>)}
  </DataTable><div className="border-t border-slate-100 bg-slate-50 px-5 py-3 text-xs text-slate-500">内置模板由版本化任务目录管理；项目自定义模板继续通过 AI 助手上传和分析，避免跨项目越权。</div></Card></>

  const renderAudit = () => <>{toolbar('搜索用户、模块、操作或对象…')}<Card className="overflow-hidden"><DataTable headers={['操作时间', '操作用户', '模块', '操作类型', '对象 / 内容', 'IP 地址']}>
    {filteredLogs.map((log) => <tr key={log.id}><TableCell><span className="whitespace-nowrap text-xs">{displayTime(log.createdAt)}</span></TableCell><TableCell>{log.user}</TableCell><TableCell><Badge>{log.module}</Badge></TableCell><TableCell>{log.action}</TableCell><TableCell><span className="block max-w-[460px] truncate">{log.target}</span></TableCell><TableCell><span className="font-mono text-xs text-slate-400">{log.ip || '—'}</span></TableCell></tr>)}
  </DataTable></Card></>

  const renderRatingRecovery = () => <div className="space-y-4">
    <Card className="p-5"><div className="flex items-end gap-3"><label className="min-w-0 flex-1"><span className="label">共享线索ID</span><input className={field} value={ratingLeadId} placeholder="粘贴线索UUID后读取历史版本" onChange={(event) => setRatingLeadId(event.target.value)} /></label><Button loading={ratingHistoryLoading} disabled={!ratingLeadId.trim()} onClick={() => void loadRatingHistory()}><Search className="h-4 w-4" />读取历史</Button></div><p className="mt-3 text-xs text-slate-500">该入口仅用于故障回滚。恢复评分不会修改联网事实、原始证据或不可变快照，操作原因会进入管理员审计。</p></Card>
    <Card className="overflow-hidden"><DataTable headers={['完成时间', '分值', '快照', '评级版本', '状态', '操作']}>
      {ratingHistory.map((rating) => <tr key={rating.id}><TableCell>{displayTime(rating.completedAt)}</TableCell><TableCell>{ratingHistoryScore(rating.result) ?? '待评级'}</TableCell><TableCell><span className="font-mono text-xs">{rating.snapshotHash.slice(0, 12)}</span></TableCell><TableCell>{rating.ratingSchemaVersion}</TableCell><TableCell><StatusBadge status={rating.status} /></TableCell><TableCell><button className="inline-flex items-center gap-1 text-xs text-brand-600" onClick={() => { setRatingRestoreTarget(rating); setRatingRestoreReason('') }}><RotateCcw className="h-3.5 w-3.5" />恢复此版本</button></TableCell></tr>)}
    </DataTable>{!ratingHistory.length && <div className="border-t border-slate-100 px-5 py-8 text-center text-sm text-slate-400">请输入线索ID读取可恢复版本</div>}</Card>
  </div>

  const contents: Record<string, () => React.ReactNode> = {
    users: renderUsers, org: renderOrganization, roles: renderRoles, dicts: renderDictionaries,
    templates: renderTemplates, audit: renderAudit, 'rating-recovery': renderRatingRecovery,
    'workflow-rules': () => <FdePolicyPanel />,
    'type-rules': () => <FdeTypePolicyPanel />,
    'office-rules': () => <FdeOfficePolicyPanel />,
    'responsibility-rules': () => <FdeResponsibilityPolicyPanel />,
  }

  return <div className="fde-workspace fde-system-page">
    <PageHeader title="系统管理" description="维护账号、组织、角色权限、数据字典、模板与审计；所有写操作进入 MySQL 并记录管理员审计。" actions={<Button variant="secondary" loading={loading} onClick={() => void refreshAdministration()}><RefreshCw className="h-4 w-4" />刷新</Button>} />
    <div className="fde-system-summary mb-5 grid grid-cols-4 gap-4">{[
      ['账号', users.length, Users], ['部门', administration.departments.length, Building2],
      ['角色', administration.roles.length, UserCog], ['字典', administration.dictionaries.length, Database],
    ].map(([label, value, Icon]) => { const C = Icon as typeof Search; return <Card key={label as string} className="p-4"><C className="h-4 w-4 text-brand-600" /><p className="mt-3 text-xs text-slate-400">{label as string}</p><p className="mt-1 text-xl font-semibold text-slate-800">{value as number}</p></Card> })}</div>
    {workspace.id === 'organization' && <Card className="fde-panel mb-4 p-4 text-xs leading-6 text-slate-600">内部账号、组织角色与项目职责统一使用稳定身份。岗位可多选；主角色保留原系统兼容语义。角色或范围变更会使受影响账号重新登录，已提交审批仍保留原审批人快照。</Card>}
    <Card className="mb-5 overflow-x-auto px-4"><Tabs tabs={tabItems.filter((item) => workspace.tabs.includes(item.id)).map((item) => ({ ...item, count: item.id === 'users' ? users.length : item.id === 'org' ? administration.departments.length : item.id === 'roles' ? administration.roles.length : item.id === 'dicts' ? administration.dictionaries.length : item.id === 'templates' ? templates.length : item.id === 'audit' ? logs.length : undefined }))} value={tab} onChange={setTab} /></Card>
    {contents[tab]?.()}

    <Modal open={Boolean(bindingUser)} width="max-w-3xl" title={`角色与数据范围：${bindingUser?.name ?? ''}`} onClose={() => setBindingUser(null)} footer={<><Button variant="secondary" onClick={() => setBindingUser(null)}>取消</Button><Button loading={busy} disabled={!bindingForm.roleIds.includes(bindingForm.primaryRoleId)} onClick={() => void saveBindings()}>保存角色绑定</Button></>}>
      <p className="mb-4 text-xs leading-5 text-slate-500">每个角色分别声明数据范围。项目文件与审批还要检查项目职责和资源授权，多个角色不表示绕过材料权限。</p>
      <div className="space-y-2">{enabledRoles.map((role) => { const checked = bindingForm.roleIds.includes(role.id); return <label key={role.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3"><input type="checkbox" checked={checked} onChange={() => setBindingForm({ ...bindingForm, roleIds: checked ? bindingForm.roleIds.filter((id) => id !== role.id) : [...bindingForm.roleIds, role.id] })} /><span className="flex-1"><span className="block text-sm font-medium">{role.name}</span><span className="text-xs text-slate-500">{categoryLabel(role.fdeCategory)} · {role.dataScope === 'all' ? '授权全量' : role.dataScope === 'department' ? '本部门' : '本人/项目职责'}</span></span><span className="font-mono text-xs text-slate-400">{role.code}</span></label> })}</div>
      <label className="mt-4 block"><span className="label">主角色</span><select className={field} value={bindingForm.primaryRoleId} onChange={(event) => setBindingForm({ ...bindingForm, primaryRoleId: event.target.value })}><option value="">请选择已授予的主角色</option>{enabledRoles.filter((role) => bindingForm.roleIds.includes(role.id)).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
    </Modal>

    <Modal open={!!userModal} title={userModal?.mode === 'edit' ? '编辑用户' : '新增用户'} onClose={() => setUserModal(null)} footer={<><Button variant="secondary" onClick={() => setUserModal(null)}>取消</Button><Button loading={busy} onClick={() => void saveUser()}>保存</Button></>}>
      <div className="space-y-4"><label><span className="label">姓名</span><input className={field} value={userForm.name} onChange={(e) => setUserForm({ ...userForm, name: e.target.value })} /></label><label><span className="label">工作邮箱</span><input className={field} disabled={userModal?.mode === 'edit'} value={userForm.email} onChange={(e) => setUserForm({ ...userForm, email: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-4"><label><span className="label">部门</span><select className={field} value={userForm.department} onChange={(e) => setUserForm({ ...userForm, department: e.target.value })}>{enabledDepartments.map((item) => <option key={item.id}>{item.name}</option>)}</select></label><label><span className="label">角色</span><select className={field} value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}>{enabledRoles.map((item) => <option key={item.id}>{item.name}</option>)}</select></label></div>
        {userModal?.mode === 'create' && <label><span className="label">初始密码</span><input type="password" className={field} value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} /><span className="mt-1 block text-xs text-slate-400">至少 14 位，需包含大小写字母、数字和符号，且不能包含姓名或邮箱。</span></label>}
        {userModal?.mode === 'edit' && <label><span className="label">账号状态</span><select className={field} disabled={userModal.user?.id === currentUser?.id} value={userForm.status} onChange={(e) => setUserForm({ ...userForm, status: e.target.value as '启用' | '禁用' })}><option>启用</option><option>禁用</option></select></label>}
      </div>
    </Modal>
    <Modal open={!!passwordUser} title={`重置密码：${passwordUser?.name || ''}`} onClose={() => setPasswordUser(null)} footer={<><Button variant="secondary" onClick={() => setPasswordUser(null)}>取消</Button><Button loading={busy} onClick={() => void mutate(() => apiPost(`/users/${passwordUser!.id}/reset-password`, { password: newPassword }), '密码已重置，目标用户的活动会话已失效。').then((ok) => ok && setPasswordUser(null))}>确认重置</Button></>}><label><span className="label">新密码</span><input type="password" className={field} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></label></Modal>

    <Modal open={!!departmentModal} title={departmentModal === 'create' ? '新增部门' : '编辑部门'} onClose={() => setDepartmentModal(null)} footer={<><Button variant="secondary" onClick={() => setDepartmentModal(null)}>取消</Button><Button loading={busy} onClick={() => void saveDepartment()}>保存</Button></>}><div className="space-y-4"><label><span className="label">部门编码</span><input className={field} disabled={departmentModal !== 'create'} value={departmentForm.code} onChange={(e) => setDepartmentForm({ ...departmentForm, code: e.target.value })} /></label><label><span className="label">部门名称</span><input className={field} value={departmentForm.name} onChange={(e) => setDepartmentForm({ ...departmentForm, name: e.target.value })} /></label><label><span className="label">上级部门</span><select className={field} value={departmentForm.parentId} onChange={(e) => setDepartmentForm({ ...departmentForm, parentId: e.target.value })}><option value="">顶级部门</option>{administration.departments.filter((item) => item.id !== (departmentModal as Department)?.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span className="label">说明</span><textarea className={field} value={departmentForm.description} onChange={(e) => setDepartmentForm({ ...departmentForm, description: e.target.value })} /></label><div className="grid grid-cols-2 gap-4"><label><span className="label">排序</span><input type="number" className={field} value={departmentForm.sortOrder} onChange={(e) => setDepartmentForm({ ...departmentForm, sortOrder: e.target.value })} /></label><label><span className="label">状态</span><select className={field} value={departmentForm.status} onChange={(e) => setDepartmentForm({ ...departmentForm, status: e.target.value as '启用' | '禁用' })}><option>启用</option><option>禁用</option></select></label></div></div></Modal>

    <Modal open={!!roleModal} width="max-w-3xl" title={roleModal === 'create' ? '新增角色' : '配置角色权限'} onClose={() => setRoleModal(null)} footer={<><Button variant="secondary" onClick={() => setRoleModal(null)}>取消</Button><Button loading={busy} onClick={() => void saveRole()}>保存</Button></>}><div className="space-y-4">
      <label className="block"><span className="label">FDE 职责类别</span><select className={field} disabled={['SYSTEM_ADMIN', 'AI_PLATFORM_ADMIN'].includes(roleForm.code)} value={roleForm.fdeCategory} onChange={(event) => setRoleForm({ ...roleForm, fdeCategory: event.target.value as FdeRoleCategory | '' })}><option value="">兼容角色（未映射）</option>{FDE_ROLE_CATEGORIES.map((category) => <option key={category.code} value={category.code}>{category.label}</option>)}</select><span className="mt-2 block text-xs text-slate-500">类别决定可承担的项目职责，不自动改变当前项目分工。权限、范围变化会使受影响账号重新登录。</span></label>
      <div className="grid grid-cols-2 gap-4"><label><span className="label">角色编码</span><input className={field} disabled={roleModal !== 'create'} value={roleForm.code} onChange={(e) => setRoleForm({ ...roleForm, code: e.target.value })} /></label><label><span className="label">角色名称</span><input className={field} disabled={roleModal != null && roleModal !== 'create' && roleModal.builtIn} value={roleForm.name} onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })} /></label></div><label><span className="label">说明</span><input className={field} value={roleForm.description} onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })} /></label><div className="grid grid-cols-2 gap-4"><label><span className="label">数据范围</span><select className={field} value={roleForm.dataScope} onChange={(e) => setRoleForm({ ...roleForm, dataScope: e.target.value as Role['dataScope'] })}><option value="self">本人</option><option value="department">本部门</option><option value="all">全部</option></select></label><label><span className="label">状态</span><select className={field} value={roleForm.status} onChange={(e) => setRoleForm({ ...roleForm, status: e.target.value as '启用' | '禁用' })}><option>启用</option><option>禁用</option></select></label></div><div><span className="label">权限项</span><div className="grid grid-cols-2 gap-2">{administration.permissions.map((permission) => { const checked = roleForm.permissionIds.includes(permission.id); return <button key={permission.id} className={`flex items-center rounded-lg border px-3 py-3 text-left text-sm ${checked ? 'border-brand-300 bg-brand-50' : 'border-slate-200'}`} onClick={() => setRoleForm({ ...roleForm, permissionIds: checked ? roleForm.permissionIds.filter((id) => id !== permission.id) : [...roleForm.permissionIds, permission.id] })}><span className={`mr-3 grid h-5 w-5 place-items-center rounded border ${checked ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 text-transparent'}`}><Check className="h-3.5 w-3.5" /></span><span><span className="block font-medium text-slate-700">{permission.name}</span><span className="text-xs text-slate-400">{permission.code}</span></span></button> })}</div></div></div></Modal>

    <Modal open={!!dictionaryModal} title={dictionaryModal === 'create' ? '新增数据字典' : '编辑数据字典'} onClose={() => setDictionaryModal(null)} footer={<><Button variant="secondary" onClick={() => setDictionaryModal(null)}>取消</Button><Button loading={busy} onClick={() => void saveDictionary()}>保存</Button></>}><div className="space-y-4"><label><span className="label">字典编码</span><input className={field} disabled={dictionaryModal !== 'create'} value={dictionaryForm.code} onChange={(e) => setDictionaryForm({ ...dictionaryForm, code: e.target.value })} /></label><label><span className="label">名称</span><input className={field} value={dictionaryForm.name} onChange={(e) => setDictionaryForm({ ...dictionaryForm, name: e.target.value })} /></label><label><span className="label">说明</span><textarea className={field} value={dictionaryForm.description} onChange={(e) => setDictionaryForm({ ...dictionaryForm, description: e.target.value })} /></label><label><span className="label">状态</span><select className={field} value={dictionaryForm.status} onChange={(e) => setDictionaryForm({ ...dictionaryForm, status: e.target.value as '启用' | '禁用' })}><option>启用</option><option>禁用</option></select></label></div></Modal>
    <Modal open={!!itemModal} title={itemModal?.item ? '编辑字典项' : '新增字典项'} onClose={() => setItemModal(null)} footer={<><Button variant="secondary" onClick={() => setItemModal(null)}>取消</Button><Button loading={busy} onClick={() => void saveDictionaryItem()}>保存</Button></>}><div className="space-y-4"><label><span className="label">值编码</span><input className={field} disabled={!!itemModal?.item} value={itemForm.value} onChange={(e) => setItemForm({ ...itemForm, value: e.target.value })} /></label><label><span className="label">显示名称</span><input className={field} value={itemForm.label} onChange={(e) => setItemForm({ ...itemForm, label: e.target.value })} /></label><div className="grid grid-cols-2 gap-4"><label><span className="label">排序</span><input type="number" className={field} value={itemForm.sortOrder} onChange={(e) => setItemForm({ ...itemForm, sortOrder: e.target.value })} /></label><label><span className="label">状态</span><select className={field} value={itemForm.status} onChange={(e) => setItemForm({ ...itemForm, status: e.target.value as '启用' | '禁用' })}><option>启用</option><option>禁用</option></select></label></div></div></Modal>
    <Modal open={!!ratingRestoreTarget} title="恢复V3历史评级" onClose={() => { if (!busy) setRatingRestoreTarget(null) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setRatingRestoreTarget(null)}>取消</Button><Button loading={busy} disabled={ratingRestoreReason.trim().length < 4} onClick={() => void restoreRatingHistory()}>确认恢复</Button></>}><div className="space-y-4"><p className="text-sm leading-6 text-slate-600">将恢复到 <strong>{ratingHistoryScore(ratingRestoreTarget?.result) ?? '待评级'}分</strong>。仅切换有效评分结果，不回滚事实、证据和快照。</p><label><span className="label">恢复原因</span><textarea className={field} maxLength={2000} value={ratingRestoreReason} placeholder="至少4个字，说明恢复原因" onChange={(event) => setRatingRestoreReason(event.target.value)} /></label></div></Modal>
  </div>
}
