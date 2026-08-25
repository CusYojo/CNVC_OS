import { useAuthStore } from '../store/useAuthStore'
import {
  Bot,
  BriefcaseBusiness,
  ChevronDown,
  ClipboardCheck,
  FolderKanban,
  Gauge,
  LogOut,
  Menu,
  Search,
  Settings,
  Sparkles,
  Boxes,
  MessagesSquare,
  RadioTower,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ProjectModal } from '../components/ProjectModal'

const primaryNav = [
  { to: '/', label: '首页工作台', icon: Gauge },
  { to: '/projects', label: '我的专属项目', icon: FolderKanban },
  { to: '/sourcing', label: '共享线索池', icon: BriefcaseBusiness },
  { to: '/ai', label: 'AI 智能助手', icon: Bot },
  { to: '/workflow?view=project', label: 'OA 项目流程', icon: ClipboardCheck },
]
const navSections = [
  {
    label: '系统管理',
    icon: Settings,
    children: [
      { to: '/system', label: '组织、权限与配置', icon: Settings, roles: ['系统管理员'] },
      { to: '/system/ai/models', label: '模型设置', icon: Sparkles, roles: ['系统管理员', 'AI平台管理员', 'AI 平台管理员'] },
      { to: '/system/ai/capabilities', label: '能力管理', icon: Boxes, roles: ['系统管理员', 'AI平台管理员', 'AI 平台管理员'] },
      { to: '/system/integrations/im-bots', label: 'IM 机器人', icon: MessagesSquare, roles: ['系统管理员', '运营管理员'] },
      { to: '/system/integrations/radar-dingtalk', label: 'Radar 钉钉告警', icon: RadioTower, roles: ['系统管理员'] },
    ],
  },
]

function canSeeNavItem(item: { to: string; label: string; roles?: readonly string[] }, role: string, permissionCodes: string[] = []): boolean {
  if (!item.roles) return true
  const permission = item.to === '/system' || item.to === '/system/integrations/radar-dingtalk'
    ? 'system.manage' : item.to.startsWith('/system/ai/') ? 'ai.configure' : item.to.startsWith('/system/integrations/') ? 'im.manage' : ''
  return (!!permission && permissionCodes.includes(permission)) || item.roles.includes(role)
}

export function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [expandedNav, setExpandedNav] = useState<Record<string, boolean>>({ 系统管理: true })
  const [search, setSearch] = useState('')
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用', permissionCodes: [] })
  const logout = useAppStore((state) => state.logout)
  const projects = useAppStore((state) => state.projects)
  const results = useMemo(() => search.trim() ? projects.filter((project) => `${project.name}${project.companyName}${project.industry}`.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 5) : [], [projects, search])

  return (
    <div className="flex min-h-screen bg-[#f5f7fb]">
      <aside className={`fixed inset-y-0 left-0 z-30 flex flex-col border-r border-slate-200 bg-[#fafafa] text-slate-700 transition-all duration-200 ${collapsed ? 'w-[72px]' : 'w-[216px]'}`}>
        <button onClick={() => navigate('/')} className={`flex h-20 shrink-0 items-center border-b border-slate-200 text-left ${collapsed ? 'justify-center px-2' : 'px-2'}`}>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border border-slate-200 bg-white text-base font-semibold text-[#2463c5] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">赛</span>
          {!collapsed && <span className="ml-3 min-w-0"><span className="block truncate text-[13px] font-semibold text-slate-800">浙江赛智伯乐</span><span className="mt-1 block truncate text-[10px] tracking-[0.04em] text-slate-400">AI 投资中台 · 产品原型</span></span>}
        </button>
        <nav className="flex-1 overflow-y-auto px-2.5 py-5 scrollbar-thin">
          {primaryNav.map((item) => <NavLink key={item.to} to={item.to} end={item.to === '/'} title={collapsed ? item.label : undefined} className={({ isActive }) => `mb-1.5 flex h-[42px] items-center rounded-[9px] text-[13px] font-medium transition-colors ${collapsed ? 'justify-center' : 'px-3.5'} ${isActive ? 'bg-[#376dcc] text-white shadow-[0_2px_6px_rgba(55,109,204,0.18)]' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}><item.icon className="h-[17px] w-[17px] shrink-0 stroke-[1.8]" />{!collapsed && <span className="ml-3">{item.label}</span>}</NavLink>)}
          {navSections.filter((section) => section.label !== '系统管理' || section.children.some((item) => canSeeNavItem(item, currentUser.role, currentUser.permissionCodes))).map((section) => {
            const visibleChildren = section.children.filter((item) => canSeeNavItem(item, currentUser.role, currentUser.permissionCodes))
            const sectionActive = visibleChildren.some((item) => location.pathname === item.to.split('?')[0])
            const expanded = expandedNav[section.label]
            return <div key={section.label} className="mt-2 border-t border-slate-200 pt-2">
              <button onClick={() => setExpandedNav((value) => ({ ...value, [section.label]: !expanded }))} title={collapsed ? section.label : undefined} className={`flex h-[42px] w-full items-center rounded-[9px] text-[13px] font-medium transition-colors ${collapsed ? 'justify-center' : 'px-3.5'} ${sectionActive ? 'text-[#2f66c9]' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
                <section.icon className="h-[17px] w-[17px] shrink-0 stroke-[1.8]" />
                {!collapsed && <><span className="ml-3 flex-1 text-left">{section.label}</span><ChevronDown className={`h-3.5 w-3.5 transition ${expanded ? '' : '-rotate-90'}`} /></>}
              </button>
              {!collapsed && expanded && <div className="ml-[27px] mt-1 space-y-0.5 border-l border-slate-200 pl-2">{visibleChildren.map((item) => {
                const [childPath, childQuery] = item.to.split('?')
                const childActive = location.pathname === childPath && (!childQuery || location.search === `?${childQuery}`)
                return <NavLink key={item.to} to={item.to} className={`flex h-8 items-center rounded-md px-2 text-xs transition-colors ${childActive ? 'bg-blue-50 font-medium text-[#2f66c9]' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><span className="mr-2 text-slate-300">›</span>{item.label}</NavLink>
              })}</div>}
            </div>
          })}
        </nav>
        <div className="border-t border-slate-200 p-2.5">
          <button onClick={() => setCollapsed((value) => !value)} className={`flex h-9 w-full items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 ${collapsed ? 'justify-center' : 'px-3'}`}><Menu className="h-[17px] w-[17px]" />{!collapsed && <span className="ml-3 text-xs">收起导航</span>}</button>
        </div>
      </aside>

      <div className={`flex min-h-screen min-w-0 flex-1 flex-col transition-all duration-200 ${collapsed ? 'ml-[72px]' : 'ml-[216px]'}`}>
        <header className="sticky top-0 z-20 flex h-16 min-w-0 items-center border-b border-slate-200 bg-white/95 px-6 backdrop-blur">
          <div className="relative min-w-0 max-w-[420px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-16 text-sm outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100" placeholder="搜索项目、公司、行业…" />
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-400">⌘ K</span>
            {results.length > 0 && (
              <div className="absolute top-11 w-full overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
                {results.map((project) => <button key={project.id} className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left hover:bg-slate-50" onClick={() => { navigate(`/projects/${project.id}`); setSearch('') }}><span><span className="block text-sm font-medium text-slate-700">{project.name}</span><span className="mt-0.5 block text-xs text-slate-400">{project.industry} · {project.stage}</span></span><span className="text-xs text-brand-600">打开</span></button>)}
              </div>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 pl-4">
            
            <div className="relative">
              <button onClick={() => setShowProfile((value) => !value)} className="flex max-w-[300px] items-center gap-2 rounded-lg p-1.5 hover:bg-slate-50">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-100 text-xs font-semibold text-brand-700">{currentUser.name.slice(-2)}</span>
                <span className="min-w-0 text-left"><span className="block truncate text-xs font-medium text-slate-700">{currentUser.name}</span><span className="block truncate text-[10px] text-slate-400">{currentUser.role}</span></span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>
              {showProfile && (
                <div className="absolute right-0 top-12 w-52 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
                  <div className="border-b border-slate-100 px-3 py-2.5"><p className="text-xs text-slate-400">{currentUser.email}</p><p className="mt-1 text-xs text-slate-500">{currentUser.department}</p></div>
                  <button onClick={() => navigate('/ai')} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><Sparkles className="h-4 w-4" />AI 助手</button>
                  <button onClick={() => { logout(); navigate('/login') }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-600 hover:bg-rose-50"><LogOut className="h-4 w-4" />退出登录</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-6"><Outlet /></main>
      </div>
      <ProjectModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  )
}
