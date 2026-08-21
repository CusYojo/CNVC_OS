import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AiTaskCards, type AiTask } from '../../src/components/AiTaskCards.js'

Object.assign(globalThis, { React })

const task: AiTask = {
  id: 'task-1',
  projectId: 'project-1',
  type: 'investment_recommendation_ppt',
  parameters: {},
  templateVersion: 'investment-committee-ppt-20260821-v1-skill-native',
  status: 'succeeded',
  stage: 'PPTX 已生成',
  progress: 100,
  createdAt: '2026-08-21T02:31:00.000Z',
  updatedAt: '2026-08-21T02:31:00.000Z',
  completedAt: '2026-08-21T02:31:00.000Z',
  usage: {
    modelCalls: 1,
    usageCalls: 1,
    inputTokens: 941_000,
    outputTokens: 658,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 941_658,
    complete: true,
  },
  artifacts: [{
    id: 'artifact-1',
    taskId: 'task-1',
    fileName: '验收科技_投资建议书.pptx',
    format: 'pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    version: 14,
    editableLevel: 'all',
    templateVersion: 'investment-committee-ppt-20260821-v1-skill-native',
    qualityStatus: 'passed',
    metadata: { directSkillAgent: true, encodingClean: true },
  }],
  sources: Array.from({ length: 12 }, (_, index) => ({
    id: `source-${index}`,
    sourceName: `来源 ${index + 1}`,
    verificationStatus: 'Skill完整研读',
  })),
}

const html = renderToStaticMarkup(React.createElement(AiTaskCards, {
  tasks: [task],
  onCancel: async () => {},
  onRetry: async () => {},
}))

for (const text of [
  '投资建议书',
  '已完成',
  '业务标准模板',
  '引用来源：12 条',
  '报告 Token：941,658',
  '完成进度',
  '100%',
  '下载 PPTX · V14',
]) assert.ok(html.includes(text), `task card missing: ${text}`)
assert.ok(!html.includes('下载图片高保真版'))
assert.ok(!html.includes('下载元素级可编辑版'))

const quickActionsSource = await readFile(
  path.resolve(process.cwd(), 'src', 'components', 'AiQuickActions.tsx'),
  'utf8',
)
const assistantPageSource = await readFile(
  path.resolve(process.cwd(), 'src', 'pages', 'AIAssistantPage.tsx'),
  'utf8',
)
assert.ok(quickActionsSource.includes("id: 'investment_ppt'"))
assert.ok(quickActionsSource.includes("mode: 'task'"))
assert.ok(quickActionsSource.includes("structureMode: action.id === 'investment_ppt' ? 'standard'"))
assert.ok(quickActionsSource.includes("activeAction?.id === 'investment_ppt'"))
assert.ok(!quickActionsSource.includes('onCreatePreparationTask'))
assert.ok(!quickActionsSource.includes('preparationTaskId'))
assert.ok(assistantPageSource.includes("|| request.actionId === 'investment_ppt'"))
assert.ok(assistantPageSource.includes('parameters.attachmentFileIds = attachmentFileIds'))
assert.ok(assistantPageSource.includes('parameters.userInstructions = combinedUserInstructions'))
assert.ok(assistantPageSource.includes("parameters.structureMode = 'standard'"))
assert.ok(!assistantPageSource.includes("'/ai/tasks/preparations/investment-ppt'"))

console.log('direct investment committee PPT task card acceptance passed')
