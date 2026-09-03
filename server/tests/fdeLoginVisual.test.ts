import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as icons from 'lucide-react'
import postcss from 'postcss'
import ts from 'typescript'

const css = readFileSync(new URL('../../src/pages/LoginPage.css', import.meta.url), 'utf8')

function compileComponent(path: string) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const code = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source)).join('\n')
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText
}

const ui = runInNewContext(`${compileComponent('../../src/components/ui.tsx')}\nexports`, { React, ...icons, exports: {} })
const loginCode = compileComponent('../../src/pages/LoginPage.tsx')

const emptyRegistration = { name: '', email: '', role: '', department: '', password: '', confirmPassword: '' }
const defaultOptions = { roles: ['投资经理', '法务'], departments: ['投资部', '法务部'] }

function login(states: unknown[] = ['login', { identifier: '', password: '', remember: true }, emptyRegistration, defaultOptions, false, false, false], overrides: object = {}) {
  let index = 0
  return runInNewContext(`${loginCode}\nexports.LoginPage()`, {
    React, ...icons, ...ui, exports: {},
    useState: () => [states[index++], () => {}],
    useNavigate: () => () => {},
    useAuthStore: (select: (state: object) => unknown) => select({ setAuth: () => {} }),
    useToast: () => ({ showToast: () => {} }),
    ...overrides,
  }) as React.ReactElement
}

function findForm(element: React.ReactElement): React.ReactElement<{ onSubmit: (event: object) => Promise<void> }> | undefined {
  if (element.type === 'form') return element as React.ReactElement<{ onSubmit: (event: object) => Promise<void> }>
  for (const child of React.Children.toArray(element.props.children)) {
    if (React.isValidElement(child)) {
      const form = findForm(child)
      if (form) return form
    }
  }
}

test('login renders a concise FDE brand frame and the login/register entry', () => {
  const html = renderToStaticMarkup(login())
  for (const text of ['login-screen', 'login-frame', 'login-card', 'login-mobile-lockup', '做精品创投', '与伟大企业同行', 'Cybernaut', '投早 · 投小 · 投硬科技', '欢迎回来', '进入系统', '申请账号', '赛智伯乐内部系统']) assert.ok(html.includes(text), text)
  assert.doesNotMatch(html, /SAIZHI BOLE|INVESTMENT WORKSPACE|专注判断|评审入口|免登录|初始密码|demo-entry|demo-panel|login-divider|项目推进|材料归档|协同排期|审批办公/)
  assert.match(html, /autoComplete="username"/)
  assert.match(html, /type="password"/)
  assert.match(html, /aria-label="显示密码" aria-pressed="false"/)
  assert.match(html, /type="checkbox" checked=""/)
})

test('login retains visible-password, unchecked remember and disabled loading presentation', () => {
  const html = renderToStaticMarkup(login(['login', { identifier: 'person@example.invalid', password: 'sample', remember: false }, emptyRegistration, defaultOptions, true, true, false]))
  assert.match(html, /type="text" autoComplete="current-password"/)
  assert.match(html, /aria-label="隐藏密码" aria-pressed="true"/)
  assert.doesNotMatch(html, /checked=""/)
  assert.match(html, /disabled="" type="submit"/)
  assert.match(html, /animate-spin/)
})

test('login dimensions, FDE colors and mobile breakpoints stay scoped to the login page', () => {
  const root = postcss.parse(css)
  const value = (selector: string, property: string) => {
    let result: string | undefined
    root.walkRules(selector, rule => {
      if (rule.parent?.type === 'root') rule.walkDecls(property, decl => { result = decl.value })
    })
    return result
  }
  assert.equal(value('.login-frame', 'width'), 'min(1160px, 100%)')
  assert.equal(value('.login-frame', 'grid-template-columns'), 'minmax(440px, .96fr) minmax(470px, 1.04fr)')
  assert.equal(value('.login-frame', 'border-radius'), '26px')
  assert.equal(value('.login-screen', 'line-height'), '1.58')
  assert.ok(value('.login-screen', 'font-family')?.startsWith('-apple-system, BlinkMacSystemFont'))
  assert.equal(value('.login-card', 'padding'), '36px 38px 32px')
  assert.equal(value('.login-field > div', 'height'), '50px')
  assert.equal(value('.login-screen .login-submit', 'background'), '#24555d')
  assert.equal(value('body:has(.login-screen)', 'min-width'), '320px')
  assert.doesNotMatch(css, /login-brand-panel::after|login-brand-kicker|#d8b47f/)
  root.walkRules(rule => { for (const selector of rule.selectors) assert.ok(selector.includes('.login-'), selector) })
  for (const breakpoint of ['980px', '760px', '430px']) assert.ok(css.includes(`@media (max-width: ${breakpoint})`))
  assert.ok(css.split('\n').every(line => !/[\t ]+$/.test(line)))
})

test('restyled form preserves login payload, session cookies and successful navigation', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = []
  const destinations: string[] = []
  let authenticated = false
  const element = login(['login', { identifier: ' person@example.invalid ', password: ' unchanged password ', remember: true }, emptyRegistration, defaultOptions, false, false, false], {
    fetch: async (url: string, options: RequestInit) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({ user: { id: 'synthetic-user' } }) }
    },
    useNavigate: () => (path: string) => destinations.push(path),
    useAuthStore: (select: (state: object) => unknown) => select({ setAuth: () => { authenticated = true } }),
  })
  await findForm(element)!.props.onSubmit({ preventDefault() {} })
  assert.equal(requests[0].url, '/api/auth/login')
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.credentials, 'include')
  assert.deepEqual(JSON.parse(String(requests[0].options.body)), { identifier: 'person@example.invalid', password: ' unchanged password ', remember: true })
  assert.equal(authenticated, true)
  assert.deepEqual(destinations, ['/'])
})

test('empty and failed login keep the existing error feedback without navigation', async () => {
  for (const empty of [true, false]) {
    const messages: string[] = []
    const element = login(['login', { identifier: empty ? ' ' : 'synthetic-user', password: 'sample', remember: true }, emptyRegistration, defaultOptions, false, false, false], {
      fetch: async () => {
        assert.equal(empty, false, 'empty credentials must not call the server')
        return { ok: false, json: async () => ({ message: '测试登录失败' }) }
      },
      useNavigate: () => () => assert.fail('failed login must not navigate'),
      useToast: () => ({ showToast: (message: string) => messages.push(message) }),
    })
    await findForm(element)!.props.onSubmit({ preventDefault() {} })
    assert.deepEqual(messages, [empty ? '请输入姓名或邮箱和密码' : '测试登录失败'])
  }
})

test('registration form posts the selected business position and waits for administrator approval', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = []
  const registration = { name: '测试申请人', email: 'apply@example.invalid', role: '投资经理', department: '投资部', password: 'Strong!Password9', confirmPassword: 'Strong!Password9' }
  const element = login(['register', { identifier: '', password: '', remember: true }, registration, defaultOptions, false, false, false], {
    fetch: async (url: string, options: RequestInit) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({ status: '待审核' }) }
    },
  })
  const html = renderToStaticMarkup(element)
  assert.match(html, /职务岗位/)
  assert.match(html, /所属部门/)
  assert.doesNotMatch(html, /系统管理员/)
  await findForm(element)!.props.onSubmit({ preventDefault() {} })
  assert.equal(requests[0].url, '/api/auth/register')
  assert.deepEqual(JSON.parse(String(requests[0].options.body)), {
    name: '测试申请人', email: 'apply@example.invalid', role: '投资经理', department: '投资部', password: 'Strong!Password9',
  })
})
