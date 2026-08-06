import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldHideAiTaskFailureDiagnostics } from '../../src/lib/aiTaskPresentation.js'

test('investment recommendation quality gate hides internal failure diagnostics', () => {
  assert.equal(shouldHideAiTaskFailureDiagnostics({
    type: 'investment_recommendation_ppt',
    status: 'failed',
    stage: '投资建议书正文专业性检查未通过',
    errorMessage: '投资建议书正文未达到交付标准，尚需完善：章节内容、数据与表格、章节匹配。',
  }), true)
})

test('investment recommendation quality gate also hides historical cards by message', () => {
  assert.equal(shouldHideAiTaskFailureDiagnostics({
    type: 'investment_recommendation_ppt',
    status: 'failed',
    stage: '文档尚未完成',
    errorMessage: '投资建议书正文未达到交付标准，章节完整性仍需完善。',
  }), true)
})

test('Gorden final visual review hides internal recovery diagnostics', () => {
  assert.equal(shouldHideAiTaskFailureDiagnostics({
    type: 'investment_recommendation_ppt',
    status: 'failed',
    stage: 'Gorden 最终视觉复核未通过',
    errorMessage: 'Gorden 可编辑稿存在契约文字缺失、严重遮挡、裁切或不可读问题，未通过最终交付复核。',
  }), true)
})

test('Gorden final visual review also hides historical cards by message', () => {
  assert.equal(shouldHideAiTaskFailureDiagnostics({
    type: 'investment_recommendation_ppt',
    status: 'failed',
    stage: '文档尚未完成',
    errorMessage: 'Gorden 可编辑稿存在契约文字缺失、严重遮挡、裁切或不可读问题。',
  }), true)
})

test('operational PPT failures keep actionable diagnostics visible', () => {
  assert.equal(shouldHideAiTaskFailureDiagnostics({
    type: 'investment_recommendation_ppt',
    status: 'failed',
    stage: 'Gorden 页面视觉定位未完成',
    errorMessage: '图片网关暂时不可用，请稍后继续生成。',
  }), false)
})

test('other document failures keep their diagnostics visible', () => {
  assert.equal(shouldHideAiTaskFailureDiagnostics({
    type: 'due_diligence_report',
    status: 'failed',
    stage: '正文质量检查未通过',
    errorMessage: '尽调正文未达到交付标准。',
  }), false)
})
