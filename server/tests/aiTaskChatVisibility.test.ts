import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isFormalAiTaskControlPart,
  isFormalAiTaskReceiptMessage,
  type SafeAgentMessage,
} from '../../src/lib/aiMessageSafety.js'

const taskId = 'c794939c-ecf4-4943-a096-af9530f6d7ca'

function assistant(text: string): SafeAgentMessage {
  return {
    id: `message:${text}`,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    malformed: false,
  }
}

test('formal task create and status tools are hidden from the chat timeline', () => {
  assert.equal(isFormalAiTaskControlPart({
    type: 'dynamic-tool',
    toolName: 'mcp__investment__create_ai_task',
  }), true)
  assert.equal(isFormalAiTaskControlPart({
    type: 'dynamic-tool',
    toolName: 'get_ai_task_status',
  }), true)
  assert.equal(isFormalAiTaskControlPart({
    type: 'dynamic-tool',
    toolName: 'mcp__investment__search_project_docs',
  }), false)
})

test('formal task creation and status receipts are hidden while useful replies remain visible', () => {
  assert.equal(isFormalAiTaskReceiptMessage(assistant(
    '正式合规性说明任务已创建，我现在查询其执行阶段、补充资料请求和产物状态。',
  )), true)
  assert.equal(isFormalAiTaskReceiptMessage(assistant(
    `已创建正式《合规性说明》任务（ID：${taskId}）。当前进度 22%，正在联网补全公开证据。`,
  ), [taskId]), true)
  assert.equal(isFormalAiTaskReceiptMessage(assistant(
    '正式投资提案任务已成功创建，我现在查询执行进度和产物状态。',
  )), true)
  assert.equal(isFormalAiTaskReceiptMessage(assistant(
    '合规性说明应重点分析基金授权范围、关联交易与决策程序。',
  ), [taskId]), false)
})
