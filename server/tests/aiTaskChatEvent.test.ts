import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleTaskEventStage } from '../src/repositories/mysql/mysqlAiTaskRepository.js'

test('chat event stage removes heartbeat seconds but preserves the actual phase', () => {
  assert.equal(
    visibleTaskEventStage('大模型正在生成投资建议书初稿（已等待 120 秒）'),
    '大模型正在生成投资建议书初稿',
  )
  assert.equal(
    visibleTaskEventStage('模型正在生成章节（3/12）商业模式，已等待45秒'),
    '模型正在生成章节（3/12）商业模式',
  )
})

test('chat event stage keeps factual chapter counters and reviewer phases', () => {
  assert.equal(
    visibleTaskEventStage('Reviewer 检查章节（5/12）财务分析'),
    'Reviewer 检查章节（5/12）财务分析',
  )
  assert.equal(
    visibleTaskEventStage('  DOCX   已生成  '),
    'DOCX 已生成',
  )
})
