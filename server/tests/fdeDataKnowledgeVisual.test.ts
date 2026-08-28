import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const css = read('src/pages/DataKnowledgePage.css')
const company = read('src/components/FdeCompanyKnowledgePanel.tsx')
const archive = read('src/components/FdeProjectArchivePanel.tsx')
const page = read('src/pages/DataKnowledgePage.tsx')

test('knowledge visual rules remain scoped to this page', () => {
  postcss.parse(css).walkRules(rule => {
    assert.match(rule.selector, /fde-knowledge-page/)
    assert.doesNotMatch(rule.selector, /:root|\.fde-app\s*$/)
  })
})

test('reference knowledge grid uses three, two and one columns at its exact breakpoints', () => {
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
  assert.match(css, /max-width: 1440px[^\n]+repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /max-width: 900px[^\n]+grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(css, /fde-knowledge-library > \.fde-knowledge-grid:last-child \{ padding-bottom: 18px/)
})

test('card shortcuts still re-read detail and require current server capability', () => {
  assert.match(company, /detail\.entry\.id !== shortcut\.id \|\| selected !== shortcut\.id/)
  assert.match(company, /detail\.entry\.capabilities\.edit : detail\.entry\.capabilities\.interact/)
  assert.match(company, /item\.capabilities\.edit &&/)
  assert.match(company, /item\.capabilities\.interact &&/)
  for (const label of ['查阅', '编辑', '评价', '批注']) assert.ok(company.includes(`>${label}</Button>`))
  assert.match(company, /setAction\(null\); setInteraction\(null\); setComment\(''\)/)
  assert.match(company, /knowledgeWriteReceipt/)
  assert.match(company, /rememberKnowledgePending/)
})

test('archive default is the reference six-column table with extended tools retained', () => {
  assert.match(archive, /\['文件', '项目', '分类', '上传人', '权限', '操作'\]/)
  assert.match(archive, /className="fde-knowledge-table"/)
  assert.doesNotMatch(archive, /FolderOpen|fde-archive-sidebar/)
  assert.match(archive, /<details className="fde-knowledge-tools">/)
  assert.match(archive, /\/api\/project-archives\/export/)
  assert.match(archive, /file\.canDownload \? '可查看与下载' : '仅可查看'/)
  assert.match(archive, /capabilities\.upload &&/)
})

test('tabs and management rules continue to use server-authorized real data', () => {
  assert.match(page, /dataKnowledgeCapabilities\.parse/)
  assert.match(page, /responsibilityOverview\.parse/)
  assert.match(page, /management && <button/)
  const policy = read('src/components/FdeResponsibilityPolicyPanel.tsx')
  assert.match(policy, /if \(compact\)/)
  assert.match(policy, /data\.activeVersion\?\.configuration\.rules\.map/)
  assert.match(policy, /暂无已发布规则/)
  assert.doesNotMatch(policy, /scoreRules|KN-001/)
})

test('visual fixture has no DB, dotenv or upstream proxy and rejects all writes', () => {
  const fixture = read('scripts/preview-fde-data-knowledge.mjs')
  assert.doesNotMatch(fixture, /from ['"].*(?:db\/|dotenv|mysql)|process\.env\.(?:DB_|MYSQL)|proxy:/)
  assert.match(fixture, /!\['GET', 'HEAD'\]\.includes\(req\.method\)/)
  assert.match(fixture, /隔离视觉夹具禁止所有写操作/)
  assert.match(fixture, /server\.listen\(0, '127\.0\.0\.1'/)
})
