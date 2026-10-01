import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('discovery and AI platform have independent nested sidebar navigation', async () => {
  const [layout, shell] = await Promise.all([
    read('src/layout/AppLayout.tsx'),
    read('src/layout/fde-shell.css'),
  ])

  assert.match(layout, /label: '项目中心'[\s\S]*label: '新项目发现'[\s\S]*children:[\s\S]*label: '线索池'/)
  assert.match(layout, /label: 'AI 智能平台'[\s\S]*children:[\s\S]*label: 'AI 智能助手'[\s\S]*label: '智能 Skill 库'[\s\S]*label: '智能 Agent 库'/)
  assert.match(layout, /aria-expanded=\{[^}]+\}/)
  assert.match(layout, /aria-controls=\{[^}]+\}/)
  assert.match(layout, /aria-current=\{[^}]+\}/)
  assert.match(layout, /setExpandedSection\(/)
  assert.match(layout, /\[location\.pathname\]/, 'route changes should update open section')
  assert.match(shell, /\.fde-nav-subitems/)
  assert.match(shell, /\.fde-nav-subitem:focus-visible/)
})

test('discovery and prompt library routes are protected and mounted separately from project center', async () => {
  const [app, center] = await Promise.all([
    read('src/App.tsx'),
    read('src/pages/ProjectCenterPage.tsx'),
  ])

  assert.match(app, /path="\/discovery" element=\{<ProjectDiscoveryPage\s*\/>\}/)
  assert.match(app, /path="\/discovery\/leads" element=\{<SourcingPage\s*\/>\}/)
  assert.match(app, /path="\/ai\/skills"/)
  assert.match(app, /path="\/ai\/agents"/)
  assert.doesNotMatch(center, /<ProjectDiscoveryPage\s*\/>|<SourcingPage\s*\/>/)
  assert.doesNotMatch(center, /label: '新项目发现'|label: '线索池'/)
})
