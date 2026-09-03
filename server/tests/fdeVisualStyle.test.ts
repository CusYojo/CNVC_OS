import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import postcss from 'postcss'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as iconsForDetail from 'lucide-react'
import { materialIsSatisfied, projectCountdown, projectDetailTab, projectDetailTabs, shortProjectDate } from '../../src/lib/projectDetailPresentation'
import { getSystemWorkspace, resolveSystemTab, systemWorkspaces } from '../../src/lib/systemWorkspaces'

const shell = readFileSync(new URL('../../src/layout/AppLayout.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('AppLayout.tsx', shell, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declarations: string[] = []
const icons: Record<string, string> = {}
for (const node of source.statements) {
  if (ts.isImportDeclaration(node) && node.moduleSpecifier.getText(source) === "'lucide-react'") {
    const bindings = node.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) icons[item.name.text] = item.name.text
  }
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ['primaryNav', 'navSections'].includes(item.name.getText(source)))) declarations.push(node.getText(source))
  if (ts.isFunctionDeclaration(node) && ['canSeeNavItem', 'isSystemNavItemActive'].includes(node.name?.text ?? '')) declarations.push(node.getText(source))
}
const js = ts.transpileModule(declarations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
type NavItem = { to: string; label: string; roles?: string[] }
const navigation = runInNewContext(`${js}\n({primaryNav, navSections, canSeeNavItem, isSystemNavItemActive})`, { ...icons, getSystemWorkspace, systemWorkspaces, URLSearchParams }) as {
  primaryNav: NavItem[]
  navSections: Array<{ label: string; children: NavItem[] }>
  canSeeNavItem: (item: NavItem, role: string, permissions?: string[]) => boolean
  isSystemNavItemActive: (item: NavItem, pathname: string, search: string) => boolean
}

test('FDE navigation keeps AI first-level and configuration inside system management', () => {
  const primary = Array.from(navigation.primaryNav, item => item.to)
  assert.deepEqual(primary, ['/', '/ai', '/projects', '/collaboration', '/workflow', '/knowledge'])
  const system = navigation.navSections.find(item => item.label === '系统管理')!
  assert.deepEqual(Array.from(system.children, item => item.label), ['组织与权限', '模板与规则', '集成与审计', '模型设置', '能力管理', 'IM 机器人', 'Radar 钉钉告警'])
  for (const path of ['/system/ai/models', '/system/ai/capabilities', '/system/integrations/im-bots', '/system/integrations/radar-dingtalk']) {
    assert.ok(system.children.some(item => item.to === path))
    assert.ok(!primary.includes(path))
  }
  assert.match(shell, /aria-label="系统管理功能"/)
  assert.match(shell, /修改登录密码/)
  assert.match(shell, /apiPost\('\/auth\/change-password'/)
  assert.match(shell, /location\.pathname\.startsWith\('\/system'\)/)
  assert.match(shell, /canSeeNavItem\(item, currentUser\.role, currentUser\.permissionCodes\)/)
  const systemPage = readFileSync(new URL('../../src/pages/SystemPage.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(systemPage, /aria-label="系统管理工作区"/)
})

test('system navigation selects one workspace across deep links and direct settings routes', () => {
  const items = navigation.navSections[0].children
  const active = (pathname: string, search = '') => Array.from(items.filter(item => navigation.isSystemNavItemActive(item, pathname, search)), item => item.label)
  for (const workspace of systemWorkspaces) {
    for (const tab of workspace.tabs) assert.deepEqual(active('/system', `?tab=${tab}`), [workspace.label])
    const item = items.find(item => item.label === workspace.label)!
    const url = new URL(item.to, 'http://localhost')
    assert.equal(getSystemWorkspace(url.searchParams.get('tab')).id, workspace.id)
  }
  assert.deepEqual(active('/system'), ['组织与权限'])
  assert.deepEqual(active('/system', '?tab=unknown'), ['组织与权限'])
  for (const item of items.filter(item => item.to.startsWith('/system/'))) {
    assert.deepEqual(active(item.to), [item.label])
  }
  assert.deepEqual(active('/projects'), [])
})

test('audit workspace removes migration and configuration tabs and redirects legacy links', () => {
  const workspace = systemWorkspaces.find(item => item.id === 'integrations')!
  assert.deepEqual(workspace.tabs, ['audit', 'rating-recovery'])
  const items = navigation.navSections[0].children
  assert.equal(items.find(item => item.label === workspace.label)?.to, '/system?tab=audit')
  for (const tab of ['operations', 'integrations-overview']) {
    assert.equal(resolveSystemTab(tab), 'audit')
    assert.equal(getSystemWorkspace(tab).id, workspace.id)
    assert.deepEqual(Array.from(items.filter(item => navigation.isSystemNavItemActive(item, '/system', `?tab=${tab}`)), item => item.label), [workspace.label])
  }
  for (const item of systemWorkspaces) for (const tab of item.tabs) assert.equal(resolveSystemTab(tab), tab)
  assert.equal(resolveSystemTab(null), 'users')
  assert.equal(resolveSystemTab('unknown'), 'users')
  const systemPage = readFileSync(new URL('../../src/pages/SystemPage.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(systemPage, /OperationsOverview|FdeIntegrationsPanel|迁移运维|连接与配置修订/)
  assert.match(systemPage, /const tab = resolveSystemTab\(requestedTab\)/)
  assert.match(systemPage, /setSearchParams\(next, \{ replace: true \}\)/)
})

test('FDE visual navigation preserves role and explicit capability gates', () => {
  const items = navigation.navSections[0].children
  const models = items.find(item => item.to === '/system/ai/models')!
  const capabilities = items.find(item => item.to === '/system/ai/capabilities')!
  const im = items.find(item => item.to === '/system/integrations/im-bots')!
  const system = items.find(item => item.to === '/system')!
  for (const item of items) {
    assert.equal(navigation.canSeeNavItem(item, '系统管理员'), true)
    assert.equal(navigation.canSeeNavItem(item, '投资经理'), false)
  }
  assert.equal(navigation.canSeeNavItem(models, 'AI平台管理员'), true)
  assert.equal(navigation.canSeeNavItem(capabilities, 'AI 平台管理员'), true)
  assert.equal(navigation.canSeeNavItem(im, '运营管理员'), true)
  assert.equal(navigation.canSeeNavItem(im, 'AI平台管理员'), false)
  assert.equal(navigation.canSeeNavItem(models, '投资经理', ['ai.configure']), false)
  assert.equal(navigation.canSeeNavItem(im, '投资经理', ['im.manage']), false)
  assert.equal(navigation.canSeeNavItem(system, '投资经理', ['ai.configure']), false)
  assert.deepEqual(Array.from(items.filter(item => navigation.canSeeNavItem(item, '投资经理', ['system.manage'])), item => item.label), [])
  assert.deepEqual(Array.from(items.filter(item => navigation.canSeeNavItem(item, 'AI平台管理员')), item => item.label), ['模型设置', '能力管理'])
  assert.deepEqual(Array.from(items.filter(item => navigation.canSeeNavItem(item, '运营管理员')), item => item.label), ['IM 机器人'])
})

test('FDE effective tokens and layout measurements match the retained reference', () => {
  const css = readFileSync(new URL('../../src/layout/fde-shell.css', import.meta.url), 'utf8')
  const root = postcss.parse(css)
  const tokens: Record<string, string> = {}
  root.walkRules('.fde-app', rule => { rule.walkDecls(decl => { if (decl.prop.startsWith('--')) tokens[decl.prop] = decl.value }) })
  assert.equal(tokens['--sidebar-w'], '244px')
  assert.equal(tokens['--topbar-h'], '64px')
  assert.equal(tokens['--brand'], '#2b6b74')
  assert.equal(tokens['--brand-strong'], '#1d5560')
  assert.equal(tokens['--bg'], '#f5f7f9')
  assert.equal(tokens['--radius'], '11px')
  root.walkRules(rule => { assert.ok(rule.selector.includes('fde-'), `Unscoped rule: ${rule.selector}`) })
  assert.doesNotMatch(css, /\.login-brand|:root\s*\{|\.input\s*\{[^}]*display:\s*none/)
  assert.ok(css.split('\n').every(line => !/[\t ]+$/.test(line)))
})

test('reference restyling leaves session restoration and protected routes in place', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /if \(!authenticated\) return <Navigate to="\/login"/)
  assert.match(app, /void restoreSession\(\)/)
  assert.match(app, /<AiPlatformAdminOnly><ModelSettingsPage\s*\/><\/AiPlatformAdminOnly>/)
  assert.match(app, /<AiPlatformAdminOnly><CapabilitySettingsPage\s*\/><\/AiPlatformAdminOnly>/)
  assert.match(app, /<ImAdminOnly><ImBotsPage\s*\/><\/ImAdminOnly>/)
})

test('detail tab links and Shanghai countdown retain empty, overdue and legacy states', () => {
  assert.deepEqual(projectDetailTabs.map(tab => tab.label), ['流程推进', '材料文件', '项目任务', '协作互动'])
  assert.equal(projectDetailTab('files'), 'files')
  assert.equal(projectDetailTab('meetings'), 'collaboration')
  assert.equal(projectDetailTab(null), 'workflow')
  assert.equal(projectDetailTab('invalid'), 'workflow')
  assert.equal(shortProjectDate(null), '未设置')
  assert.equal(shortProjectDate('2026-09-15'), '09.15')
  assert.equal(projectCountdown(null, '2026-08-28'), '尚未设置目标日')
  assert.equal(projectCountdown('2026-08-28', '2026-08-28'), '今天到达目标日')
  assert.equal(projectCountdown('2026-08-29', '2026-08-28'), '距项目目标日 1 天')
  assert.equal(projectCountdown('2026-08-27', '2026-08-28'), '已超目标日 1 天')
})

test('detail material counters require an accessible matching file version or explicit waiver', () => {
  const files = [{ id: 'file-1', version: 2 }] as Parameters<typeof materialIsSatisfied>[1]
  assert.equal(materialIsSatisfied([], files), false)
  assert.equal(materialIsSatisfied([{ fileId: 'file-1', fileVersion: 1, waiverReason: null }], files), false)
  assert.equal(materialIsSatisfied([{ fileId: 'not-visible', fileVersion: 2, waiverReason: null }], files), false)
  assert.equal(materialIsSatisfied([{ fileId: 'file-1', fileVersion: 2, waiverReason: null }], files), true)
  assert.equal(materialIsSatisfied([{ fileId: null, fileVersion: null, waiverReason: ' ' }], files), false)
  assert.equal(materialIsSatisfied([{ fileId: null, fileVersion: null, waiverReason: '已提供替代证据' }], files), true)
})

// Run the actual component JSX with bounded hook state, without connecting to a business DB.
function renderDetailComponent(file: string, name: string, props: object, states: unknown[], overrides: object = {}) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../../src/components/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const code = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source)).join('\n')
  let index = 0
  const uiSource = ts.createSourceFile('ui.tsx', readFileSync(new URL('../../src/components/ui.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const uiCode = uiSource.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(uiSource)).join('\n')
  const uiCompiled = ts.transpileModule(uiCode, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText
  const ui = runInNewContext(`${uiCompiled}\nexports`, { React, ...iconsForDetail, exports: {} })
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText
  const element = runInNewContext(`${compiled}\nReact.createElement(exports.${name}, props)`, {
    React, ...iconsForDetail, ...ui, exports: {}, props, ...{ materialIsSatisfied, projectCountdown, shortProjectDate },
    useState: (initial: unknown) => [index < states.length ? states[index++] : typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {}, useNavigate: () => () => {}, useToast: () => ({ showToast: () => {} }),
    useAuthStore: (selector: (value: unknown) => unknown) => selector({ user: { id: 'owner' } }),
    useAppStore: (selector: (value: unknown) => unknown) => selector({ approvalRequests: [] }),
    ...overrides,
  })
  return renderToStaticMarkup(element)
}

test('FDE detail hero is a compact two-row summary with one primary action', () => {
  const project = { id: 'fixture', name: '布局验收项目', classification: 'key', projectType: '投资项目', workflowModel: 'fde-v1', lifecycle: 'active', stage: '立项', targetDate: null }
  const props = { project, incompleteTaskCount: 1, onOverview: () => {}, onPrimary: () => {} }
  const restricted = renderDetailComponent('ProjectDetailHero.tsx', 'ProjectDetailHero', props, [])
  for (const label of ['布局验收项目', '重点项目', '立项', '项目负责人', '目标日期', '未完成任务', '1 项', '项目概况', '推进当前阶段']) assert.match(restricted, new RegExp(label))
  assert.doesNotMatch(restricted, /上传材料|领导批示|维护周计划|确认周计划|生成评分/)
  const closed = renderDetailComponent('ProjectDetailHero.tsx', 'ProjectDetailHero', { ...props, project: { ...project, lifecycle: 'archived' } }, [])
  assert.match(closed, /查看项目档案/)
  assert.doesNotMatch(closed, /推进当前阶段/)
})

test('workflow renders marker rail, evidence dates and current focus instead of inline binding forms', () => {
  const project = { id: 'fixture', stage: '立项', owner: '测试负责人', ownerUserId: 'owner', lifecycle: 'active', targetDate: '2026-09-15' }
  const data = { stages: [{ stage: '入库', materials: [] }, { stage: '立项', materials: [{ key: 'bp', label: '商业计划书' }] }], timeline: [{ stage: '入库', date: '2026-08-01', basis: 'cycle_projection', actualDate: null }, { stage: '立项', date: '2026-08-10', basis: 'cycle_projection', actualDate: '2026-08-09' }], policy: { cycleDays: [40], revision: 1 }, materials: [], plan: null, planHistory: [], members: [], duties: [], capabilities: { canEditPlan: true } }
  const html = renderDetailComponent('FdeWorkflowPanel.tsx', 'FdeWorkflowPanel', { project, files: [], onChanged: async () => {} }, [data])
  assert.match(html, /aria-label="项目流程"/)
  assert.match(html, /fde-detail-stage-rail/)
  assert.match(html, /当前节点/)
  assert.match(html, /待补材料 1 项/)
  assert.match(html, /入库<\/strong><small>08\.01/)
  assert.match(html, /计划 08.10/)
  assert.doesNotMatch(html, /选择项目材料文件|<select/)
  const expanded = renderDetailComponent('FdeWorkflowPanel.tsx', 'FdeWorkflowPanel', { project, files: [], onChanged: async () => {} }, [
    data, '', false, '立项', {}, null, '', 40, '2026-09-15', [], false, false, false, null, '立项',
  ])
  assert.match(expanded, /阶段详情 · 立项/)
  assert.match(expanded, /无审批节点/)
  const materials = renderDetailComponent('FdeWorkflowPanel.tsx', 'FdeWorkflowPanel', { project, files: [], mode: 'materials', onChanged: async () => {} }, [data])
  assert.match(materials, /节点材料/)
  assert.match(materials, /0 \/ 1 已齐备/)
  assert.doesNotMatch(materials, /投资周期行动计划/)
  const failed = renderDetailComponent('FdeWorkflowPanel.tsx', 'FdeWorkflowPanel', { project, files: [], onChanged: async () => {} }, [null, '权限已变更'])
  assert.match(failed, /role="alert"/)
  assert.doesNotMatch(failed, /aria-label="项目流程"/)
})

test('detail styling is scoped, with sticky separate tabs and responsive rails', () => {
  const css = readFileSync(new URL('../../src/pages/ProjectDetailPage.css', import.meta.url), 'utf8')
  const root = postcss.parse(css)
  root.walkRules(rule => assert.ok(rule.selector.includes('.fde-project-detail'), `Unscoped detail rule: ${rule.selector}`))
  assert.match(css, /\.fde-detail-tabs\s*\{[^}]*position: sticky/)
  assert.match(css, /\.fde-detail-stage::after\s*\{[^}]*top: 18px/)
  assert.match(css, /\.fde-detail-stage\[aria-pressed="true"\]::before/)
  assert.doesNotMatch(css, /\.fde-detail-stage\.current\s*\{[^}]*(?:margin|padding):/)
  assert.match(css, /@media \(max-width: 640px\)/)
  assert.ok(css.split('\n').every(line => !/[\t ]+$/.test(line)))
})
