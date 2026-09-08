import { evolutionError } from './aiEvolutionPolicyService.js'
import type { EvolutionKind } from '../contracts/aiEvolutionContract.js'

/** Registration is performed by the host bootstrap after constructing the durable worker. */
export class AiEvolutionExecutorRegistry {
  private readonly workers = new Map<EvolutionKind, { available(): Promise<boolean> }>()
  register(worker: { available(): Promise<boolean> }, kind: EvolutionKind = 'code') {
    if (this.workers.has(kind)) throw Error('Evolution executor already registered')
    this.workers.set(kind, worker)
    return () => { if (this.workers.get(kind) === worker) this.workers.delete(kind) }
  }
  async available(kind: EvolutionKind = 'code') {
    const worker = this.workers.get(kind)
    return Boolean(worker && await worker.available() && this.workers.get(kind) === worker)
  }
  async assertReady(kind: EvolutionKind = 'code') {
    if (!await this.available(kind)) throw evolutionError(503, 'EVOLUTION_EXECUTOR_NOT_READY', '该类型的进化执行器尚未就绪，提案已保留')
  }
}
export const aiEvolutionExecutorRegistry = new AiEvolutionExecutorRegistry()
