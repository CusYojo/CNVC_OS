import { open } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const schema = z.object({ schemaVersion: z.literal(1), suiteId: z.string().min(1).max(100), capabilityId: z.string().uuid(),
  allowedUserIds: z.array(z.string().uuid()).min(1).max(1000),
  samples: z.array(z.object({ id: z.string().min(1).max(100), hidden: z.boolean(),
    input: z.record(z.string(), z.unknown()), inputHash: hash, materialHashes: z.array(hash).min(1).max(1000),
    rules: z.array(z.object({ id: z.string().min(1).max(100), gate: z.enum(['sources', 'required_fields', 'scope', 'regression']),
      text: z.string().min(1).max(4000), expectation: z.enum(['present', 'absent']), weight: z.number().positive().max(100) }).strict()).min(4).max(200),
  }).strict()).min(2).max(100) }).strict()

/** The host supplies a runtime parser for its exact report input contract. Never pass this suite to the developer. */
export function freezeEvolutionSkillSampleSuite<T>(raw: unknown, parseInput: (input: unknown) => T) {
  const suite = schema.parse(structuredClone(raw))
  const invalid = () => evolutionError(503, 'EVOLUTION_SAMPLE_SUITE_INVALID', '固定评测样本配置无效')
  if (new Set(suite.samples.map(sample => sample.id)).size !== suite.samples.length
    || new Set(suite.samples.map(sample => sample.inputHash)).size !== suite.samples.length
    || new Set(suite.allowedUserIds).size !== suite.allowedUserIds.length
    || !suite.samples.some(sample => sample.hidden) || !suite.samples.some(sample => !sample.hidden)) throw invalid()
  const samples = suite.samples.map(sample => {
    const input = parseInput(structuredClone(sample.input))
    // Parsing must not silently strip fields/default material or otherwise change the frozen input.
    if (evolutionContentHash(input) !== sample.inputHash || evolutionContentHash(sample.input) !== sample.inputHash
      || new Set(sample.rules.map(rule => rule.id)).size !== sample.rules.length
      || ['sources', 'required_fields', 'scope', 'regression'].some(gate => !sample.rules.some(rule => rule.gate === gate))) throw invalid()
    return { ...sample, input }
  })
  const profileHash = evolutionContentHash(suite)
  return { profileHash,
    select: (actor: { userId: string; capabilityId: string; sampleIds: string[] }) => {
      if (actor.capabilityId !== suite.capabilityId || !suite.allowedUserIds.includes(actor.userId)) {
        throw evolutionError(403, 'EVOLUTION_SAMPLE_FORBIDDEN', '无权使用该技能评测样本')
      }
      const visible = samples.filter(sample => !sample.hidden)
      if (new Set(actor.sampleIds).size !== actor.sampleIds.length || actor.sampleIds.length !== visible.length
        || visible.some(sample => !actor.sampleIds.includes(sample.id))) {
        throw evolutionError(409, 'EVOLUTION_SAMPLE_SET_CHANGED', '提案样本范围与固定验收集合不一致')
      }
      // Hidden samples always run as well; callers cannot omit the harder subset.
      return { profileHash, suiteId: suite.suiteId,
        samples: structuredClone(samples.map(({ id, input, materialHashes }) => ({ id, input, materialHashes }))),
        assessment: structuredClone({ schemaVersion: 1, version: suite.suiteId,
          samples: samples.map(sample => ({ sampleHash: sample.inputHash, rules: sample.rules })) }) }
    },
  }
}

export async function readEvolutionSkillSampleSuiteFile(filename: string) {
  if (!path.isAbsolute(filename)) throw evolutionError(503, 'EVOLUTION_SAMPLE_SUITE_INVALID', '评测样本配置必须使用宿主绝对路径')
  const handle = await open(filename, 'r')
  try {
    const limit = 16 * 1024 * 1024
    const before = await handle.stat()
    if (!before.isFile() || before.size > limit) throw Error('Invalid sample suite file size')
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await handle.stat()
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('Sample suite changed during read')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } finally { await handle.close() }
}
