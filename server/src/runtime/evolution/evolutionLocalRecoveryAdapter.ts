import path from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { captureEvolutionRuntimeIdentity, type EvolutionRuntimeIdentity } from '../../services/aiEvolutionRuntimeIdentity.js'
import { waitForEvolutionReleaseHealth } from './evolutionReleaseHealth.js'
import type { EvolutionRecoveryAdapter } from './evolutionReleaseRecovery.js'
import type { EvolutionReleaseReceipt } from './evolutionReleaseCoordinator.js'

const same = (left: EvolutionRuntimeIdentity | null, right: EvolutionRuntimeIdentity | null) => Boolean(left && right
  && (['schemaVersion', 'baseCommit', 'patchHash', 'lockHash', 'serverEntrySha256', 'webEntrySha256'] as const).every(key => left[key] === right[key]))

/** Commands are supplied by an independent trusted host; no shell text comes from candidates. */
export async function createLocalEvolutionRecoveryAdapter(input: {
  root: string; receipt: EvolutionReleaseReceipt;
  healthUrl: string; fetchImpl?: typeof fetch;
  stop: (signal: AbortSignal) => Promise<void>;
  rollbackBuild: (signal: AbortSignal) => Promise<void>;
  start: (signal: AbortSignal) => Promise<void>;
  healthTimeoutMs?: number; healthIntervalMs?: number;
}): Promise<EvolutionRecoveryAdapter> {
  const root = await realpath(input.root)
  const check = (receipt: EvolutionReleaseReceipt, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (receipt.releaseId !== input.receipt.releaseId || receipt.candidateHash !== input.receipt.candidateHash
      || receipt.previousReleaseId !== input.receipt.previousReleaseId) throw Error('Recovery receipt changed')
  }
  const identityAt = async (directory: string) => {
    // Refuse directory redirection outside the registered target.
    for (const name of ['server-dist/index.js', 'server-dist/evolution-build.json', 'dist/index.html']) {
      const resolved = await realpath(path.join(directory, name)).catch(() => '')
      if (!resolved.startsWith(directory + path.sep)) return null
    }
    return captureEvolutionRuntimeIdentity(path.join(directory, 'server-dist/index.js'))
  }
  const inspect: EvolutionRecoveryAdapter['inspect'] = async (receipt, signal) => {
    check(receipt, signal)
    const identity = await identityAt(root)
    check(receipt, signal)
    return same(identity, input.receipt.candidateIdentity) ? 'candidate' : same(identity, input.receipt.previousIdentity) ? 'previous' : 'unknown'
  }
  const verifyRollback = async () => {
    const pointerPath = await realpath(path.join(root, '.runtime/build-rollback.json'))
    if (!pointerPath.startsWith(root + path.sep)) throw Error('Rollback pointer escaped target')
    const bytes = await readFile(pointerPath)
    if (bytes.length > 4096) throw Error('Rollback pointer too large')
    const pointer = JSON.parse(bytes.toString('utf8'))
    if (pointer.version !== 1 || pointer.releaseId !== input.receipt.releaseId
      || pointer.rollbackReleaseId !== input.receipt.releaseId || pointer.hadPrevious !== true
      || !/^build-[0-9]{8}T[0-9]{9}Z-[0-9]+-[a-f0-9]{8}$/.test(pointer.rollbackReleaseId)
      || !input.receipt.previousReleaseId || !input.receipt.previousIdentity) throw Error('Rollback pointer does not match claimed release')
    const directory = path.join(root, '.runtime/build-rollbacks', pointer.rollbackReleaseId)
    if (!same(await identityAt(directory), input.receipt.previousIdentity)) throw Error('Previous build identity does not match backup')
  }
  return {
    inspect,
    health: async (receipt, version, signal) => {
      check(receipt, signal)
      const expected = version === 'candidate' ? input.receipt.candidateIdentity : input.receipt.previousIdentity
      if (!expected || await inspect(receipt, signal) !== version) return false
      return waitForEvolutionReleaseHealth({ url: input.healthUrl, expected, signal, fetchImpl: input.fetchImpl,
        timeoutMs: input.healthTimeoutMs, intervalMs: input.healthIntervalMs,
        stillExpected: async () => await inspect(receipt, signal) === version })
    },
    rollback: async (receipt, signal) => {
      check(receipt, signal)
      if (await inspect(receipt, signal) !== 'candidate') throw Error('Refuse rollback of a different deployment')
      await verifyRollback()
      check(receipt, signal)
      await input.stop(signal)
      check(receipt, signal)
      await verifyRollback()
      if (await inspect(receipt, signal) !== 'candidate') throw Error('Deployment changed before rollback')
      await input.rollbackBuild(signal)
      check(receipt, signal)
      if (await inspect(receipt, signal) !== 'previous') throw Error('Rollback did not restore the expected files')
      await input.start(signal)
    },
  }
}
