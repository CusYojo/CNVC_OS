import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { writeAcceptancePdf } from './helpers/acceptancePdf.js'
import path from 'node:path'
import { getAiSkillDirectory, getAiSkillRoot, loadAiSkill } from '../services/aiSkillService.js'
import { captureEvolutionSkill } from '../runtime/evolution/evolutionSkillSnapshot.js'
import { evolutionContentHash } from '../services/aiEvolutionPolicyService.js'
import {
  runDirectBusinessDocumentAgent,
  type DirectBusinessDocumentTaskType,
} from '../services/aiDirectInvestmentProposalAgentService.js'

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'direct-qa-dd-agent-'))
const cases: Array<{
  taskType: DirectBusinessDocumentTaskType
  skillName: string
  outputFileName: string
}> = [
  {
    taskType: 'investment_proposal',
    skillName: 'draft-investment-proposal',
    outputFileName: '验收科技_投资提案.docx',
  },
  {
    taskType: 'project_qa',
    skillName: 'draft-investment-qa',
    outputFileName: '验收科技_项目Q&A报告.docx',
  },
  {
    taskType: 'due_diligence_report',
    skillName: 'draft-due-diligence-report',
    outputFileName: '验收科技_尽职调查报告.docx',
  },
]

try {
  for (const acceptanceCase of cases.flatMap(item => [{ ...item, evolved: false }, { ...item, evolved: true }])) {
    const skill = await loadAiSkill(acceptanceCase.skillName)
    const snapshot = await captureEvolutionSkill({ capabilityId: '00000000-0000-4000-8000-000000000001',
      capabilityKey: skill.name, directory: getAiSkillDirectory(skill.name), allowedRoot: getAiSkillRoot(), toolNames: [], dependencyNames: [], config: {} })
    const version = { ...snapshot.version, instructions: snapshot.version.instructions + '\n冻结进化版本验收标记。' }
    const contentHash = evolutionContentHash(version)
    const evolutionSkillPackage = { schemaVersion: 1, version, contentHash,
      packageHash: evolutionContentHash({ contentHash, runtimePackageHash: snapshot.packageHash }), runtimeSnapshot: snapshot }
    const taskDirectory = path.join(temporaryRoot, `${acceptanceCase.taskType}-${acceptanceCase.evolved ? 'evolved' : 'baseline'}`)
    if (acceptanceCase.evolved) {
      const other = cases.find(item => item.taskType !== acceptanceCase.taskType)!
      const sentinel = path.join(taskDirectory, '.direct-skill-agent', 'preserve.txt')
      await mkdir(path.dirname(sentinel), { recursive: true })
      await writeFile(sentinel, 'existing work')
      await assert.rejects(runDirectBusinessDocumentAgent({ taskType: other.taskType, taskDirectory,
        project: { id: 'project-1', name: '验收项目', companyName: '验收科技', industry: '企业服务' },
        sources: [], requiredProjectFiles: [], skill: await loadAiSkill(other.skillName), evolutionSkillPackage,
        sourceCutoffDate: '2026-08-21', instructions: '', userRole: 'admin' }), { code: 'DIRECT_SKILL_TASK_MISMATCH' })
      assert.equal(await readFile(sentinel, 'utf8'), 'existing work')
    }
    let observedPrompt = ''
    let observedOptions: Record<string, unknown> | null = null
    const result = await runDirectBusinessDocumentAgent({
      taskType: acceptanceCase.taskType,
      taskDirectory,
      project: {
        id: 'project-1',
        name: '验收项目',
        companyName: '验收科技',
        industry: '企业服务',
      },
      sources: [
        {
          sourceType: 'project_file',
          sourceId: 'file-1',
          sourceName: '商业计划书.pdf',
          chunkIndex: 0,
          versionOrDate: '2026-08-21',
          content: '第一份资料的第一段完整内容。',
        },
        {
          sourceType: 'project_file',
          sourceId: 'file-1',
          sourceName: '商业计划书.pdf',
          chunkIndex: 1,
          versionOrDate: '2026-08-21',
          content: '第一份资料的第二段完整内容。',
        },
        {
          sourceType: 'user_input',
          sourceName: '本次会话与用户补充输入',
          chunkIndex: 0,
          versionOrDate: '2026-08-21',
          content: '本轮会话要求必须使用全部资料。',
        },
      ],
      requiredProjectFiles: [
        { sourceId: 'file-1', sourceName: '商业计划书.pdf' },
      ],
      skill,
      evolutionSkillPackage: acceptanceCase.evolved ? evolutionSkillPackage : undefined,
      sourceCutoffDate: '2026-08-21',
      instructions: '必须直接执行 Skill 并读取全部资料。',
      userRole: 'admin',
    }, {
      runtimeConfig: {
        baseUrl: 'https://model.example.com',
        apiKey: 'acceptance-only',
        model: 'acceptance-model',
        maxTurns: 20,
        maxBudgetUsd: 2,
        timeoutMs: 300_000,
      },
      queryFactory: ({ prompt, options }) => {
        observedPrompt = prompt
        observedOptions = options
        return (async function* () {
          const workspace = String(options.cwd)
          assert.equal((await readFile(path.join(workspace, '.claude', 'skills', skill.name, 'SKILL.md'), 'utf8')).endsWith('冻结进化版本验收标记。'), acceptanceCase.evolved)
          await copyFile(
            path.join(
              getAiSkillDirectory('draft-due-diligence-report'),
              'assets',
              'reference.docx',
            ),
            path.join(workspace, 'output', acceptanceCase.outputFileName),
          )
          if (acceptanceCase.taskType === 'due_diligence_report') {
            await writeAcceptancePdf(path.join(workspace, 'output', acceptanceCase.outputFileName.replace(/\.docx$/, '.pdf')))
          }
          yield {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', name: 'Skill', input: { skill: acceptanceCase.skillName } },
                { type: 'tool_use', name: 'Read', input: { file_path: './materials/manifest.json' } },
                { type: 'tool_use', name: 'Bash', input: { command: '执行 Skill 自带校验与渲染' } },
              ],
            },
          }
          yield {
            type: 'result',
            subtype: 'success',
            result: `${acceptanceCase.skillName} 验收生成完成`,
            num_turns: 3,
            total_cost_usd: 0.1,
            usage: { input_tokens: 100, output_tokens: 50 },
          }
        })()
      },
    })

    assert.ok(observedOptions)
    const options = observedOptions as Record<string, unknown>
    assert.deepEqual(options.skills, [acceptanceCase.skillName])
    assert.ok((options.tools as string[]).includes('Skill'))
    assert.ok((options.tools as string[]).includes('Read'))
    assert.ok((options.tools as string[]).includes('Bash'))
    assert.equal((options.sandbox as { enabled?: boolean }).enabled, true)
    assert.equal(
      (options.sandbox as { failIfUnavailable?: boolean }).failIfUnavailable,
      process.platform !== 'win32',
    )
    assert.match(observedPrompt, new RegExp(`Skill 工具执行 ${acceptanceCase.skillName}`))
    assert.match(observedPrompt, /全部来源文件和全部片段/)
    assert.match(observedPrompt, /宿主不会生成问题、答案、章节、底稿或兜底正文/)

    const workspace = path.join(taskDirectory, '.direct-skill-agent')
    const manifest = JSON.parse(await readFile(path.join(workspace, 'materials', 'manifest.json'), 'utf8'))
    assert.equal(manifest.documentCount, 2)
    assert.equal(manifest.chunkCount, 3)
    assert.ok((await readFile(path.join(workspace, 'materials', manifest.sources[0].fileName), 'utf8'))
      .includes('第一份资料的第二段完整内容。'))
    assert.ok((await stat(path.join(
      workspace,
      '.claude',
      'skills',
      acceptanceCase.skillName,
      'SKILL.md',
    ))).isFile())
    assert.equal(result.skillInvoked, true)
    assert.equal(result.projectKnowledgeStudy.completeProjectFileCoverage, true)
    assert.equal(result.projectKnowledgeStudy.completeSourceChunkCoverage, true)
    assert.equal(result.projectKnowledgeStudy.includedChunkCount, 3)
    assert.equal(result.projectKnowledgeStudy.hostContentOrchestration, false)
    assert.equal(result.projectKnowledgeStudy.hostEvidenceFallback, false)
    assert.equal(path.basename(result.outputPath), acceptanceCase.outputFileName)
    assert.ok((await stat(result.outputPath)).size > 1_000)
  }
  console.log('direct Q&A and due-diligence Skill Agent acceptance passed')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
