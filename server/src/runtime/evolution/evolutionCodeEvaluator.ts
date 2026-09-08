import type { DockerEvolutionEnvironment } from './dockerEvolutionEnvironment.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'
import type { EvolutionSourceSnapshot } from './evolutionSourceSnapshot.js'
import type { EvolutionExecutionControl } from './evolutionRunCoordinator.js'
import type { EvolutionCandidateManifest, EvolutionEvaluationReport } from '../../contracts/aiEvolutionEvaluationContract.js'
import { buildEvolutionInDocker } from './evolutionDockerBuild.js'
import { runEvolutionTestGate } from './evolutionTestGate.js'

type Check = EvolutionEvaluationReport['checks'][number]
type PageEvidence = { verdict: 'PASS' | 'FAIL'; evidence: string; screenshot: Buffer }
export function createEvolutionCodeEvaluator(deps: {
  environment: DockerEvolutionEnvironment; environmentId: string; store: AiEvolutionArtifactStore; scriptsRoot: string; suiteVersion: string
  functionalGate: { file: string; minimumTests: number }
  /** Host-controlled browser scenario using isolated fixture data and no business credentials. */
  pageGate: (input: { files: Awaited<ReturnType<typeof buildEvolutionInDocker>>['files']; control: EvolutionExecutionControl }) => Promise<PageEvidence | PageEvidence[]>
}) {
  return async (snapshot: EvolutionSourceSnapshot, control: EvolutionExecutionControl, patchHash: string) => {
    const checks: Check[] = []
    const artifacts: EvolutionCandidateManifest['artifacts'] = []
    let lockHash = snapshot.files.find((file) => file.path === 'package-lock.json')?.sha256 ?? ''
    let build: Awaited<ReturnType<typeof buildEvolutionInDocker>>
    try {
      build = await buildEvolutionInDocker({ snapshot, control, patchHash, environment: deps.environment, store: deps.store, scriptsRoot: deps.scriptsRoot })
    } catch (error) {
      if ((error as { code?: string }).code !== 'EVOLUTION_BUILD_FAILED') throw error
      const evidence = error instanceof Error ? error.message : '候选构建失败'
      const report: EvolutionEvaluationReport = { suiteVersion: deps.suiteVersion, candidateHash: snapshot.contentHash, verdict: 'FAIL',
        checks: ['types', 'permissions', 'contract', 'functional', 'build', 'page'].map((id) => ({ id, verdict: id === 'build' ? 'FAIL' : 'NOT_RUN', evidence: id === 'build' ? evidence : '构建未通过，未完成此项验收' })) }
      const artifact = await deps.store.put(control.identity.runId, Buffer.from(JSON.stringify(report)), 'report')
      return { evaluation: report, manifest: { schemaVersion: 1 as const, sourceHash: snapshot.contentHash, patchHash,
        dependencyLockHash: lockHash, environment: deps.environmentId, artifacts: [artifact] } }
    }
    lockHash = build.lockHash
    artifacts.push(...build.artifacts, build.log)
    checks.push({ id: 'types', verdict: 'PASS', evidence: `前后端类型检查通过；构建日志 ${build.log.storageKey}` },
      { id: 'build', verdict: 'PASS', evidence: `构建并校验 ${build.files.length} 个文件；索引 ${build.pathIndex.storageKey}` })
    for (const gate of [{ id: 'permissions' as const, file: 'projectDeletionAuthorization.test.ts', minimumTests: 2 },
      { id: 'contract' as const, file: 'leadEnrichmentContract.test.ts', minimumTests: 41 },
      { id: 'functional' as const, ...deps.functionalGate }]) {
      const result = await runEvolutionTestGate({ ...gate, environment: deps.environment, control, timeoutMs: 60000 })
      const log = await deps.store.put(control.identity.runId, Buffer.from(JSON.stringify(result)), 'report')
      artifacts.push(log)
      checks.push({ id: gate.id, verdict: result.verdict, evidence: `执行 ${result.tests ?? 0} 项，通过 ${result.passed ?? 0} 项；日志 ${log.storageKey}` })
    }
    await control.assertCanContinue()
    const pageResult = await deps.pageGate({ files: build.files, control })
    const pages = Array.isArray(pageResult) ? pageResult : [pageResult]
    if (!pages.length) throw Error('页面验收未提供任何场景')
    const pageEvidence: string[] = []
    for (const page of pages) {
      await control.assertCanContinue()
      if (!page.screenshot.length) throw Error('页面验收缺少截图')
      const screenshot = await deps.store.put(control.identity.runId, page.screenshot, 'screenshot')
      artifacts.push(screenshot)
      pageEvidence.push(`${page.evidence}；截图 ${screenshot.storageKey}`)
    }
    checks.push({ id: 'page', verdict: pages.every((page) => page.verdict === 'PASS') ? 'PASS' : 'FAIL', evidence: pageEvidence.join('\n') })
    const evaluation: EvolutionEvaluationReport = { suiteVersion: deps.suiteVersion, candidateHash: snapshot.contentHash,
      verdict: checks.every((check) => check.verdict === 'PASS') ? 'PASS' : 'FAIL', checks }
    artifacts.push(await deps.store.put(control.identity.runId, Buffer.from(JSON.stringify(evaluation)), 'report'))
    return { evaluation, manifest: { schemaVersion: 1 as const, sourceHash: snapshot.contentHash, patchHash,
      dependencyLockHash: lockHash, environment: deps.environmentId,
      artifacts: artifacts.filter((item, index) => artifacts.findIndex((other) => other.storageKey === item.storageKey) === index) } }
  }
}
