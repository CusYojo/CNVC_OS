import { evolutionError } from '../../services/aiEvolutionPolicyService.js'
import type { EvolutionRuntimeIdentity } from '../../services/aiEvolutionRuntimeIdentity.js'
import { z } from 'zod'

export type EvolutionReleaseReceipt = {
  releaseId: string; candidateHash: string; previousReleaseId: string | null;
  candidateIdentity: EvolutionRuntimeIdentity; previousIdentity: EvolutionRuntimeIdentity | null;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identitySchema = z.object({ schemaVersion: z.literal(1), baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  patchHash: hash, lockHash: hash, serverEntrySha256: hash, webEntrySha256: hash }).strict()
const releaseReceiptSchema = z.object({ releaseId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/), candidateHash: hash,
  previousReleaseId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/).nullable(), candidateIdentity: identitySchema,
  previousIdentity: identitySchema.nullable() }).strict().superRefine((receipt, context) => {
    if (Boolean(receipt.previousReleaseId) !== Boolean(receipt.previousIdentity)) {
      context.addIssue({ code: 'custom', message: 'Previous release identifier and identity must be present together' })
    }
  })
export function parseEvolutionReleaseReceipt(value: unknown): EvolutionReleaseReceipt {
  return releaseReceiptSchema.parse(value)
}
type Outcome = 'active' | 'failed' | 'rolled_back'

/** Host must load an already-claimed receipt and serialize recovery per target. */
export async function recoverEvolutionRelease(input: {
  receipt: EvolutionReleaseReceipt;
  authorize: () => Promise<void>;
  inspect: (receipt: EvolutionReleaseReceipt) => Promise<'candidate' | 'previous' | 'unknown'>;
  health: (receipt: EvolutionReleaseReceipt, version: 'candidate' | 'previous') => Promise<boolean>;
  rollback: (receipt: EvolutionReleaseReceipt) => Promise<void>;
  finish: (receipt: EvolutionReleaseReceipt, outcome: Outcome) => Promise<void>;
}) {
  await input.authorize()
  const receipt = Object.freeze(parseEvolutionReleaseReceipt(input.receipt))
  const uncertain = () => evolutionError(503, 'EVOLUTION_RELEASE_RECOVERY_REQUIRED', '发布恢复尚未确认实际版本及健康状态')
  let state: 'candidate' | 'previous' | 'unknown'
  try { state = await input.inspect(receipt) } catch { throw uncertain() }
  if (state === 'unknown') throw uncertain()
  if (state === 'candidate') {
    if (await input.health(receipt, 'candidate')) {
      // Bookkeeping failed after activation: preserve the healthy running candidate.
      if (await input.inspect(receipt) !== 'candidate') throw uncertain()
      await input.finish(receipt, 'active')
      return { outcome: 'active' as const, receipt }
    }
    if (!receipt.previousReleaseId) throw uncertain()
    await input.authorize()
    try {
      // Observe again immediately before a side effect; never roll back a different deployment.
      if (await input.inspect(receipt) !== 'candidate') throw uncertain()
      await input.rollback(receipt)
      if (await input.inspect(receipt) !== 'previous' || !await input.health(receipt, 'previous')
        || await input.inspect(receipt) !== 'previous') throw uncertain()
    } catch { throw uncertain() }
    await input.finish(receipt, 'rolled_back')
    return { outcome: 'rolled_back' as const, receipt }
  }
  if (!receipt.previousReleaseId || !await input.health(receipt, 'previous')
    || await input.inspect(receipt) !== 'previous') throw uncertain()
  // Previous is healthy, but observation alone cannot tell whether activation ever occurred.
  await input.finish(receipt, 'failed')
  return { outcome: 'failed' as const, receipt }
}

/** Adapter methods verify target state; command exit codes alone are not deployment evidence. */
export async function coordinateEvolutionRelease(input: {
  candidateHash: string;
  authorize: () => Promise<void>;
  prepare: () => Promise<EvolutionReleaseReceipt>;
  claim: (receipt: EvolutionReleaseReceipt) => Promise<void>;
  activate: (receipt: EvolutionReleaseReceipt) => Promise<void>;
  inspect: (receipt: EvolutionReleaseReceipt) => Promise<'candidate' | 'previous' | 'unknown'>;
  health: (receipt: EvolutionReleaseReceipt, version: 'candidate' | 'previous') => Promise<boolean>;
  rollback: (receipt: EvolutionReleaseReceipt) => Promise<void>;
  finish: (receipt: EvolutionReleaseReceipt, outcome: Outcome) => Promise<void>;
}) {
  await input.authorize()
  const receipt = Object.freeze(parseEvolutionReleaseReceipt(await input.prepare()))
  if (receipt.candidateHash !== input.candidateHash || !receipt.releaseId) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布暂存结果与批准候选不一致')
  await input.authorize()
  await input.claim(receipt)
  try {
    await input.authorize()
    await input.activate(receipt)
    if (await input.inspect(receipt) !== 'candidate' || !await input.health(receipt, 'candidate')) throw Error('Candidate activation or health not verified')
  } catch {
    // Activation can throw after switching files. Recover only from an observed target identity.
    let state: 'candidate' | 'previous' | 'unknown' = 'unknown'
    try { state = await input.inspect(receipt) } catch { /* Leave durable activating state for recovery. */ }
    if (state === 'candidate') {
      if (!receipt.previousReleaseId) throw evolutionError(503, 'EVOLUTION_RELEASE_RECOVERY_REQUIRED', '候选未验证健康，且没有可确认的旧版本可回退')
      try {
        await input.rollback(receipt)
        if (await input.inspect(receipt) !== 'previous' || !await input.health(receipt, 'previous')) throw Error('Previous version not verified')
      } catch { throw evolutionError(503, 'EVOLUTION_RELEASE_RECOVERY_REQUIRED', '回退结果尚未确认，需要恢复核对') }
      await input.finish(receipt, 'rolled_back')
      return { outcome: 'rolled_back' as const, receipt }
    }
    if (state === 'previous' && await input.health(receipt, 'previous')) {
      await input.finish(receipt, 'failed')
      return { outcome: 'failed' as const, receipt }
    }
    throw evolutionError(503, 'EVOLUTION_RELEASE_RECOVERY_REQUIRED', '目标运行版本尚未确认，不得标记发布或回退完成')
  }
  // A database failure here does not justify rolling back a verified healthy deployment.
  // Keep activating for reconciliation, rather than mixing bookkeeping errors with activation errors.
  await input.finish(receipt, 'active')
  return { outcome: 'active' as const, receipt }
}
