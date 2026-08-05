import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessTemplateFidelity,
  assertTemplateFidelity,
  TEMPLATE_FIDELITY_MINIMUM,
  type TemplateFidelityDimension,
} from '../src/services/aiTemplateFidelityService.js'

const dimensionNames: TemplateFidelityDimension[] = [
  'structure',
  'typography',
  'layout',
  'tables',
  'contentOrganization',
]

function allPassing() {
  return Object.fromEntries(dimensionNames.map((dimension) => [
    dimension,
    [{ code: `${dimension}-ok`, passed: true, critical: true }],
  ])) as Parameters<typeof assessTemplateFidelity>[0]['dimensions']
}

test('模板还原度 90% 是正式交付硬门槛', () => {
  const dimensions = allPassing()
  dimensions.layout = [
    { code: 'layout-ok', passed: true },
    { code: 'layout-warning', passed: false },
  ]
  const assessment = assessTemplateFidelity({ dimensions })
  assert.equal(TEMPLATE_FIDELITY_MINIMUM, 0.9)
  assert.equal(assessment.score, 0.9)
  assert.equal(assessment.passed, true)
})

test('低于 90% 不得作为正式完成版本', () => {
  const dimensions = allPassing()
  dimensions.structure = [
    { code: 'section-1', passed: true },
    { code: 'section-2', passed: false },
  ]
  const assessment = assessTemplateFidelity({ dimensions })
  assert.equal(assessment.score, 0.875)
  assert.equal(assessment.passed, false)
  assert.throws(
    () => assertTemplateFidelity(assessment),
    (error: unknown) =>
      (error as { code?: string }).code === 'TEMPLATE_FIDELITY_BELOW_MINIMUM',
  )
})

test('显示值四舍五入为 90% 时仍按未舍入实测值拦截', () => {
  const dimensions = allPassing()
  dimensions.layout = Array.from({ length: 5_000 }, (_, index) => ({
    code: `layout-${index}`,
    passed: index < 2_499,
  }))
  const assessment = assessTemplateFidelity({ dimensions })
  assert.equal(assessment.score, 0.9)
  assert.equal(assessment.passed, false)
})

test('关键结构失败时即使总分超过 90% 也不得交付', () => {
  const dimensions = allPassing()
  dimensions.structure = [
    ...Array.from({ length: 19 }, (_, index) => ({ code: `section-${index}`, passed: true })),
    { code: 'section-order', passed: false, critical: true },
  ]
  const assessment = assessTemplateFidelity({ dimensions })
  assert.ok(assessment.score > 0.9)
  assert.equal(assessment.passed, false)
  assert.deepEqual(assessment.failedCriticalChecks, ['structure:section-order'])
})
