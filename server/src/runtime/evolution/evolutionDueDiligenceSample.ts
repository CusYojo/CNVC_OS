import { z } from 'zod'
import type { createEvolutionDueDiligenceGenerator } from './evolutionDueDiligenceGenerator.js'
import { evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { freezeEvolutionSkillSampleSuite, readEvolutionSkillSampleSuiteFile } from './evolutionSkillSampleSuite.js'

const text = z.string().max(90000)
const indexes = z.array(z.number().int().nonnegative()).max(320)
const status = z.enum(['资料记载', 'AI推断', '待核验', '资料缺口'])
const count = z.number().int().nonnegative()
const strings = z.array(text).max(1000)
const audit = z.object({ blueprintVersion: text, corpusSha256: text,
  evidenceCoverage: z.object({ totalLeafSections: count, coveredLeafSections: count, missingLeafSections: count }).strict(),
  chapterAttempts: z.record(z.string(), count), regeneratedChapters: strings, resumedChapters: strings.optional(),
  checkpointVersion: text.optional(), maxParallelChapters: count.optional(), chapterTimeoutMs: count.optional(),
  chapterMetrics: z.array(z.object({ chapterId: text, chapterTitle: text, generationAttempt: count, requestAttempts: count,
    promptCharacters: count, evidenceItems: count, maxTokens: count, durationMs: z.number().nonnegative(),
    outcome: z.enum(['passed', 'review_failed', 'failed']) }).strict()).max(1000).optional(),
  reviewerPassed: z.boolean(), reviewerIssueCodes: strings, limitedDraft: z.boolean().optional(),
  limitationCount: count.optional(), limitationIssueCodes: strings.optional(),
}).strict()
const schema = z.object({
  project: z.object({ name: text.min(1), companyName: text.nullable().optional(), industry: text.nullable().optional(),
    financing: text.nullable().optional(), valuation: text.nullable().optional(), summary: text.nullable().optional(),
    businessModel: text.nullable().optional(), market: text.nullable().optional(), team: text.nullable().optional() }).strict(),
  content: z.object({ title: text, executiveSummary: text, executiveSummarySourceIndexes: indexes.optional(),
    sections: z.array(z.object({ title: text, summary: text, summarySourceIndexes: indexes.optional(),
      findings: z.array(z.object({ text, status, sourceIndexes: indexes }).strict()).max(1000),
      tables: z.array(z.object({ title: text, unit: text, columns: strings, rows: z.array(strings).max(1000), status, sourceIndexes: indexes }).strict()).max(100).optional(),
    }).strict()).max(100), highlights: strings, risks: strings, missing: strings, generationAudit: audit.optional(),
  }).strict(),
  evidence: z.object({ project: z.object({ name: text.min(1), legal_entity: text.min(1), cutoff_date: text, currency: text.min(1) }).strict(),
    facts: z.array(z.object({ id: text.min(1), source_index: count, statement: text.min(1), entity: text.min(1), period: text,
      unit: text, source: text.min(1), source_type: text.min(1), status: text.min(1), materiality: text,
      conflicts: z.array(z.never()), as_of_date: text, intended_use: text }).strict()).min(1).max(320),
  }).strict(), sourceCutoffDate: text.min(1), diligenceScope: z.unknown(), sectionTitles: strings,
}).strict()

export function parseEvolutionDueDiligenceSample(input: unknown): Parameters<ReturnType<typeof createEvolutionDueDiligenceGenerator>['generate']>[0]['sample'] {
  const value = schema.parse(input)
  if (value.project.name !== value.evidence.project.name || value.sourceCutoffDate !== value.evidence.project.cutoff_date
    || (value.project.companyName || value.project.name) !== value.evidence.project.legal_entity
    || new Set(value.evidence.facts.map(fact => fact.id)).size !== value.evidence.facts.length
    || JSON.stringify(value.content).length > 90000 || JSON.stringify(value.evidence).length > 90000) {
    throw evolutionError(503, 'EVOLUTION_SAMPLE_SUITE_INVALID', '尽调样本主体、证据编号或完整输入范围不一致')
  }
  const sources = new Set(value.evidence.facts.map(fact => fact.source_index))
  const referenced = [...(value.content.executiveSummarySourceIndexes ?? []), ...value.content.sections.flatMap(section => [
    ...(section.summarySourceIndexes ?? []), ...section.findings.flatMap(finding => finding.sourceIndexes),
    ...(section.tables ?? []).flatMap(table => table.sourceIndexes) ])]
  if (referenced.some(index => !sources.has(index))) throw evolutionError(503, 'EVOLUTION_SAMPLE_SUITE_INVALID', '样本正文引用了不存在的证据来源')
  return value
}

export async function loadEvolutionDueDiligenceSampleSuite(filename: string) {
  return freezeEvolutionSkillSampleSuite(await readEvolutionSkillSampleSuiteFile(filename), parseEvolutionDueDiligenceSample)
}
