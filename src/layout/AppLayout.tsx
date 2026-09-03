import { useAuthStore } from '../store/useAuthStore'
import {
  Bot,
  BookOpen,
  BriefcaseBusiness,
  ChevronDown,
  ClipboardCheck,
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
  AlertTriangle,
  ChevronLeft,
  FileText,
  Moon,
  Plus,
  Search,
  Sun,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { UnifiedProjectCreateModal } from '../components/UnifiedProjectCreateModal'
import { Drawer, EmptyState, Modal, SearchInput } from '../components/ui'
import { getSystemWorkspace, systemWorkspaces } from '../lib/systemWorkspaces'
import './fde-shell.css'
import { isAiPlatformAdminRole, isSystemAdminRole } from '../../server/src/contracts/adminRoleContract'

const primaryNav = [
  { to: '/', label: '工作台', icon: Gauge },
  { to: '/ai', label: 'AI 智能助手', icon: Bot },
  { to: '/projects', label: '项目中心', icon: FolderKanban },
  { to: '/collaboration', label: '任务与日历', icon: BriefcaseBusiness },
  { to: '/workflow', label: '审批与办公', icon: ClipboardCheck },
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

export function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)')
    const update = () => setNarrow(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const responsibilityView = location.pathname === '/responsibility' || location.pathname === '/knowledge' && new URLSearchParams(location.search).get('view') === 'responsibility'
  const leadPoolView = location.pathname === '/projects' && new URLSearchParams(location.search).get('view') === 'leads'
  const navigationCollapsed = collapsed || narrow && (responsibilityView || leadPoolView)
  const [showProfile, setShowProfile] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [dark, setDark] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [search, setSearch] = useState('')
  const [showNotifications, setShowNotifications] = useState(false)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用', permissionCodes: [] })
  const logout = useAppStore((state) => state.logout)
  const projects = useAppStore((state) => state.projects)
  const files = useAppStore((state) => state.files)
  const todos = useAppStore((state) => state.todos)
  const meetings = useAppStore((state) => state.meetings)
  const approvalRequests = useAppStore((state) => state.approvalRequests)
  const risks = useAppStore((state) => state.risks)
  const notifications = useAppStore((state) => state.notifications)
  const approvalMessages = approvalRequests.filter(request => {
    if (request.status !== '审批中') return false
    const currentNode = request.nodes.find(node => node.id === request.currentNodeId) ?? request.nodes.find(node => ['待审批', '会签中'].includes(node.status))
    return currentNode?.approverUserIds?.includes(currentUser.id)
  }).map(request => ({ id: `approval:${request.id}`, kind: '审批', title: request.title, detail: `${request.projectName} · ${request.currentNodeName}`, path: `/workflow?view=project&project=${request.projectId}&request=${request.id}`, priority: request.priority === '紧急' ? 0 : 1 }))
  const warningMessages = risks.filter(risk => risk.level === '高' && !['已关闭', '误报'].includes(risk.status)).map(risk => ({ id: `risk:${risk.id}`, kind: '预警', title: risk.type, detail: `${risk.projectName} · ${risk.description}`, path: `/risks?project=${risk.projectId}`, priority: 0 }))
  const collaborationMessages = todos.filter(item => item.ownerUserId === currentUser.id && item.type === '通知' && !['已完成', '已关闭', '已取消', '已归档'].includes(item.status)).map(item => ({ id: `interaction:${item.id}`, kind: '协作', title: item.title, detail: item.projectName || '协作消息', path: item.projectId ? `/projects/${item.projectId}?tab=collaboration` : '/collaboration', priority: item.priority === '高' ? 0 : 2 }))
  const meetingMessages = meetings.filter(item => item.unreadNoticeId).map(item => ({ id: `meeting:${item.id}`, kind: '会议', title: item.title, detail: `${item.projectName} · ${item.meetingTime.slice(0, 16).replace('T', ' ')}`, path: `/meetings?meeting=${item.id}`, priority: 1 }))
  const storedMessages = notifications.filter(item => !item.isRead).map(item => ({ id: `notice:${item.id}`, kind: item.type || '消息', title: item.title, detail: item.content, path: '/collaboration', priority: 2 }))
  const messageItems = [...approvalMessages, ...warningMessages, ...meetingMessages, ...collaborationMessages, ...storedMessages].sort((left, right) => left.priority - right.priority)
  const pageTitle = location.pathname.startsWith('/system') ? '系统管理'
    : location.pathname === '/committee' || location.pathname === '/meetings' ? '任务与日历'
      : location.pathname === '/responsibility' ? '知识库'
        : primaryNav.find(item => item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to))?.label ?? '投资工作空间'
  const query = search.trim().toLowerCase()
  const matchedProjects = query ? projects.filter(item => item.lifecycle !== 'deleted' && `${item.name} ${item.companyName}`.toLowerCase().includes(query)).slice(0, 8) : []
  const matchedFiles = query ? files.filter(item => item.name.toLowerCase().includes(query)).slice(0, 8) : []
  const openResult = (path: string) => { setShowSearch(false); setShowNotifications(false); setShowProfile(false); navigate(path) }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setShowSearch(value => !value) }
      if (event.key === 'Escape') { setShowSearch(false); setShowNotifications(false); setShowProfile(false) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])

  return (
    <div className={`fde-app fde-shell${navigationCollapsed ? ' is-collapsed' : ''}`} data-theme={dark ? 'dark' : 'light'}>
      <a className="fde-skip-link" href="#workspace-content">跳到主要内容</a>
      <aside className="fde-sidebar" aria-label="主导航">
        <div className="fde-brand-row">
          <button onClick={() => navigate('/')} className="fde-brand-home" aria-label="赛智伯乐工作台">
            <span className="fde-brand-mark"><img src="/fde-company-logo.png" alt="" /></span>
            {!navigationCollapsed && <span className="fde-brand-copy"><strong>赛智伯乐</strong><small>INVESTMENT WORKSPACE</small></span>}
          </button>
          <button onClick={() => setCollapsed(value => !value)} className="fde-icon-button fde-sidebar-toggle" aria-label={navigationCollapsed ? '展开侧边栏' : '收起侧边栏'}>{navigationCollapsed ? <Menu /> : <ChevronLeft />}</button>
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
      </aside>

      <div className="fde-main-column">
        <header className="fde-topbar">
          <div className="fde-breadcrumb"><strong>{pageTitle}</strong></div>
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
        <div className="fde-search-results">{messageItems.map(item => <button key={item.id} onClick={() => openResult(item.path)}>{item.kind === '审批' ? <ClipboardCheck /> : item.kind === '预警' ? <AlertTriangle /> : <MessagesSquare />}<span><strong>{item.title}</strong><small><b>{item.kind}</b> · {item.detail}</small></span><span>→</span></button>)}</div>
        {!messageItems.length && <EmptyState title="暂无新消息" description="领导批示、会议提醒、待处理审批、协作互动和项目预警会显示在这里。" />}
      </Drawer>
      <UnifiedProjectCreateModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  )
}
