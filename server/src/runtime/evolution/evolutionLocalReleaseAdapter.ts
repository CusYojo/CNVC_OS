import path from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { captureEvolutionRuntimeIdentity, type EvolutionRuntimeIdentity } from '../../services/aiEvolutionRuntimeIdentity.js'
import { waitForEvolutionReleaseHealth } from './evolutionReleaseHealth.js'
import type { EvolutionReleaseReceipt } from './evolutionReleaseCoordinator.js'

const same = (left: EvolutionRuntimeIdentity | null, right: EvolutionRuntimeIdentity | null) => Boolean(left && right
  && (['schemaVersion', 'baseCommit', 'patchHash', 'lockHash', 'serverEntrySha256', 'webEntrySha256'] as const).every(key => left[key] === right[key]))

/** Deployment lifecycle is supplied by a trusted publisher host, never by an HTTP request or candidate patch. */
export async function createLocalEvolutionReleaseAdapter(input: { root: string; receipt: EvolutionReleaseReceipt; healthUrl: string;
  fetchImpl?: typeof fetch; stop: (signal: AbortSignal) => Promise<void>; activateBuild: (signal: AbortSignal) => Promise<void>;
  rollbackBuild: (signal: AbortSignal) => Promise<void>; start: (signal: AbortSignal) => Promise<void>;
  healthTimeoutMs?: number; healthIntervalMs?: number }) {
  const root = await realpath(input.root)
  const assertReceipt = (receipt: EvolutionReleaseReceipt, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (receipt.releaseId !== input.receipt.releaseId || receipt.candidateHash !== input.receipt.candidateHash) throw Error('Release receipt changed')
  }
  const readIdentity = async (directory: string) => {
    for (const name of ['server-dist/index.js', 'server-dist/evolution-build.json', 'dist/index.html']) {
      const resolved = await realpath(path.join(directory, name)).catch(() => '')
      if (!resolved.startsWith(directory + path.sep)) return null
    }
    return captureEvolutionRuntimeIdentity(path.join(directory, 'server-dist/index.js'))
  }
  const inspect = async (receipt: EvolutionReleaseReceipt, signal: AbortSignal) => {
    assertReceipt(receipt, signal)
    const actual = await readIdentity(root)
    return same(actual, receipt.candidateIdentity) ? 'candidate' as const
      : same(actual, receipt.previousIdentity) ? 'previous' as const : 'unknown' as const
  }
  const verifyCandidatePointer = async () => {
    const pointerPath = await realpath(path.join(root, '.runtime/build-candidate.json'))
    if (!pointerPath.startsWith(root + path.sep)) throw Error('Candidate pointer escaped target')
    const bytes = await readFile(pointerPath)
    if (bytes.length > 4096) throw Error('Candidate pointer too large')
    const pointer = JSON.parse(bytes.toString('utf8'))
    if (pointer.version !== 1 || pointer.releaseId !== input.receipt.releaseId) throw Error('Candidate pointer changed')
    const candidateRoot = await realpath(path.join(root, '.runtime/build-candidates', input.receipt.releaseId))
    if (!candidateRoot.startsWith(root + path.sep) || !same(await readIdentity(candidateRoot), input.receipt.candidateIdentity)) {
      throw Error('Staged candidate identity changed')
    }
  }
  return {
    inspect,
    health: async (receipt: EvolutionReleaseReceipt, version: 'candidate' | 'previous', signal: AbortSignal) => {
      assertReceipt(receipt, signal)
      const expected = version === 'candidate' ? receipt.candidateIdentity : receipt.previousIdentity
      if (!expected || await inspect(receipt, signal) !== version) return false
      return waitForEvolutionReleaseHealth({ url: input.healthUrl, expected, signal, fetchImpl: input.fetchImpl,
        timeoutMs: input.healthTimeoutMs, intervalMs: input.healthIntervalMs,
        stillExpected: async () => await inspect(receipt, signal) === version })
    },
    activate: async (receipt: EvolutionReleaseReceipt, signal: AbortSignal) => {
      assertReceipt(receipt, signal); await verifyCandidatePointer(); await input.stop(signal)
      let activated: 'candidate' | 'previous' | 'unknown' = 'unknown'
      try {
        assertReceipt(receipt, signal); await verifyCandidatePointer(); await input.activateBuild(signal)
        const actual = await readIdentity(root)
        activated = same(actual, receipt.candidateIdentity) ? 'candidate' : same(actual, receipt.previousIdentity) ? 'previous' : 'unknown'
      } finally { await input.start(AbortSignal.timeout(30_000)) }
      if (activated !== 'candidate') throw Error('Activation did not install the approved candidate')
    },
    rollback: async (receipt: EvolutionReleaseReceipt, signal: AbortSignal) => {
      assertReceipt(receipt, signal)
      if (await inspect(receipt, signal) !== 'candidate') throw Error('Refuse rollback of a different deployment')
      await input.stop(signal)
      let restored: 'previous' | 'unknown' = 'unknown'
      try {
        assertReceipt(receipt, signal); await input.rollbackBuild(signal)
        restored = same(await readIdentity(root), receipt.previousIdentity) ? 'previous' : 'unknown'
      } finally { await input.start(AbortSignal.timeout(30_000)) }
      if (restored !== 'previous') throw Error('Rollback did not restore the approved previous version')
    },
  }
}
