import { realpath } from 'node:fs/promises'
import { aiEvolutionArtifactStore, aiEvolutionService, getAiEvolutionCandidateForUser } from './aiEvolutionApplicationService.js'
import { aiEvolutionReleaseRegistry } from './aiEvolutionReleaseRegistry.js'
import { evolutionError } from './aiEvolutionPolicyService.js'
import { findEvolutionReleaseIndexArtifact, materializeEvolutionReleaseBundle } from '../runtime/evolution/evolutionReleaseBundle.js'
import { prepareLocalEvolutionRelease } from '../runtime/evolution/evolutionLocalReleasePrepare.js'
import type { EvolutionReleaseJob } from '../repositories/mysql/mysqlAiEvolutionReleaseJobRepository.js'

export async function prepareAiEvolutionReleaseJob(job: EvolutionReleaseJob, control: { signal: AbortSignal; assertHeld: () => Promise<void> }) {
  const initialCandidate = await getAiEvolutionCandidateForUser(job.actorUserId, job.candidateId)
  const initialRun = await aiEvolutionService.authorizeRun(job.actorUserId, initialCandidate.runId)
  if (initialRun.frozenSpec.target.type !== 'code' || initialCandidate.kind !== 'code') {
    throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布任务不再对应代码候选')
  }
  const repositoryId = initialRun.frozenSpec.target.repositoryId
  const initialTarget = await aiEvolutionReleaseRegistry.resolve(job.actorUserId, repositoryId, job.environment)
  const targetRoot = await realpath(initialTarget.root)
  const authorize = async () => {
    if (control.signal.aborted) throw control.signal.reason ?? Error('Release lease lost')
    await control.assertHeld()
    const candidate = await getAiEvolutionCandidateForUser(job.actorUserId, job.candidateId)
    const run = await aiEvolutionService.authorizeRun(job.actorUserId, candidate.runId)
    if (candidate.contentHash !== initialCandidate.contentHash || run.frozenSpec.target.type !== 'code'
      || run.frozenSpec.target.repositoryId !== repositoryId) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '候选或仓库绑定已变化')
    const target = await aiEvolutionReleaseRegistry.resolve(job.actorUserId, repositoryId, job.environment)
    if (await realpath(target.root) !== targetRoot) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布目录绑定已变化')
  }
  await authorize()
  await aiEvolutionArtifactStore.verifyManifest(initialCandidate.runId, initialCandidate.manifest)
  await authorize()
  const indexArtifact = await findEvolutionReleaseIndexArtifact({ runId: initialCandidate.runId, baseRef: initialCandidate.baseRef,
    manifest: initialCandidate.manifest, store: aiEvolutionArtifactStore, authorize })
  const bundle = await materializeEvolutionReleaseBundle({ runId: initialCandidate.runId, baseRef: initialCandidate.baseRef,
    manifest: initialCandidate.manifest, indexArtifact, store: aiEvolutionArtifactStore, authorize })
  try {
    return await prepareLocalEvolutionRelease({ targetRoot, bundleRoot: bundle.root, manifestSha256: bundle.manifestHash,
      candidateHash: initialCandidate.contentHash, authorize })
  } finally { await bundle.dispose() }
}
