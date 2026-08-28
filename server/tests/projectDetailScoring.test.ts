import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bot, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import ts from 'typescript'

// Execute the page's actual JSX, without loading its browser stores, effects or APIs.
const text = readFileSync(new URL('../../src/pages/ProjectDetailPage.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('ProjectDetailPage.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declarations = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && ['renderSummary', 'renderProjectArchive', 'tabContent'].includes(node.name.text)) {
    declarations.set(node.name.text, `const ${node.getText(source)};`)
  }
  ts.forEachChild(node, visit)
}
visit(source)
assert.equal(declarations.size, 3)
const uiText = readFileSync(new URL('../../src/components/ui.tsx', import.meta.url), 'utf8')
const uiSource = ts.createSourceFile('ui.tsx', uiText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const uiDeclarations = uiSource.statements.filter((node) => ts.isFunctionDeclaration(node)
  && node.name && ['Badge', 'Button', 'Card', 'ProgressBar'].includes(node.name.text))
  .map((node) => node.getText(uiSource).replace(/^export /, ''))
assert.equal(uiDeclarations.length, 4)
const js = ts.transpileModule([...uiDeclarations, ...declarations.values()].join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText

function render(scoring: unknown, view: 'score' | 'workflow' | 'archive' = 'score'): string {
  const empty = () => null
  const element = runInNewContext(`${js}\n${view === 'workflow' ? 'tabContent.workflow()' : view === 'archive' ? 'renderProjectArchive()' : 'renderSummary()'}`, {
    React, Bot, LoaderCircle, RefreshCw, Sparkles,
    project: { scoring, workflowModel: 'fde-v1', projectType: '投资项目' },
    generating: false, generateSummary: empty, requestedTab: null,
    FdeProjectReplanPanel: empty, hydrateFromServer: empty, fdePanel: empty, renderWorkflow: empty, renderOverview: empty, renderIntelligence: empty, renderRisks: empty,
  })
  return renderToStaticMarkup(element)
}

function completeScore() {
  return {
    total: 80, verdict: '建议关注', overall_comment: '评分已完成',
    dimensions: [{ key: 'team', name: '核心团队', score: 8, max: 10,
      items: [{ name: '行业经验', score: 8, max: 10, reason: '已核验履历' }] }],
  }
}

test('enrichment-only project scoring renders a truthful empty state without mutating evidence', () => {
  const scoring = Object.freeze({ registry: {}, whatIsIt: '公司介绍', enrichment: {},
    projectName: '测试项目', structuredNews: [], structuredTeam: [], registryEvidence: [],
    sourceLabeledProfile: {}, structuredShareholders: [], fundingRoundsResearched: [] })
  const before = JSON.stringify(scoring)
  const html = render(scoring)
  assert.match(html, /暂无完整的项目 AI 评分/)
  assert.match(html, /生成项目评分/)
  assert.doesNotMatch(html, /一级市场评分（多维度加总）/)
  assert.equal(JSON.stringify(scoring), before)
})

test('FDE workflow stays focused while archived scoring remains available and safe', () => {
  assert.doesNotMatch(render({ enrichment: {}, registry: {} }, 'workflow'), /项目 AI 摘要与评分|OA 审批实例/)
  const html = render({ enrichment: {}, registry: {} }, 'archive')
  assert.match(html, /项目 AI 摘要与评分/)
  assert.match(html, /暂无完整的项目 AI 评分/)
  assert.doesNotMatch(html, /<details[^>]*\bopen/)
})

test('missing, invalid and partial scoring arrays do not crash or fabricate a completed score', () => {
  const score = completeScore()
  for (const scoring of [undefined, null, {}, 'invalid', { ...score, total: undefined },
    { ...score, total: NaN }, { ...score, total: Infinity }, { ...score, dimensions: undefined },
    { ...score, dimensions: null }, { ...score, dimensions: {} }, { ...score, dimensions: [] },
    { ...score, dimensions: [null] }, { ...score, dimensions: [{ ...score.dimensions[0], items: undefined }] },
    { ...score, dimensions: [{ ...score.dimensions[0], items: null }] },
    { ...score, dimensions: [{ ...score.dimensions[0], items: {} }] },
    { ...score, dimensions: [{ ...score.dimensions[0], items: [null] }] }]) {
    assert.match(render(scoring), /暂无完整的项目 AI 评分/)
  }
})

test('complete and zero-valued scores retain their dimensions, explanations and rescore action', () => {
  for (const total of [0, 80]) {
    const html = render({ ...completeScore(), total })
    assert.match(html, /一级市场评分（多维度加总）/)
    assert.match(html, /核心团队/)
    assert.match(html, /行业经验/)
    assert.match(html, /已核验履历/)
    assert.match(html, /重新评分/)
    assert.doesNotMatch(html, /暂无完整的项目 AI 评分/)
  }
})

test('malformed optional competitors do not crash or relax evidence filtering', () => {
  for (const competitors of [undefined, null, {}, [null]]) {
    const html = render({ ...completeScore(), competitors })
    assert.match(html, /核心团队/)
    assert.doesNotMatch(html, /有证据的直接竞对/)
  }
  const html = render({ ...completeScore(), competitors: [null,
    { name: '已核验竞对', verificationStatus: 'evidence-backed' },
    { name: '未经核验竞对', verificationStatus: 'unverified' }] })
  assert.match(html, /已核验竞对/)
  assert.doesNotMatch(html, /未经核验竞对/)
})
