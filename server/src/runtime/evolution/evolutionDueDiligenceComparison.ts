import { z } from 'zod'
import { evaluateEvolutionSkill } from './evolutionSkillEvaluation.js'
import type { createEvolutionDueDiligenceGenerator } from './evolutionDueDiligenceGenerator.js'
import type { prepareEvolutionDueDiligenceRenderer } from './evolutionDueDiligenceRenderer.js'
import type { createEvolutionDurableModelBudget } from './evolutionDurableModelBudget.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'

type EvaluationInput = Parameters<typeof evaluateEvolutionSkill>[0]
type Generator = ReturnType<typeof createEvolutionDueDiligenceGenerator>
type Renderer = Awaited<ReturnType<typeof prepareEvolutionDueDiligenceRenderer>>
type Sample = Parameters<Generator['generate']>[0]['sample']
const record = z.record(z.string(), z.unknown())
const envelopeSchema = z.object({ schemaVersion: z.literal(1), sampleHash: z.string(), skillHash: z.string(), profileHash: z.string(),
  blockedReasons: z.array(z.string()), rawPackage: record,
  normalizedPackage: z.object({ reportMode: z.string(), report: record, diligenceData: record }).strict(),
}).strict()

/** The host owns samples and assessment. Development output cannot replace either or override native failures. */
export async function compareEvolutionDueDiligence(input: Pick<EvaluationInput, 'baseline' | 'candidate' | 'control' | 'store' | 'metric' | 'suiteVersion'> & {
  samples: { id: string; input: Sample; materialHashes: string[] }[];
  generator: Generator; renderer: Renderer; budget: ReturnType<typeof createEvolutionDurableModelBudget>;
  modelId: string; modelVersion: string; maxOutputTokens: number;
  assess: (input: { sample: Sample; generated: z.infer<typeof envelopeSchema>; rendered: Awaited<ReturnType<Renderer['render']>>;
    signal: AbortSignal; budget: ReturnType<typeof createEvolutionDurableModelBudget> }) => Promise<Awaited<ReturnType<EvaluationInput['assess']>>>;
}) {
  const samples = structuredClone(input.samples)
  const pending = new Map<string, { sample: Sample; generated: z.infer<typeof envelopeSchema>; rendered: Awaited<ReturnType<Renderer['render']>> }>()
  return evaluateEvolutionSkill({ baseline: input.baseline, candidate: input.candidate, control: input.control,
    store: input.store, metric: input.metric, suiteVersion: input.suiteVersion,
    samples: samples.map(row => ({ id: row.id, input: JSON.stringify(row.input), materialHashes: row.materialHashes })),
    runtime: { modelId: input.modelId, modelVersion: input.modelVersion, promptHash: input.generator.profileHash, rendererVersion: input.renderer.rendererHash },
    run: async ({ skill, sample, signal }) => {
      const frozen = samples.find(row => row.id === sample.id)
      if (!frozen || JSON.stringify(frozen.input) !== sample.input) throw evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '对比样本与冻结输入不一致')
      const generatedOutput = await input.generator.generate({ skill, sample: structuredClone(frozen.input), signal,
        budget: input.budget, maxOutputTokens: input.maxOutputTokens })
      const generated = envelopeSchema.parse(JSON.parse(generatedOutput.content.toString('utf8')))
      if (generated.sampleHash !== evolutionContentHash(frozen.input) || generated.skillHash !== evolutionContentHash(skill)
        || generated.profileHash !== input.generator.profileHash) throw evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '报告生成结果未绑定当前技能和样本')
      await input.control.assertCanContinue()
      const rendered = await input.renderer.render({ ...generated.normalizedPackage, evidence: structuredClone(frozen.input.evidence) })
      if (rendered.rendererHash !== input.renderer.rendererHash) throw evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '报告渲染器版本发生变化')
      const generation = await input.store.put(input.control.identity.runId, generatedOutput.content, 'report')
      const artifacts = []
      for (const file of rendered.files) {
        await input.control.assertCanContinue()
        const artifact = await input.store.put(input.control.identity.runId, file.content, file.path.endsWith('.png') ? 'screenshot' : /\.(docx|pdf)$/.test(file.path) ? 'content' : 'report')
        if (artifact.sha256 !== file.sha256 || artifact.bytes !== file.bytes) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '报告产物与渲染清单不一致')
        artifacts.push({ path: file.path, artifact })
      }
      const descriptor = { schemaVersion: 1, sampleId: sample.id, skillHash: generated.skillHash, generation, artifacts,
        rendererHash: rendered.rendererHash, checks: rendered.checks }
      const key = evolutionContentHash(descriptor)
      pending.set(key, { sample: structuredClone(frozen.input), generated, rendered })
      return { content: Buffer.from(JSON.stringify(descriptor)), contentType: 'application/vnd.sbl.evolution-due-diligence+json', supportingArtifacts: [generation, ...artifacts.map(row => row.artifact)] }
    },
    assess: async ({ output }) => {
      const key = evolutionContentHash(JSON.parse(output.content.toString('utf8')))
      const context = pending.get(key)
      if (!context) throw evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '缺少当前报告的独立评测上下文')
      pending.delete(key)
      // Copy bytes, not structuredClone(Buffer) which produces Uint8Array for the host reviewer.
      const assessment = await input.assess({ sample: structuredClone(context.sample), generated: structuredClone(context.generated),
        signal: input.control.signal, budget: input.budget,
        rendered: { ...context.rendered, checks: structuredClone(context.rendered.checks),
          files: context.rendered.files.map(file => ({ ...file, content: Buffer.from(file.content) })) } })
      const nativePass = (ids: string[]) => ids.every(id => context.rendered.checks.filter(row => row.id === id).length === 1
        && context.rendered.checks.some(row => row.id === id && row.passed && row.exitCode === 0 && !row.executionError))
      const has = (pattern: RegExp) => context.rendered.files.some(file => file.bytes > 0 && pattern.test(file.path))
      const constraints: Record<string, boolean> = { sources: nativePass(['content']) && !context.generated.blockedReasons.length,
        required_fields: nativePass(['fields']) && !context.generated.blockedReasons.length,
        render: nativePass(['runtime', 'build', 'format', 'pdf', 'pages']) && has(/\/report\.docx$/) && has(/\/report\.pdf$/) && has(/\/page-\d+\.png$/),
        regression: nativePass(['narrative']) }
      return { score: assessment.score, checks: assessment.checks.map(check => constraints[check.id] === false
        ? { ...check, verdict: 'FAIL' as const, evidence: '原生审计或实际渲染未通过；详细结果见保存的报告产物' } : check) }
    },
  })
}
