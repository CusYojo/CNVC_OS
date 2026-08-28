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

function login(states: unknown[] = ['', '', false, true, false], overrides: object = {}) {
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

test('login renders the FDE frame and account card without review, demo or initial-password entry', () => {
  const html = renderToStaticMarkup(login())
  for (const text of ['login-screen', 'login-frame', 'login-card', 'login-mobile-lockup', '统一工作空间', '账号登录', '进入工作台', '企业内部数据 · 权限隔离访问']) assert.ok(html.includes(text), text)
  assert.doesNotMatch(html, /评审入口|免登录|初始密码|demo-entry|demo-panel|login-divider|欢迎回来/)
  assert.match(html, /autoComplete="username"/)
  assert.match(html, /title="支持姓名或工作邮箱"/)
  assert.match(html, /type="password"/)
  assert.match(html, /aria-label="显示密码" aria-pressed="false"/)
  assert.match(html, /type="checkbox" checked=""/)
})

test('login retains visible-password, unchecked remember and disabled loading presentation', () => {
  const html = renderToStaticMarkup(login(['person@example.invalid', 'sample', true, false, true]))
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
  assert.equal(value('.login-frame', 'width'), 'min(1120px, 100%)')
  assert.equal(value('.login-frame', 'grid-template-columns'), 'minmax(430px, 1.04fr) minmax(410px, .96fr)')
  assert.equal(value('.login-frame', 'border-radius'), '26px')
  assert.equal(value('.login-screen', 'line-height'), '1.58')
  assert.ok(value('.login-screen', 'font-family')?.startsWith('-apple-system, BlinkMacSystemFont'))
  assert.equal(value('.login-card', 'padding'), '36px 38px 32px')
  assert.equal(value('.login-field > div', 'height'), '50px')
  assert.equal(value('.login-screen .login-submit', 'background'), '#24555d')
  assert.equal(value('body:has(.login-screen)', 'min-width'), '320px')
  root.walkRules(rule => { for (const selector of rule.selectors) assert.ok(selector.includes('.login-'), selector) })
  for (const breakpoint of ['980px', '760px', '430px']) assert.ok(css.includes(`@media (max-width: ${breakpoint})`))
  assert.ok(css.split('\n').every(line => !/[\t ]+$/.test(line)))
})

test('restyled form preserves login payload, session cookies and successful navigation', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = []
  const destinations: string[] = []
  let authenticated = false
  const element = login([' person@example.invalid ', ' unchanged password ', false, true, false], {
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
    const element = login([empty ? ' ' : 'synthetic-user', 'sample', false, true, false], {
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
