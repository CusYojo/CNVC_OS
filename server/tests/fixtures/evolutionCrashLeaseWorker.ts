import { randomUUID } from 'node:crypto'
import { DockerEvolutionEnvironment } from '../../src/runtime/evolution/dockerEvolutionEnvironment.js'
import type { EvolutionSpec } from '../../src/contracts/aiEvolutionContract.js'

const { MySqlAiEvolutionRepository } = await import('../../src/repositories/mysql/mysqlAiEvolutionRepository.js')
const runs = new MySqlAiEvolutionRepository()
const userId = randomUUID()
const repositoryId = randomUUID()
const spec: EvolutionSpec = {
  schemaVersion: 1,
  kind: 'code',
  title: '宿主进程中断恢复验收',
  objective: '验证租约过期后的容器回收与任务中断确认',
  scope: { type: 'user', key: userId },
  sourceRefs: [{ type: 'message', id: 'restart-recovery-integration' }],
  questions: [],
  acceptanceCriteria: ['旧执行环境被新宿主回收'],
  budget: { maxDurationSeconds: 120, maxModelTokens: 1000, maxRepairRounds: 0 },
  target: { type: 'code', repositoryId, baseCommit: 'a'.repeat(40), allowedPaths: ['src/recovery.ts'], databaseChange: false, permissionChange: false },
}
const proposal = await runs.createProposal(userId, spec, randomUUID())
const queued = await runs.enqueue(userId, proposal.id, proposal.revision, proposal.specHash, randomUUID())
const claimed = await runs.claimNext(`crash-worker-${process.pid}`, 10, new Date(), 'code')
if (!claimed || claimed.id !== queued.id) throw new Error('Failed to claim the isolated recovery run')
const identity = { runId: claimed.id, attempt: claimed.attempt, leaseToken: claimed.leaseToken, inputHash: claimed.inputHash }
const image = process.env.EVOLUTION_BUILD_IMAGE
if (!image) throw new Error('EVOLUTION_BUILD_IMAGE is required')
const environment = new DockerEvolutionEnvironment(undefined, image)
await environment.create(identity)
process.stdout.write(`CRASH_WORKER_READY ${JSON.stringify({ userId, proposalId: proposal.id, identity })}\n`)
setInterval(() => {}, 60_000)
