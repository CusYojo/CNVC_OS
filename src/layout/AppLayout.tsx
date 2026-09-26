import { useAuthStore } from '../store/useAuthStore'
import {
  Bot,
  BookOpen,
  BriefcaseBusiness,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  FolderKanban,
  Gauge,
  LogOut,
  Menu,
  Settings,
  Sparkles,
  Boxes,
  MessagesSquare,
  RadioTower,
  Bell,
  Building2,
  AlertTriangle,
  ChevronLeft,
  FileText,
  Moon,
  KeyRound,
  Plus,
  Search,
  QrCode,
  Sun,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { UnifiedProjectCreateModal } from '../components/UnifiedProjectCreateModal'
import { Drawer, EmptyState, Modal, SearchInput } from '../components/ui'
import { getSystemWorkspace, systemWorkspaces } from '../lib/systemWorkspaces'
import './fde-shell.css'
import { isAiPlatformAdminRole, isSystemAdminRole } from '../../server/src/contracts/adminRoleContract'
import { apiGet, apiPost } from '../lib/api'
import { useToast } from '../components/Toast'
import type { Meeting, Todo } from '../types'
import { ApprovalWorkspaceHost } from '../components/ApprovalWorkspaceHost'
import { TaskActionHost } from '../components/TaskActionHost'
import { APPROVAL_CHANGED, openApprovalPath } from '../lib/approvalWorkspace'
import { openTaskPath } from '../lib/taskWorkspace'
import { WorkbenchQuote } from '../components/WorkbenchQuote'
import '../components/WorkbenchQuote.css'
import { acknowledgeNotice, hasUnreadDirective } from '../lib/meetingWorkspace'

type MessageItem = {
  id: string
  kind: string
  title: string
  detail: string
  path: string
  priority: number
  readPath?: string
  meetingId?: string
  todoId?: string
  noticeId?: string
}

const primaryNav = [
  { to: '/', label: '工作台', icon: Gauge },
  { to: '/ai', label: 'AI 智能助手', icon: Bot },
  { to: '/projects', label: '项目中心', icon: FolderKanban },
  { to: '/institutions', label: '机构追踪', icon: Building2 },
  { to: '/collaboration', label: '任务与日历', icon: BriefcaseBusiness },
  { to: '/workflow', label: '申请与记录', icon: ClipboardCheck },
  { to: '/due-diligence', label: '尽调工作台', icon: ClipboardList },
  { to: '/knowledge', label: '知识库', icon: BookOpen },
]
const navSections = [
  {
    label: '系统管理',
    icon: Settings,
    children: [
      ...systemWorkspaces.map((workspace, index) => ({
        to: index === 0 ? '/system' : `/system?tab=${workspace.tabs[0]}`,
        label: workspace.label, icon: Settings, roles: ['系统管理员'],
      })),
      { to: '/system/ai/models', label: '模型设置', icon: Sparkles, roles: ['系统管理员', 'AI平台管理员', 'AI 平台管理员'] },
      { to: '/system/ai/capabilities', label: '能力管理', icon: Boxes, roles: ['系统管理员', 'AI平台管理员', 'AI 平台管理员'] },
      { to: '/system/integrations/im-bots', label: 'IM 机器人', icon: MessagesSquare, roles: ['系统管理员', '运营管理员'] },
      { to: '/system/integrations/radar-dingtalk', label: 'Radar 钉钉告警', icon: RadioTower, roles: ['系统管理员'] },
    ],
  },
]

function canSeeNavItem(item: { to: string; label: string; roles?: readonly string[] }, role: string, _permissionCodes: string[] = []): boolean {
  if (!item.roles) return true
  return item.roles.includes(role)
}

function isSystemNavItemActive(item: { to: string }, pathname: string, search: string): boolean {
  const [path, query] = item.to.split('?')
  if (pathname !== path) return false
  return path !== '/system' || getSystemWorkspace(new URLSearchParams(search).get('tab')).id === getSystemWorkspace(new URLSearchParams(query).get('tab')).id
}

function SidebarHorse() {
  return <div className="fde-sidebar-horse" aria-hidden="true">
    <img src="/fde-sidebar-horse.png" alt="" />
  </div>
}

export function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches)
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  const mobileNavigationRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)')
    const update = () => setNarrow(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)')
    const update = () => {
      setPhone(media.matches)
      if (!media.matches) setMobileNavigationOpen(false)
    }
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const responsibilityView = location.pathname === '/responsibility' || location.pathname === '/knowledge' && new URLSearchParams(location.search).get('view') === 'responsibility'
  const leadPoolView = location.pathname === '/projects' && new URLSearchParams(location.search).get('view') === 'leads'
  const navigationCollapsed = !phone && (collapsed || narrow && (responsibilityView || leadPoolView))
  const [showProfile, setShowProfile] = useState(false)
  const [personalWeixinConnected, setPersonalWeixinConnected] = useState<boolean | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [dark, setDark] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [search, setSearch] = useState('')
  const [showNotifications, setShowNotifications] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const { showToast } = useToast()
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用', permissionCodes: [] })
  const logout = useAppStore((state) => state.logout)
  const projects = useAppStore((state) => state.projects)
  const files = useAppStore((state) => state.files)
  const todos = useAppStore((state) => state.todos)
  const meetings = useAppStore((state) => state.meetings)
  const approvalRequests = useAppStore((state) => state.approvalRequests)
  const risks = useAppStore((state) => state.risks)
  const notifications = useAppStore((state) => state.notifications)
  const approvalMessages: MessageItem[] = approvalRequests.filter(request => {
    if (request.status !== '审批中') return false
    if (request.actionBlockedReason || request.projectLifecycle && request.projectLifecycle !== 'active') return false
    const currentNode = request.nodes.find(node => node.id === request.currentNodeId) ?? request.nodes.find(node => ['待审批', '会签中'].includes(node.status))
    return currentNode?.approverUserIds?.includes(currentUser.id)
  }).map(request => ({ id: `approval:${request.id}`, kind: '审批', title: request.title, detail: `${request.projectName} · ${request.currentNodeName}`, path: `/workflow?view=project&project=${request.projectId}&request=${request.id}`, priority: request.priority === '紧急' ? 0 : 1 }))
  const warningMessages: MessageItem[] = risks.filter(risk => risk.level === '高' && !['已关闭', '误报'].includes(risk.status)).map(risk => ({ id: `risk:${risk.id}`, kind: '预警', title: risk.type, detail: `${risk.projectName} · ${risk.description}`, path: `/risks?project=${risk.projectId}`, priority: 0 }))
  const directiveMessages: MessageItem[] = todos.filter(hasUnreadDirective).map(item => ({ id: `directive:${item.directiveNoticeId}`, kind: '批示', title: item.title, detail: `${item.projectName || '项目'} · ${item.owner || '待接办'} · ${item.status}`, path: item.projectId ? `/projects/${item.projectId}?tab=collaboration&directive=${item.directiveId}` : '/collaboration', priority: item.priority === '高' ? 0 : 1, readPath: `/projects/${item.projectId}/directive-notices/${item.directiveNoticeId}/read`, todoId: item.id, noticeId: item.directiveNoticeId ?? undefined }))
  const collaborationMessages: MessageItem[] = todos.filter(item => item.ownerUserId === currentUser.id && item.type === '通知' && !['已完成', '已关闭', '已取消', '已归档'].includes(item.status)).map(item => ({ id: `interaction:${item.id}`, kind: '协作', title: item.title, detail: item.projectName || '协作消息', path: item.projectId ? `/projects/${item.projectId}?tab=collaboration` : '/collaboration', priority: item.priority === '高' ? 0 : 2 }))
  const meetingMessages: MessageItem[] = meetings.filter(item => item.unreadNoticeId).map(item => ({ id: `meeting:${item.id}`, kind: '会议', title: item.title, detail: `${item.projectName} · ${item.meetingTime.slice(0, 16).replace('T', ' ')}`, path: `/meetings?meeting=${item.id}`, priority: 1, readPath: `/meetings/${item.id}/notices/${item.unreadNoticeId}/read`, meetingId: item.id }))
  const storedMessages: MessageItem[] = notifications.filter(item => !item.isRead).map(item => ({ id: `notice:${item.id}`, kind: item.type || '消息', title: item.title, detail: item.content, path: '/collaboration', priority: 2 }))
  const messageItems = [...approvalMessages, ...warningMessages, ...directiveMessages, ...meetingMessages, ...collaborationMessages, ...storedMessages].sort((left, right) => left.priority - right.priority)
  const pageTitle = location.pathname.startsWith('/system') ? '系统管理'
    : location.pathname === '/committee' || location.pathname === '/meetings' ? '任务与日历'
      : location.pathname === '/responsibility' ? '知识库'
        : primaryNav.find(item => item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to))?.label ?? '投资工作空间'
  const query = search.trim().toLowerCase()
  const showWorkbenchQuote = location.pathname === '/' || location.pathname === '/projects/boss-dashboard'
  const matchedProjects = query ? projects.filter(item => item.lifecycle !== 'deleted' && `${item.name} ${item.companyName}`.toLowerCase().includes(query)).slice(0, 8) : []
  const matchedFiles = query ? files.filter(item => item.name.toLowerCase().includes(query)).slice(0, 8) : []
  const openResult = (path: string) => { setShowSearch(false); setShowNotifications(false); setShowProfile(false); if (!openApprovalPath(path) && !openTaskPath(path)) navigate(path) }
  const openMessage = (item: MessageItem) => {
    // Meeting reminders are acknowledged only after the requested meeting opens.
    if (item.readPath && !item.meetingId) void acknowledgeNotice(() => apiPost(item.readPath!, {}), () => {
      if (item.todoId) useAppStore.setState((state) => ({ todos: state.todos.map(todo => todo.id === item.todoId && todo.directiveNoticeId === item.noticeId ? { ...todo, directiveNoticeId: null } : todo) }))
    }).catch(() => showToast('提醒暂未标记已读，请稍后重试', 'error'))
    openResult(item.path)
  }
  const changePassword = async () => {
    if (!passwordForm.currentPassword || !passwordForm.newPassword) return showToast('请填写当前密码和新密码', 'error')
    if (passwordForm.newPassword !== passwordForm.confirmPassword) return showToast('两次输入的新密码不一致', 'error')
    setPasswordBusy(true)
    try {
      await apiPost('/auth/change-password', { currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword })
      setShowPassword(false)
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
      showToast('密码修改成功，请使用新密码重新登录')
      logout()
      navigate('/login')
    } catch (error) {
      showToast((error as Error).message, 'error')
    } finally { setPasswordBusy(false) }
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setShowSearch(value => !value) }
      if (event.key === 'Escape') { setShowSearch(false); setShowNotifications(false); setShowProfile(false) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])
  useEffect(() => setMobileNavigationOpen(false), [location.pathname, location.search])
  useEffect(() => {
    document.body.classList.toggle('fde-mobile-nav-open', mobileNavigationOpen)
    if (mobileNavigationOpen) {
      window.requestAnimationFrame(() => mobileNavigationRef.current?.querySelector<HTMLElement>('a, button')?.focus())
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && mobileNavigationOpen) setMobileNavigationOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.classList.remove('fde-mobile-nav-open')
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [mobileNavigationOpen])
  const closeMobileNavigation = () => {
    setMobileNavigationOpen(false)
    window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus())
  }
  useEffect(() => {
    if (!currentUser.id) return
    let active = true
    const refreshMessages = async () => {
      const [meetingResult, todoResult] = await Promise.allSettled([
        apiGet<{ list: Meeting[] }>('/meetings'),
        apiGet<{ list: Todo[] }>('/todos'),
      ])
      if (!active) return
      useAppStore.setState((state) => ({
        meetings: meetingResult.status === 'fulfilled' ? meetingResult.value.list : state.meetings,
        todos: todoResult.status === 'fulfilled' ? todoResult.value.list : state.todos,
      }))
    }
    const onFocus = () => { void refreshMessages() }
    void refreshMessages()
    const timer = window.setInterval(refreshMessages, 30_000)
    window.addEventListener('focus', onFocus); window.addEventListener(APPROVAL_CHANGED, onFocus)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus); window.removeEventListener(APPROVAL_CHANGED, onFocus)
    }
  }, [currentUser.id])
  useEffect(() => {
    if (!showProfile || isSystemAdminRole(currentUser.role)) return
    let active = true
    void apiGet<{ connected: boolean }>('/integrations/im/weixin/self')
      .then((result) => { if (active) setPersonalWeixinConnected(result.connected) })
      .catch(() => { if (active) setPersonalWeixinConnected(false) })
    return () => { active = false }
  }, [showProfile, currentUser.role])

  return (
    <div className={`fde-app fde-shell${navigationCollapsed ? ' is-collapsed' : ''}${mobileNavigationOpen ? ' is-mobile-nav-open' : ''}`} data-theme={dark ? 'dark' : 'light'}>
      <a className="fde-skip-link" href="#workspace-content">跳到主要内容</a>
      <button className="fde-mobile-nav-backdrop" aria-label="关闭主导航" tabIndex={mobileNavigationOpen ? 0 : -1} onClick={closeMobileNavigation} />
      <aside id="mobile-navigation" ref={mobileNavigationRef} className="fde-sidebar" aria-label="主导航" aria-modal={phone && mobileNavigationOpen ? true : undefined} role={phone ? 'dialog' : undefined}>
        <div className="fde-brand-row">
          <button onClick={() => navigate('/')} className="fde-brand-home" aria-label="赛智伯乐工作台">
            <span className="fde-brand-mark"><img src="/fde-company-logo.png" alt="" /></span>
            {!navigationCollapsed && <span className="fde-brand-copy"><strong>赛智伯乐</strong><small>INVESTMENT WORKSPACE</small></span>}
          </button>
          <button onClick={() => setCollapsed(value => !value)} className="fde-icon-button fde-sidebar-toggle" aria-label={navigationCollapsed ? '展开侧边栏' : '收起侧边栏'}>{navigationCollapsed ? <Menu /> : <ChevronLeft />}</button>
          <button onClick={closeMobileNavigation} className="fde-icon-button fde-mobile-nav-close" aria-label="关闭主导航"><ChevronLeft /></button>
        </div>
        <nav>
          {!navigationCollapsed && <div className="fde-nav-label">统一工作空间</div>}
          {primaryNav.map((item) => <NavLink key={item.to} to={item.to} end={item.to === '/'} title={item.label} className={({ isActive }) => `fde-nav-item${isActive ? ' active' : ''}`}><item.icon className="fde-nav-icon" />{!navigationCollapsed && <span>{item.label}</span>}</NavLink>)}
          {navSections.filter((section) => section.label !== '系统管理').map((section) => {
            const visibleChildren = section.children.filter((item) => canSeeNavItem(item, currentUser.role, currentUser.permissionCodes))
            const sectionActive = visibleChildren.some((item) => location.pathname === item.to.split('?')[0])
            return <NavLink key={section.label} to={visibleChildren[0].to} title={section.label} className={`fde-nav-item${sectionActive ? ' active' : ''}`}>
                <section.icon className="fde-nav-icon" />
                {!navigationCollapsed && <span>{section.label}</span>}
            </NavLink>
          })}
        </nav>
        {!navigationCollapsed && <SidebarHorse />}
        <div className="fde-mobile-nav-tools">
          <button onClick={() => { setShowCreate(true); closeMobileNavigation() }}><Plus />快速新建</button>
          <button onClick={() => setDark(value => !value)}>{dark ? <Sun /> : <Moon />}{dark ? '切换浅色主题' : '切换深色主题'}</button>
        </div>
      </aside>

      <div className="fde-main-column">
        <header className="fde-topbar">
          <button ref={mobileMenuButtonRef} className="fde-icon-button fde-mobile-menu-button" aria-label="打开主导航" aria-controls="mobile-navigation" aria-expanded={mobileNavigationOpen} onClick={() => setMobileNavigationOpen(true)}><Menu /></button>
          <div className={`fde-breadcrumb${showWorkbenchQuote ? ' fde-breadcrumb-quote' : ''}`}>{showWorkbenchQuote ? <><span className="sr-only">工作台</span><WorkbenchQuote /></> : <strong>{pageTitle}</strong>}</div>
          <button className="fde-global-search" onClick={() => setShowSearch(true)}><Search /><span>搜索项目、文件…</span><kbd>⌘ K</kbd></button>
          <div className="fde-top-actions">
            <button className="fde-quick-create" onClick={() => setShowCreate(true)}><Plus /><span>快速新建</span></button>
            <button className="fde-icon-button" aria-label="切换深浅主题" aria-pressed={dark} onClick={() => setDark(value => !value)}>{dark ? <Sun /> : <Moon />}</button>
            <button className="fde-icon-button fde-notification-button" aria-label={`查看消息与预警，${messageItems.length} 项`} onClick={() => setShowNotifications(true)}><Bell />{messageItems.length > 0 && <i>{messageItems.length > 99 ? '99+' : messageItems.length}</i>}</button>
            <div className="relative">
              <button onClick={() => setShowProfile((value) => !value)} className="fde-top-profile" aria-label="打开账户与角色信息" aria-expanded={showProfile}>
                <span className="fde-avatar">{currentUser.name.slice(0, 1)}</span>
                <span className="fde-top-profile-copy"><strong>{currentUser.name}</strong><small>{currentUser.role}</small></span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>
              {showProfile && (
                <div className="fde-profile-menu absolute right-0 top-12 w-52 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
                  <div className="border-b border-slate-100 px-3 py-2.5"><p className="text-xs text-slate-400">{currentUser.email}</p><p className="mt-1 text-xs text-slate-500">{currentUser.department}</p></div>
                  <button onClick={() => navigate('/ai')} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><Sparkles className="h-4 w-4" />AI 助手</button>
                  {!isSystemAdminRole(currentUser.role) && <button title={personalWeixinConnected ? '微信 AI 已连接' : '微信 AI 未连接'} onClick={() => { setShowProfile(false); navigate('/settings/weixin-ai') }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><QrCode className="h-4 w-4" />微信 AI<span className={`ml-auto h-2 w-2 rounded-full ${personalWeixinConnected ? 'bg-emerald-500' : 'bg-slate-300'}`} aria-label={personalWeixinConnected ? '已连接' : '未连接'} /></button>}
                  <button onClick={() => { setShowProfile(false); setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' }); setShowPassword(true) }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><KeyRound className="h-4 w-4" />修改登录密码</button>
                  {isSystemAdminRole(currentUser.role) && <button onClick={() => { setShowProfile(false); navigate('/system') }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><Settings className="h-4 w-4" />系统管理</button>}
                  {!isSystemAdminRole(currentUser.role) && isAiPlatformAdminRole(currentUser.role) && <button onClick={() => { setShowProfile(false); navigate('/system/ai/models') }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><Settings className="h-4 w-4" />AI 平台管理</button>}
                  <button onClick={() => { logout(); navigate('/login') }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-600 hover:bg-rose-50"><LogOut className="h-4 w-4" />退出登录</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main id="workspace-content" className="fde-page-content" tabIndex={-1}><div className="fde-page-wrap">
          {location.pathname.startsWith('/system') && <nav className="fde-workspace-tabs fde-system-navigation" aria-label="系统管理功能">
            {navSections.flatMap(section => section.children).filter(item => canSeeNavItem(item, currentUser.role, currentUser.permissionCodes)).map(item => {
              const active = isSystemNavItemActive(item, location.pathname, location.search)
              return <Link key={item.to} to={item.to} aria-current={active ? 'page' : undefined} className={active ? 'active' : ''}><item.icon className="h-4 w-4" />{item.label}</Link>
            })}
          </nav>}
          <Outlet />
        </div></main>
      </div>
      <Modal open={showSearch} onClose={() => setShowSearch(false)} title="搜索工作空间" width="max-w-2xl">
        <SearchInput autoFocus placeholder="搜索有权访问的项目、文件…" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="fde-search-results">
          {matchedProjects.map(project => <button key={project.id} onClick={() => openResult(`/projects/${project.id}`)}><FolderKanban /><span><strong>{project.name}</strong><small>{project.companyName}</small></span><span>项目 →</span></button>)}
          {matchedFiles.map(file => <button key={file.id} onClick={() => openResult(file.projectId ? `/projects/${file.projectId}?tab=files&file=${encodeURIComponent(file.id)}` : '/knowledge')}><FileText /><span><strong>{file.name}</strong><small>{file.category}</small></span><span>文件 →</span></button>)}
          {query && !matchedProjects.length && !matchedFiles.length && <EmptyState title="未找到匹配记录" description="仅搜索当前账号已加载的授权记录。" />}
          {!query && <p className="py-6 text-sm text-slate-500">输入关键词查找当前工作空间中的项目与文件。</p>}
        </div>
      </Modal>
      <Drawer open={showNotifications} onClose={() => setShowNotifications(false)} title="消息与预警">
        <div className="fde-search-results">{messageItems.map(item => <button key={item.id} onClick={() => openMessage(item)}>{item.kind === '审批' ? <ClipboardCheck /> : item.kind === '预警' ? <AlertTriangle /> : <MessagesSquare />}<span><strong>{item.title}</strong><small><b>{item.kind}</b> · {item.detail}</small></span><span>→</span></button>)}</div>
        {!messageItems.length && <EmptyState title="暂无新消息" description="领导批示、会议提醒、待处理审批、协作互动和项目预警会显示在这里。" />}
      </Drawer>
      <Modal open={showPassword} onClose={() => { if (!passwordBusy) setShowPassword(false) }} title="修改登录密码" footer={<><button className="fde-ui-button h-10 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700" disabled={passwordBusy} onClick={() => setShowPassword(false)}>取消</button><button className="fde-ui-button h-10 rounded-lg border border-brand-600 bg-brand-600 px-4 text-sm font-medium text-white disabled:opacity-50" disabled={passwordBusy} onClick={() => void changePassword()}>{passwordBusy ? '正在修改…' : '确认修改'}</button></>}>
        <div className="space-y-4">
          <label className="block"><span className="label">当前密码</span><input className="input w-full" type="password" autoComplete="current-password" value={passwordForm.currentPassword} onChange={(event) => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })} /></label>
          <label className="block"><span className="label">新密码</span><input className="input w-full" type="password" autoComplete="new-password" value={passwordForm.newPassword} onChange={(event) => setPasswordForm({ ...passwordForm, newPassword: event.target.value })} /></label>
          <label className="block"><span className="label">确认新密码</span><input className="input w-full" type="password" autoComplete="new-password" value={passwordForm.confirmPassword} onChange={(event) => setPasswordForm({ ...passwordForm, confirmPassword: event.target.value })} /></label>
          <p className="text-xs leading-5 text-slate-500">至少 14 位，包含大小写字母、数字和符号。修改后需要重新登录。</p>
        </div>
      </Modal>
      <ApprovalWorkspaceHost />
      <TaskActionHost />
      <UnifiedProjectCreateModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  )
}
