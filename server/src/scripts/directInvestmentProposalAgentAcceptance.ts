import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getAiSkillDirectory, loadAiSkill } from '../services/aiSkillService.js'
import { runDirectInvestmentProposalAgent } from '../services/aiDirectInvestmentProposalAgentService.js'

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'direct-proposal-agent-'))

try {
  const skill = await loadAiSkill('draft-investment-proposal')
  let observedOptions: Record<string, unknown> | null = null
  const result = await runDirectInvestmentProposalAgent({
    taskDirectory: temporaryRoot,
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
        sourceType: 'project_file',
        sourceId: 'file-2',
        sourceName: '专项审计.docx',
        chunkIndex: 0,
        versionOrDate: '2026-08-21',
        content: '第二份资料的完整内容。',
      },
    ],
    requiredProjectFiles: [
      { sourceId: 'file-1', sourceName: '商业计划书.pdf' },
      { sourceId: 'file-2', sourceName: '专项审计.docx' },
    ],
    skill,
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
    queryFactory: ({ options }) => {
      observedOptions = options
      return (async function* () {
        const workspace = String(options.cwd)
        const outputPath = path.join(workspace, 'output', '验收科技_投资提案.docx')
        await copyFile(
          path.join(getAiSkillDirectory('draft-investment-proposal'), 'assets', 'primary-layout-authority.docx'),
          outputPath,
        )
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Skill', input: { skill: 'draft-investment-proposal' } },
              { type: 'tool_use', name: 'Read', input: { file_path: './materials/manifest.json' } },
              { type: 'tool_use', name: 'Write', input: { file_path: './output/验收科技_投资提案.docx' } },
            ],
          },
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: '验收生成完成',
          num_turns: 3,
          total_cost_usd: 0.1,
          usage: { input_tokens: 100, output_tokens: 50 },
        }
      })()
    },
  })

  assert.ok(observedOptions)
  const options = observedOptions as Record<string, unknown>
  assert.deepEqual(options.skills, ['draft-investment-proposal'])
  assert.deepEqual(options.settingSources, ['project'])
  assert.equal((options.sandbox as { enabled?: boolean }).enabled, true)
  assert.equal((options.sandbox as { failIfUnavailable?: boolean }).failIfUnavailable, true)
  assert.ok((options.tools as string[]).includes('Skill'))
  assert.ok((options.tools as string[]).includes('Read'))
  assert.ok((options.tools as string[]).includes('Write'))
  assert.ok((options.tools as string[]).includes('Bash'))

  const workspace = path.join(temporaryRoot, '.direct-skill-agent')
  const manifest = JSON.parse(await readFile(path.join(workspace, 'materials', 'manifest.json'), 'utf8'))
  assert.equal(manifest.documentCount, 2)
  assert.equal(manifest.chunkCount, 3)
  assert.ok((await readFile(path.join(workspace, 'materials', manifest.sources[0].fileName), 'utf8'))
    .includes('第一份资料的第二段完整内容。'))
  assert.ok((await stat(path.join(workspace, '.claude', 'skills', 'draft-investment-proposal', 'SKILL.md'))).isFile())

  assert.equal(result.skillInvoked, true)
  assert.equal(result.projectKnowledgeStudy.completeProjectFileCoverage, true)
  assert.equal(result.projectKnowledgeStudy.completeSourceChunkCoverage, true)
  assert.equal(result.projectKnowledgeStudy.includedChunkCount, 3)
  assert.equal(result.projectKnowledgeStudy.hostContentOrchestration, false)
  assert.equal(result.projectKnowledgeStudy.hostEvidenceFallback, false)
  assert.ok(Array.from('Skill公开核验').length <= 16)
  assert.ok(Array.from('Skill完整研读').length <= 16)
  assert.ok((await stat(result.outputPath)).size > 1_000)
  console.log('direct investment proposal Skill Agent acceptance passed')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
