import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  isUserVisibleMessagePart,
  Markdown,
  MessagePart,
} from '../../src/pages/AIAssistantPage.js'

const evidenceDir = path.resolve('.runtime/migration-evidence/jw-message-rendering')

async function writeEvidence(report: Record<string, unknown>) {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const target = path.resolve(evidenceDir, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

const marker = randomUUID()
const markdown = [
  '# 渲染验收标题',
  '',
  '普通文本与 **加粗文本**。',
  '',
  '| 指标 | 结果 |',
  '| --- | --- |',
  '| Markdown 表格 | 通过 |',
  '',
  '```ts',
  'const answer: number = 42',
  '```',
  '',
  '[安全链接](https://example.invalid/render-source)',
  '',
  '[危险链接](javascript:alert(1))',
].join('\n')
const reasoning = `仅用于折叠验证的内部思考-${marker}`

const markdownHtml = renderToStaticMarkup(createElement(Markdown, null, markdown))
assert.match(markdownHtml, /<h1[^>]*>渲染验收标题<\/h1>/)
assert.match(markdownHtml, /<strong[^>]*>加粗文本<\/strong>/)
assert.match(markdownHtml, /<table[^>]*>/)
assert.match(markdownHtml, /<th[^>]*>指标<\/th>/)
assert.match(markdownHtml, /<td[^>]*>Markdown 表格<\/td>/)
assert.match(markdownHtml, /<code[^>]*language-ts[^>]*>const answer: number = 42/)
assert.match(markdownHtml, /href="https:\/\/example\.invalid\/render-source"/)
assert.match(markdownHtml, /target="_blank"/)
assert.match(markdownHtml, /rel="noreferrer"/)
assert.doesNotMatch(markdownHtml, /href="javascript:/i)

const combinedHtml = renderToStaticMarkup(createElement(
  Fragment,
  null,
  createElement(MessagePart, { part: { type: 'reasoning', text: reasoning } }),
  createElement(MessagePart, { part: { type: 'text', text: markdown } }),
))
assert.match(combinedHtml, /<details[^>]*>/)
assert.doesNotMatch(combinedHtml, /<details[^>]*\sopen(?:=|\s|>)/)
assert.match(combinedHtml, /<summary[^>]*>💭 思考过程<\/summary>/)
assert(combinedHtml.indexOf(reasoning) > combinedHtml.indexOf('<details'))
assert(combinedHtml.indexOf(reasoning) < combinedHtml.indexOf('</details>'))
assert(combinedHtml.indexOf('</details>') < combinedHtml.indexOf('渲染验收标题'))
assert.equal(isUserVisibleMessagePart({ type: 'reasoning', text: reasoning }), true)
assert.equal(isUserVisibleMessagePart({ type: 'dynamic-tool', toolName: 'bash', state: 'call' }), false)
assert.equal(isUserVisibleMessagePart({ type: 'dynamic-tool', toolName: 'AskUserQuestion', state: 'call' }), false)

const toolHtml = renderToStaticMarkup(createElement(
  Fragment,
  null,
  createElement(MessagePart, { part: {
    type: 'dynamic-tool', toolName: 'search_project_docs', state: 'input-available',
    input: { query: '工具进度验收-运行中' },
  } }),
  createElement(MessagePart, { part: {
    type: 'dynamic-tool', toolName: 'search_project_docs', state: 'output-available',
    input: { query: '工具进度验收-成功' }, output: { hits: 2 },
  } }),
  createElement(MessagePart, { part: {
    type: 'dynamic-tool', toolName: 'search_project_docs', state: 'output-error',
    input: { query: '工具进度验收-失败' }, errorText: '合成的工具错误',
  } }),
))
assert.match(toolHtml, /aria-label="工具步骤 [^"]+ 运行中"/)
assert.match(toolHtml, /aria-label="工具步骤 [^"]+ 完成"/)
assert.match(toolHtml, /aria-label="工具步骤 [^"]+ 失败"/)
assert.match(toolHtml, /aria-expanded="false"/)
assert.doesNotMatch(toolHtml, /hits/)
assert.doesNotMatch(toolHtml, /合成的工具错误/)

const checks = [
  'plain-text-heading-and-strong-markdown-rendered',
  'gfm-table-headers-and-cells-rendered',
  'fenced-code-language-and-content-rendered',
  'safe-link-opens-separately-with-noreferrer',
  'unsafe-javascript-link-href-neutralized',
  'reasoning-defaults-to-closed-details',
  'reasoning-remains-separate-from-final-answer',
  'shell-and-ask-user-question-tool-details-hidden',
  'tool-running-success-and-error-states-are-accessible',
  'tool-details-default-to-collapsed-without-rendering-output',
  'mode: 0o600',
]
await writeEvidence({
  ok: true,
  generatedAt: new Date().toISOString(),
  checks,
  renderedSourceBodiesPersisted: 0,
})
console.log(JSON.stringify({ ok: true, checks }))
