import assert from 'node:assert/strict'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AiTaskCards, type AiTask } from '../../src/components/AiTaskCards.js'

Object.assign(globalThis, { React })

const baseTask = {
  projectId: 'project-1',
  parameters: {},
  status: 'succeeded' as const,
  stage: 'DOCX 已生成',
  progress: 100,
  createdAt: '2026-08-21T02:31:00.000Z',
  updatedAt: '2026-08-21T02:31:00.000Z',
  completedAt: '2026-08-21T02:31:00.000Z',
  usage: {
    modelCalls: 1,
    usageCalls: 1,
    inputTokens: 120_000,
    outputTokens: 658,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 120_658,
    complete: true,
  },
  sources: Array.from({ length: 9 }, (_, index) => ({
    id: `source-${index}`,
    sourceName: `来源 ${index + 1}`,
    verificationStatus: 'Skill完整研读',
  })),
}

const tasks: AiTask[] = [
  {
    ...baseTask,
    id: 'task-qa',
    type: 'project_qa',
    templateVersion: 'draft-investment-qa-20260821-v2-skill-native',
    artifacts: [{
      id: 'artifact-qa',
      taskId: 'task-qa',
      fileName: '验收科技_项目Q&A报告.docx',
      format: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      version: 5,
      editableLevel: 'text-and-structure',
      templateVersion: 'draft-investment-qa-20260821-v2-skill-native',
      qualityStatus: 'passed',
      metadata: { directSkillAgent: true, encodingClean: true },
    }],
  },
  {
    ...baseTask,
    id: 'task-dd',
    type: 'due_diligence_report',
    templateVersion: 'draft-due-diligence-report-20260821-v1-skill-native',
    artifacts: [{
      id: 'artifact-dd',
      taskId: 'task-dd',
      fileName: '验收科技_尽职调查报告.docx',
      format: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      version: 6,
      editableLevel: 'text-and-structure',
      templateVersion: 'draft-due-diligence-report-20260821-v1-skill-native',
      qualityStatus: 'passed',
      metadata: { directSkillAgent: true, encodingClean: true },
    }],
  },
]

const html = renderToStaticMarkup(React.createElement(AiTaskCards, {
  tasks,
  onCancel: async () => {},
  onRetry: async () => {},
}))

for (const text of [
  '项目 Q&amp;A',
  '尽调报告',
  '已完成',
  '业务标准模板',
  '引用来源：9 条',
  '报告 Token：120,658',
  '完成进度',
  '100%',
  '下载 DOCX · V5',
  '下载 DOCX · V6',
]) assert.ok(html.includes(text), `task card missing: ${text}`)

console.log('direct Q&A and due-diligence task card acceptance passed')
