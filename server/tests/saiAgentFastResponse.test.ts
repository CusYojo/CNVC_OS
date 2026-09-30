import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildSaiTurnReceipt,
  resolveSaiAgentContext,
} from '../../src/lib/saiAgent.js'
import {
  compactJwAgentInstruction,
  evaluateCompactInteraction,
  jwAgentToolsForResponseMode,
} from '../src/runtime/jwAgentCompactMode.js'

const project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '星河半导体',
  companyName: '星河半导体科技有限公司',
  stage: '尽调',
  lifecycle: 'active',
  owner: '李经理',
  riskLevel: '高',
  score: 82,
  progress: 64,
}

test('提交项目需求后立即返回有事实的处理回执', () => {
  const current = resolveSaiAgentContext(`/projects/${project.id}`, '?tab=files', [project])
  const receipt = buildSaiTurnReceipt(current, '找出材料中影响投决的三个关键风险', project, {
    activeTodos: 6,
    upcomingMeetings: 2,
    pendingApprovals: 1,
    highRisks: 3,
  })

  assert.equal(receipt.title, '已接收，先用现有信息开始')
  assert.match(receipt.goal, /三个关键风险/)
  assert.deepEqual(receipt.facts, [
    '当前项目：星河半导体',
    '阶段：尽调 · 负责人：李经理',
    '风险等级：高 · 项目评分：82',
  ])
  assert.equal(receipt.steps.length, 3)
  assert.match(receipt.clarification, /最多只补充 1 次/)
})

test('全局需求的回执带入当前待办摘要而非空泛转圈', () => {
  const current = resolveSaiAgentContext('/', '', [project])
  const receipt = buildSaiTurnReceipt(current, '今天先做什么', undefined, {
    activeTodos: 6,
    upcomingMeetings: 2,
    pendingApprovals: 1,
    highRisks: 3,
  })

  assert.deepEqual(receipt.facts, [
    '进行中任务：6',
    '待开会议：2 · 审批中：1',
    '未关闭高风险：3',
  ])
  assert.equal(receipt.steps.at(-1), '输出明确结论、依据缺口和可执行的下一步')
})

test('轻量模式只暴露读取和检索工具', () => {
  const tools = [
    'mcp__investment__get_project_summary',
    'mcp__investment__search_project_docs',
    'mcp__investment__read_project_file',
    'mcp__investment__collect_public_intel',
    'mcp__investment__create_ai_task',
    'mcp__investment__propose_evolution',
  ]

  assert.deepEqual(jwAgentToolsForResponseMode(tools, 'compact'), tools.slice(0, 4))
  assert.deepEqual(jwAgentToolsForResponseMode(tools, 'standard'), tools)
})

test('轻量模式最多向用户采集一步信息', () => {
  assert.deepEqual(evaluateCompactInteraction(1, 0), { allowed: true, nextUsedRounds: 1, reason: null })
  assert.deepEqual(evaluateCompactInteraction(2, 0), {
    allowed: false,
    nextUsedRounds: 0,
    reason: '请把关键缺口合并为一个问题，或基于合理假设直接完成。',
  })
  assert.deepEqual(evaluateCompactInteraction(1, 1), {
    allowed: false,
    nextUsedRounds: 1,
    reason: '本轮已完成一次信息补充，请基于现有信息给出结果并明确剩余缺口。',
  })
})

test('轻量模式约束答案有结论、依据与下一步', () => {
  const instruction = compactJwAgentInstruction(true)

  assert.match(instruction, /最多一次/)
  assert.match(instruction, /只提一个合并问题/)
  assert.match(instruction, /有效结果/)
  assert.match(instruction, /结论/)
  assert.match(instruction, /依据/)
  assert.match(instruction, /下一步/)
})

test('小赛前后端通过现有消息 API 显式开启轻量模式', async () => {
  const [component, hook, route, runtime] = await Promise.all([
    readFile(new URL('../../src/components/SaiUnicornAgent.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/hooks/useJwAgent.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/jwAgent.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtime/jwAgentRuntime.ts', import.meta.url), 'utf8'),
  ])

  assert.match(component, /responseMode:\s*'compact'/)
  assert.match(hook, /responseMode\?:\s*'standard'\s*\|\s*'compact'/)
  assert.match(route, /responseMode:\s*z\.enum\(\['standard',\s*'compact'\]\)/)
  assert.match(runtime, /jwAgentToolsForResponseMode\(/)
  assert.match(runtime, /responseMode === 'compact' \? 5/)
  assert.match(runtime, /session\.compactInteractionRoundsUsed = 0/)
})
