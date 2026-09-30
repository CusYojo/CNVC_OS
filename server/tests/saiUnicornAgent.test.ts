import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildSaiAgentPrompt,
  getSaiAgentActions,
  resolveSaiAgentContext,
} from '../../src/lib/saiAgent.js'

const projects = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: '星河半导体',
    companyName: '星河半导体科技有限公司',
    stage: '尽调',
    lifecycle: 'active',
  },
]

test('小赛能从项目路由安全解析当前项目', () => {
  const context = resolveSaiAgentContext(
    '/projects/11111111-1111-4111-8111-111111111111',
    '?tab=files',
    projects,
  )

  assert.equal(context.kind, 'project')
  assert.equal(context.label, '星河半导体')
  assert.equal(context.projectId, projects[0].id)
  assert.equal(context.projectName, projects[0].name)
  assert.equal(context.detail, '尽调 · 项目材料')
})

test('非 UUID 路由不会被错认为可授权项目上下文', () => {
  const context = resolveSaiAgentContext('/projects/boss-dashboard', '', projects)

  assert.equal(context.kind, 'workspace')
  assert.equal(context.projectId, undefined)
  assert.equal(context.label, '管理驾驶舱')
})

test('项目发现和尽调工作台获得不同的情景快捷动作', () => {
  const discovery = resolveSaiAgentContext('/projects', '?view=discover', projects)
  const dueDiligence = resolveSaiAgentContext('/due-diligence', '', projects)

  assert.equal(discovery.kind, 'discovery')
  assert.deepEqual(
    getSaiAgentActions(discovery).map((action) => action.id),
    ['screen-candidates', 'compare-leads', 'open-ai'],
  )
  assert.deepEqual(
    getSaiAgentActions(dueDiligence).map((action) => action.id),
    ['dd-checklist', 'evidence-conflicts', 'open-knowledge'],
  )
})

test('项目提示词带入当前上下文，并明确先计划再写入', () => {
  const context = resolveSaiAgentContext(
    '/projects/11111111-1111-4111-8111-111111111111',
    '?tab=files',
    projects,
  )
  const prompt = buildSaiAgentPrompt(context, '找出当前材料的主要风险')

  assert.match(prompt, /星河半导体/)
  assert.match(prompt, /11111111-1111-4111-8111-111111111111/)
  assert.match(prompt, /项目材料/)
  assert.match(prompt, /默认只读/)
  assert.match(prompt, /等待用户确认/)
  assert.match(prompt, /找出当前材料的主要风险/)
})

test('全局提示词不夹带无关项目标识', () => {
  const context = resolveSaiAgentContext('/', '', projects)
  const prompt = buildSaiAgentPrompt(context, '帮我梳理今天的事')

  assert.match(prompt, /全局工作台/)
  assert.doesNotMatch(prompt, /11111111-1111-4111-8111-111111111111/)
})

test('全局布局挂载小赛，并尊重减少动效设置', async () => {
  const [layoutSource, styleSource] = await Promise.all([
    readFile(new URL('../../src/layout/AppLayout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/SaiUnicornAgent.css', import.meta.url), 'utf8'),
  ])

  assert.match(layoutSource, /<SaiUnicornAgent/)
  assert.match(styleSource, /prefers-reduced-motion:\s*reduce/)
  assert.match(styleSource, /safe-area-inset-bottom/)
})
