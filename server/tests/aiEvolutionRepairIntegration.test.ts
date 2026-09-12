import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import { createEvolutionCodeExecutor } from '../src/runtime/evolution/evolutionCodeExecutor.js'
import { EvolutionRunCoordinator } from '../src/runtime/evolution/evolutionRunCoordinator.js'
import { createEvolutionCodeEvaluator } from '../src/runtime/evolution/evolutionCodeEvaluator.js'
import { runEvolutionLeadPageGate } from '../src/runtime/evolution/evolutionLeadPageScenario.js'
import { DockerEvolutionEnvironment } from '../src/runtime/evolution/dockerEvolutionEnvironment.js'
import { AiEvolutionArtifactStore } from '../src/services/aiEvolutionArtifactStore.js'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'
test('real code repair uses failed page feedback and persists a verified candidate', { skip: process.env.EVOLUTION_REPAIR_INTEGRATION_TEST !== 'true' }, async () => {
assert.equal(process.env.DB_DATABASE,'evolution_isolated_test');assert.equal(process.env.DB_HOST,'127.0.0.1');assert.equal(process.env.DB_PORT,'43318');assert.equal(process.env.DB_FREFIX,'evo_test_')
const {pool}=await import('../src/db/client.js')
const {MySqlAiEvolutionRepository}=await import('../src/repositories/mysql/mysqlAiEvolutionRepository.js')
const {MySqlAiEvolutionCandidateRepository}=await import('../src/repositories/mysql/mysqlAiEvolutionCandidateRepository.js')
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.EVOLUTION_BROWSER_MODULE!)
const browser=await chromium.launch({channel:process.env.EVOLUTION_BROWSER_CHANNEL || 'msedge',headless:true})
const root=await mkdtemp(path.join(os.tmpdir(),'evolution-full-run-')),store=new AiEvolutionArtifactStore(root)
const image=process.env.EVOLUTION_BUILD_IMAGE!
assert.match(image,/^sha256:[a-f0-9]{64}$/)
const environment=new DockerEvolutionEnvironment(undefined,image),runs=new MySqlAiEvolutionRepository(),candidates=new MySqlAiEvolutionCandidateRepository()
const userId=randomUUID(),repositoryId=randomUUID(),baseCommit=execFileSync('git',['rev-parse','--verify','--end-of-options',process.env.EVOLUTION_REPAIR_BASE_COMMIT || 'HEAD'],{encoding:'utf8'}).trim()
const spec:EvolutionSpec={schemaVersion:1,kind:'code',title:'隔离全链路验收：窄屏导航',objective:'窄屏收起导航，让线索详情页没有横向溢出',scope:{type:'user',key:userId},sourceRefs:[{type:'message',id:'synthetic-integration-message'}],questions:[],acceptanceCriteria:['桌面与移动线索页面通过固定验收'],budget:{maxDurationSeconds:600,maxModelTokens:100000,maxRepairRounds:1},target:{type:'code',repositoryId,baseCommit,allowedPaths:['src/layout/AppLayout.tsx'],databaseChange:false,permissionChange:false}}
const proposal=await runs.createProposal(userId,spec,randomUUID()),queued=await runs.enqueue(userId,proposal.id,proposal.revision,proposal.specHash,randomUUID())
let identity: any
try {
 const evaluate=createEvolutionCodeEvaluator({environment,environmentId:image,store,scriptsRoot:path.resolve('server/scripts'),suiteVersion:'full-integration-v1',functionalGate:{file:'leadPresentation.test.ts',minimumTests:6},
  pageGate:({files,control})=>runEvolutionLeadPageGate({browser,files,control,store})})
 const executor=createEvolutionCodeExecutor({runs,candidates,artifacts:store,modelId:'deterministic-test-developer',executionProfileHash:'f'.repeat(64),evaluate,
  authorize:async run=>{assert.equal(run.id,queued.id);return{id:repositoryId,root:process.cwd(),readablePaths:['src','server/src','public','index.html','package.json','package-lock.json','tsconfig.json','tsconfig.app.json','tsconfig.node.json','server/tsconfig.json','server/tsconfig.build.json','tailwind.config.js','postcss.config.js'],editablePaths:['src/layout/AppLayout.tsx'],protectedPaths:['server/src']}},
  develop:async({files,feedback})=>{
   assert.equal(files.length,1)
   const file=files[0],before=Buffer.from(file.contentBase64,'base64').toString()
   let after:string
   if (!feedback) after=before.replace('className="fde-page-content" tabIndex={-1}', 'className="fde-page-content" style={{ display: "none" }} tabIndex={-1}')
   else {
    assert.equal(feedback.verdict,'FAIL')
    assert.ok(feedback.checks.some(check=>check.id==='page'&&check.verdict==='FAIL'))
    after=before.replace('style={{ display: "none" }}', 'style={narrow && location.pathname.startsWith("/sourcing/") ? { paddingInline: 24 } : undefined}')
   }
   assert.notEqual(after,before)
   return{totalTokens:123,text:JSON.stringify({summary:'固定测试响应：窄屏导航收起',changes:[{path:file.path,expectedSha256:file.sha256,contentBase64:Buffer.from(after).toString('base64')}]})}
  }})
 const coordinator=new EvolutionRunCoordinator(runs,'full-integration-worker',async(run,control)=>{identity=control.identity;console.log(`RUN_STARTED ${run.id}`);return executor(run,control)},lease=>environment.terminate(lease))
 await coordinator.tick()
 const run=(await runs.findRun(userId,queued.id))!
 console.log('RUN_RESULT',JSON.stringify({status:run.status,error:run.error,checkpoint:run.checkpoint}))
 assert.equal(run.status,'succeeded');assert.equal(run.repairRounds,1);assert.equal(run.modelTokens,246)
 const candidateId=await candidates.latestIdForProposal(userId,proposal.id)
 assert.ok(candidateId)
 const candidate=(await candidates.findForOwner(userId,candidateId))!
 assert.equal(candidate.candidate.status,'awaiting_approval')
 await store.verifyManifest(run.id,candidate.candidate.manifest)
 console.log(`FULL_CODE_RUN_PASS candidate=${candidateId} artifacts=${root} run=${run.id}`)
} finally {if(identity)await environment.terminate(identity);await browser.close();await pool.end()}


})
