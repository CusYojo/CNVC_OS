import { z } from 'zod'
import type { compareEvolutionDueDiligence } from './evolutionDueDiligenceComparison.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'

type AssessmentInput = Parameters<Parameters<typeof compareEvolutionDueDiligence>[0]['assess']>[0]
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const rule = z.object({ id: z.string().min(1).max(100), gate: z.enum(['sources', 'required_fields', 'scope', 'regression']),
  text: z.string().min(1).max(4000), expectation: z.enum(['present', 'absent']), weight: z.number().positive().max(100) }).strict()
const suiteSchema = z.object({ schemaVersion: z.literal(1), version: z.string().min(1).max(100),
  samples: z.array(z.object({ sampleHash: hash, rules: z.array(rule).min(4).max(200) }).strict()).min(1).max(100) }).strict()
const pagesSchema = z.array(z.object({ page: z.number().int().positive(), width: z.number().positive(), height: z.number().positive(),
  text: z.string().max(100000) }).strict()).min(1).max(80)
const visualSchema = z.object({ verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']), evidence: z.string().min(1).max(100000),
  reviewedPages: z.array(z.object({ page: z.number().int().positive(), sha256: hash }).strict()).max(80) }).strict()

/** Fixed host rubric: never include these expectations in the development or generation prompt.
 * Exact-span rules verify configured facts/citations and forbidden scope markers; they do not replace semantic or visual review.
 */
export function createEvolutionDueDiligenceAssessment(config: unknown, reviewPages: (input: {
  pages: { page: number; sha256: string; content: Buffer }[]; signal: AbortSignal; budget: AssessmentInput['budget']
}) => Promise<z.infer<typeof visualSchema>>) {
  const suite = suiteSchema.parse(structuredClone(config))
  const gates = ['sources', 'required_fields', 'scope', 'regression'] as const
  if (new Set(suite.samples.map(sample => sample.sampleHash)).size !== suite.samples.length
    || suite.samples.some(sample => new Set(sample.rules.map(rule => rule.id)).size !== sample.rules.length
      || gates.some(gate => !sample.rules.some(rule => rule.gate === gate)))) throw Error('Incomplete or duplicate fixed assessment rubric')
  const profileHash = evolutionContentHash(suite)
  return { profileHash, assess: async (input: AssessmentInput) => {
    input.signal.throwIfAborted()
    const rubric = suite.samples.find(sample => sample.sampleHash === evolutionContentHash(input.sample))
    if (!rubric) throw evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '样本不在冻结验收集合中')
    const pagesFiles = input.rendered.files.filter(file => file.path.endsWith('/pages.json'))
    let metadata: unknown = null
    if (pagesFiles.length === 1 && pagesFiles[0].content.length <= 8 * 1024 * 1024) {
      try { metadata = JSON.parse(pagesFiles[0].content.toString('utf8')) } catch { /* Invalid extraction is failed evidence, not an accepted empty report. */ }
    }
    const parsed = pagesSchema.safeParse(metadata)
    const pages = parsed && parsed.success ? parsed.data : []
    const validPages = pages.length > 0 && pages.every((page, index) => page.page === index + 1)
    // Search the actual PDF extraction, not model JSON or audit logs, and never match across separate pages.
    const results = rubric.rules.map(rule => ({ ...rule, passed: validPages
      && (pages.some(page => page.text.includes(rule.text)) === (rule.expectation === 'present')) }))
    const checks = gates.map(id => ({ id, verdict: results.filter(rule => rule.gate === id).every(rule => rule.passed) ? 'PASS' as const : 'FAIL' as const,
      evidence: JSON.stringify({ rubricHash: profileHash, rules: results.filter(rule => rule.gate === id).map(({ id, passed }) => ({ id, passed })) }) }))
    const images = pages.map(page => {
      const matches = input.rendered.files.filter(file => file.path.endsWith(`/page-${String(page.page).padStart(3, '0')}.png`))
      return matches.length === 1 ? { page: page.page, sha256: matches[0].sha256, content: Buffer.from(matches[0].content) } : null
    })
    let visual: z.infer<typeof visualSchema> = { verdict: 'BLOCKED', evidence: '缺少完整页面证据，无法独立审阅', reviewedPages: [] }
    if (validPages && images.every(image => image !== null)) {
      input.signal.throwIfAborted()
      visual = visualSchema.parse(await reviewPages({ pages: images.filter(image => image !== null), signal: input.signal, budget: input.budget }))
      input.signal.throwIfAborted()
      if (visual.reviewedPages.length !== images.length || images.some(image =>
        visual.reviewedPages.filter(reviewed => reviewed.page === image!.page && reviewed.sha256 === image!.sha256).length !== 1)) {
        visual = { verdict: 'BLOCKED', evidence: '独立审阅未覆盖当前报告全部页面', reviewedPages: visual.reviewedPages }
      }
    }
    return { score: results.reduce((sum, rule) => sum + (rule.passed ? rule.weight : 0), 0)
      / results.reduce((sum, rule) => sum + rule.weight, 0) * 100,
      checks: [...checks, { id: 'render', verdict: visual.verdict, evidence: JSON.stringify({ rubricHash: profileHash, ...visual }) }] }
  } }
}
