export const TEMPLATE_FIDELITY_MINIMUM = 0.9

export type TemplateFidelityDimension =
  | 'structure'
  | 'typography'
  | 'layout'
  | 'tables'
  | 'contentOrganization'

export type TemplateFidelityCheck = {
  code: string
  passed: boolean
  critical?: boolean
}

export type TemplateFidelityAssessment = {
  target: number
  score: number
  passed: boolean
  dimensions: Record<TemplateFidelityDimension, {
    weight: number
    score: number
    passedChecks: number
    totalChecks: number
  }>
  failedChecks: string[]
  failedCriticalChecks: string[]
}

const DIMENSION_WEIGHTS: Record<TemplateFidelityDimension, number> = {
  structure: 0.25,
  typography: 0.2,
  layout: 0.2,
  tables: 0.15,
  contentOrganization: 0.2,
}

function roundScore(value: number) {
  return Math.round(value * 10_000) / 10_000
}

/**
 * 计算正式文档相对公司标准模板的交付分。任何维度都必须提供可验证检查项，
 * 不能用任务参数中的目标值冒充实测值。
 */
export function assessTemplateFidelity(input: {
  dimensions: Record<TemplateFidelityDimension, TemplateFidelityCheck[]>
  target?: number
}): TemplateFidelityAssessment {
  const target = input.target ?? TEMPLATE_FIDELITY_MINIMUM
  const dimensions = {} as TemplateFidelityAssessment['dimensions']
  const failedChecks: string[] = []
  const failedCriticalChecks: string[] = []
  let weightedScore = 0

  for (const dimension of Object.keys(DIMENSION_WEIGHTS) as TemplateFidelityDimension[]) {
    const checks = input.dimensions[dimension]
    if (!checks.length) {
      throw new Error(`模板还原度维度缺少检查项：${dimension}`)
    }
    const passedChecks = checks.filter((check) => check.passed).length
    const dimensionScore = passedChecks / checks.length
    const weight = DIMENSION_WEIGHTS[dimension]
    weightedScore += dimensionScore * weight
    dimensions[dimension] = {
      weight,
      score: roundScore(dimensionScore),
      passedChecks,
      totalChecks: checks.length,
    }
    checks.forEach((check) => {
      if (check.passed) return
      failedChecks.push(`${dimension}:${check.code}`)
      if (check.critical) failedCriticalChecks.push(`${dimension}:${check.code}`)
    })
  }

  const score = roundScore(weightedScore)
  return {
    target,
    score,
    passed: weightedScore >= target && failedCriticalChecks.length === 0,
    dimensions,
    failedChecks,
    failedCriticalChecks,
  }
}

export function assertTemplateFidelity(
  assessment: TemplateFidelityAssessment,
): asserts assessment is TemplateFidelityAssessment & { passed: true } {
  if (assessment.passed) return
  const error = Object.assign(
    new Error(
      `模板还原度 ${(assessment.score * 100).toFixed(1)}%，低于正式交付最低要求 ${(assessment.target * 100).toFixed(0)}%`,
    ),
    {
      code: 'TEMPLATE_FIDELITY_BELOW_MINIMUM',
      templateFidelity: assessment,
    },
  )
  throw error
}
