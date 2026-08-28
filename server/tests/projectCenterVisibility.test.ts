import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const page = readFileSync(new URL('../../src/pages/ProjectCenterPage.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('ProjectCenterPage.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const code = ts.transpileModule(
  source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source)).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } },
).outputText

function renderCenter(view: string | null, projects: Array<{ classification?: string; lifecycle?: string }> = []) {
  const params = new URLSearchParams(view === null ? '' : { view })
  const Component = runInNewContext(`${code}\nProjectCenterPage`, {
    exports: {}, React, URLSearchParams,
    FolderKanban: 'svg', Inbox: 'svg', Star: 'svg', UsersRound: 'svg',
    useSearchParams: () => [params, () => {}],
    useAppStore: (select: (state: { projects: typeof projects }) => unknown) => select({ projects }),
    ProjectsPage: ({ classification }: { classification: string }) => React.createElement('div', { 'data-classification': classification }),
    SourcingPage: () => React.createElement('div', { 'data-view': 'leads' }),
    FdeTypeRegistrationPanel: () => null,
  }) as React.ComponentType
  return renderToStaticMarkup(React.createElement(Component))
}

for (const view of [null, '', 'pool', 'unknown']) {
  test(`project center falls back to normal for ${JSON.stringify(view)}`, () => {
    const html = renderCenter(view)
    assert.doesNotMatch(html, /项目池|data-classification="pool"/)
    assert.match(html, /aria-selected="true"[^>]*>普通项目/)
    assert.match(html, /data-classification="normal"/)
  })
}

for (const view of ['leads', 'normal', 'key']) {
  test(`project center retains visible ${view} tab and content`, () => {
    const html = renderCenter(view, [{ classification: 'pool' }, {}, { classification: 'key' }, { classification: 'normal', lifecycle: 'archived' }])
    assert.doesNotMatch(html, /项目池/)
    assert.equal((html.match(/role="tab"/g) ?? []).length, 3)
    assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1)
    assert.match(html, /普通项目<em>1<\/em>/)
    assert.match(html, /重点项目<em>1<\/em>/)
    assert.ok(html.includes(view === 'leads' ? 'data-view="leads"' : `data-classification="${view}"`))
  })
}
