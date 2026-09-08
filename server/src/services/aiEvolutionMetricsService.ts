import { z } from 'zod'

type ApplicationObservation = { snapshot: unknown; checkStatus: string }
type CandidateObservation = { report: unknown }
type Metric = { key: string; label: string; numerator: number | null; denominator: number | null; value: number | null;
  sampleSize: number; notEvaluated: number; unavailableReason?: string }

const querySchema = z.object({ windowDays: z.coerce.number().int().min(1).max(90).default(30) })
const ratio = (key: string, label: string, numerator: number, denominator: number, sampleSize: number, notEvaluated = 0): Metric => ({
  key, label, numerator, denominator, value: denominator ? numerator / denominator : null, sampleSize, notEvaluated,
  ...(denominator ? {} : { unavailableReason: '观察期内没有可作为分母的记录' }),
})
const unavailable = (key: string, label: string, reason: string): Metric => ({ key, label, numerator: null, denominator: null,
  value: null, sampleSize: 0, notEvaluated: 0, unavailableReason: reason })

function snapshotFacts(value: unknown) {
  if (!value || typeof value !== 'object') return { eligible: false, loaded: false }
  const row = value as { loaded?: unknown[]; excluded?: Array<{ reason?: string }> }
  const loaded = Array.isArray(row.loaded) && row.loaded.length > 0
  const budgetMatched = Array.isArray(row.excluded) && row.excluded.some(item => item?.reason === 'prompt_budget')
  return { eligible: loaded || budgetMatched, loaded }
}

export function calculateAiEvolutionMetrics(input: { applications: ApplicationObservation[]; candidates: CandidateObservation[] }) {
  const applicationFacts = input.applications.map(row => ({ ...snapshotFacts(row.snapshot), checkStatus: row.checkStatus }))
  const eligible = applicationFacts.filter(row => row.eligible), loaded = eligible.filter(row => row.loaded)
  const checked = loaded.filter(row => ['PASS', 'FAIL'].includes(row.checkStatus))
  const passedChecks = checked.filter(row => row.checkStatus === 'PASS').length
  const completedEvaluations = input.candidates.filter(row => row.report && typeof row.report === 'object')
  const passedCandidates = completedEvaluations.filter(row => (row.report as { verdict?: string }).verdict === 'PASS').length
  return [
    ratio('application_rate', '应用率', loaded.length, eligible.length, input.applications.length, Math.max(0, eligible.length - loaded.length)),
    ratio('compliance_rate', '遵守率', passedChecks, checked.length, loaded.length, Math.max(0, loaded.length - checked.length)),
    unavailable('repeat_correction_rate', '重复纠正率', '反馈尚未绑定到具体经验版本，不能判断是否为同一规则的重复纠正'),
    ratio('candidate_pass_rate', '候选通过率', passedCandidates, completedEvaluations.length, input.candidates.length,
      Math.max(0, input.candidates.length - completedEvaluations.length)),
    unavailable('production_regression_rate', '生产回归率', '尚未记录回归确认结论与发布观察期完成状态'),
  ]
}

export async function getAiEvolutionMetrics(userId: string, raw: unknown,
  repository?: { observe(ownerUserId: string, since: Date): Promise<{ applicationRows: ApplicationObservation[];
    candidateRows: CandidateObservation[]; truncated: boolean }> }, now = new Date()) {
  const { windowDays } = querySchema.parse(raw)
  const since = new Date(now.getTime() - windowDays * 86_400_000)
  const source = repository ?? new (await import('../repositories/mysql/mysqlAiEvolutionMetricsRepository.js')).MySqlAiEvolutionMetricsRepository()
  const observed = await source.observe(userId, since)
  return { observedFrom: since.toISOString(), observedTo: now.toISOString(), windowDays,
    truncated: observed.truncated, metrics: calculateAiEvolutionMetrics({ applications: observed.applicationRows, candidates: observed.candidateRows }) }
}
