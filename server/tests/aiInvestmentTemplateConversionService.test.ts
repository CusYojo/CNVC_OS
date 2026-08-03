import assert from 'node:assert/strict'
import test from 'node:test'
import {
  conversionFailureMessage,
} from '../src/services/aiInvestmentTemplateConversionService.js'

test('does not classify a canvas validation failure as a timeout because of CLI option names', () => {
  const error = Object.assign(new Error(
    'convert_pdf.py --command-timeout-seconds 1800\n'
    + 'RuntimeError: 检测到 2 个对象越出画布，详见 canvas-overflow-report.json',
  ), {
    killed: false,
    code: 1,
  })

  assert.equal(
    conversionFailureMessage(error),
    'PDF 模板转换后的对象越出幻灯片画布，未通过版式边界检查',
  )
})

test('keeps reporting a real killed conversion as a timeout', () => {
  const error = Object.assign(new Error('Command failed'), {
    killed: true,
    code: null,
  })

  assert.equal(
    conversionFailureMessage(error),
    'PDF 模板转换超时，请精简模板或改为上传原生 PPTX',
  )
})

test('reports semantic object validation failures precisely', () => {
  const error = Object.assign(new Error(
    'RuntimeError: 语义构建验证失败：缺少 31 个对象，构建失败 31 个对象',
  ), {
    killed: false,
    code: 1,
  })

  assert.equal(
    conversionFailureMessage(error),
    'PDF 模板已完成页面转换，但可编辑对象语义校验未通过',
  )
})
