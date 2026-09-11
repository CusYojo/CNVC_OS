import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getAiSkillDirectory, loadAiSkill } from '../services/aiSkillService.js'
import { runDirectInvestmentProposalAgent } from '../services/aiDirectInvestmentProposalAgentService.js'
import { classifyDirectSkillAgentFailure } from '../services/aiDirectSkillAgentRecovery.js'
import { writeAcceptancePdf } from './helpers/acceptancePdf.js'

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
        await writeAcceptancePdf(outputPath.replace(/\.docx$/, '.pdf'))
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
  assert.equal((options.sandbox as { enabled?: boolean }).enabled, process.platform !== 'win32')
  assert.equal(
    (options.sandbox as { failIfUnavailable?: boolean }).failIfUnavailable,
    process.platform !== 'win32',
  )
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

  assert.deepEqual(classifyDirectSkillAgentFailure('Failed to authenticate. API Error: 401'), {
    code: 'DIRECT_SKILL_AGENT_AUTHENTICATION_FAILED',
    recoverableGateway403: false,
    recoverableQuota: false,
  })
  assert.deepEqual(classifyDirectSkillAgentFailure('API Error: 403 额度不足'), {
    code: 'DIRECT_SKILL_AGENT_QUOTA_EXHAUSTED',
    recoverableGateway403: false,
    recoverableQuota: true,
  })
  assert.deepEqual(classifyDirectSkillAgentFailure(
    'Failed to authenticate. API Error: 403 令牌$额度不足：需要 0.1099，可用 0.0376',
  ), {
    code: 'DIRECT_SKILL_AGENT_QUOTA_EXHAUSTED',
    recoverableGateway403: false,
    recoverableQuota: true,
  })
  assert.deepEqual(classifyDirectSkillAgentFailure('API Error: 403 gateway policy denied'), {
    code: 'DIRECT_SKILL_AGENT_UPSTREAM_FORBIDDEN',
    recoverableGateway403: true,
    recoverableQuota: false,
  })
  assert.deepEqual(classifyDirectSkillAgentFailure('Request failed with status code 403'), {
    code: 'DIRECT_SKILL_AGENT_UPSTREAM_FORBIDDEN',
    recoverableGateway403: true,
    recoverableQuota: false,
  })
  assert.deepEqual(classifyDirectSkillAgentFailure('403 Forbidden'), {
    code: 'DIRECT_SKILL_AGENT_UPSTREAM_FORBIDDEN',
    recoverableGateway403: true,
    recoverableQuota: false,
  })

  const recoveryTaskDirectory = path.join(temporaryRoot, 'gateway-recovery')
  const recoveryPrompts: string[] = []
  const recoveryStages: string[] = []
  let recoveryQueryCount = 0
  const recovered = await runDirectInvestmentProposalAgent({
    taskDirectory: recoveryTaskDirectory,
    project: { id: 'project-2', name: '恢复项目', companyName: '恢复科技' },
    sources: [{
      sourceType: 'project_file',
      sourceId: 'file-recovery',
      sourceName: '恢复材料.pdf',
      chunkIndex: 0,
      content: '必须在恢复上下文中继续使用的完整材料。',
    }],
    requiredProjectFiles: [{ sourceId: 'file-recovery', sourceName: '恢复材料.pdf' }],
    skill,
    sourceCutoffDate: '2026-08-21',
    instructions: '普通 403 后必须保留工作区继续生成。',
    userRole: 'admin',
    onProgress: ({ stage }) => { recoveryStages.push(stage) },
  }, {
    runtimeConfig: {
      baseUrl: 'https://model.example.com',
      apiKey: 'acceptance-only',
      model: 'acceptance-model',
      maxTurns: 20,
      maxBudgetUsd: 2,
      timeoutMs: 300_000,
    },
    gatewayRecovery: { maxRetries: 1, delayMs: 0, wait: async () => {} },
    queryFactory: ({ prompt, options }) => {
      recoveryQueryCount += 1
      recoveryPrompts.push(prompt)
      const attempt = recoveryQueryCount
      return (async function* () {
        const recoveryWorkspace = String(options.cwd)
        const markerPath = path.join(recoveryWorkspace, '.work', 'resume-marker.json')
        if (attempt === 1) {
          await mkdir(path.dirname(markerPath), { recursive: true })
          await writeFile(markerPath, JSON.stringify({ preserved: true }))
          yield {
            type: 'assistant',
            message: { content: [
              { type: 'tool_use', name: 'Skill', input: { skill: 'draft-investment-proposal' } },
              { type: 'tool_use', name: 'Bash', input: { command: '生成候选稿并复核' } },
            ] },
          }
          throw new Error('API Error: 403 gateway policy denied')
        }
        assert.ok((await stat(markerPath)).isFile())
        await copyFile(
          path.join(getAiSkillDirectory('draft-investment-proposal'), 'assets', 'primary-layout-authority.docx'),
          path.join(recoveryWorkspace, 'output', '恢复科技_投资提案.docx'),
        )
        await writeAcceptancePdf(path.join(recoveryWorkspace, 'output', '恢复科技_投资提案.pdf'))
        yield {
          type: 'assistant',
          message: { content: [
            { type: 'tool_use', name: 'Skill', input: { skill: 'draft-investment-proposal' } },
            { type: 'tool_use', name: 'Read', input: { file_path: './materials/manifest.json' } },
            { type: 'tool_use', name: 'Bash', input: { command: '继续最终复核' } },
          ] },
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: '全新上下文已按同一 Skill 完成恢复与复核',
          num_turns: 2,
          total_cost_usd: 0.1,
          usage: { input_tokens: 20, output_tokens: 10 },
        }
      })()
    },
  })
  assert.equal(recoveryQueryCount, 2)
  assert.match(recoveryPrompts[0], /全部来源文件和全部片段/)
  assert.match(recoveryPrompts[1], /首先重新使用 Skill 工具调用 draft-investment-proposal/)
  assert.match(recoveryPrompts[1], /若现有证据台账不能证明某个来源或片段已经纳入，必须补读缺失资料/)
  assert.ok(recoveryStages.some((stage) => stage.includes('模型网关暂时拒绝')))
  assert.ok((await stat(recovered.outputPath)).size > 1_000)
  assert.ok((await readFile(path.join(
    recoveryTaskDirectory,
    '.direct-skill-agent',
    'materials',
    '001-恢复材料.pdf.md',
  ), 'utf8')).includes('必须在恢复上下文中继续使用的完整材料。'))

  const taskLevelResumeDirectory = path.join(temporaryRoot, 'task-level-resume')
  const taskLevelWorkspace = path.join(taskLevelResumeDirectory, '.direct-skill-agent')
  const taskLevelMarker = path.join(taskLevelWorkspace, '.work', 'preserved-review.json')
  await mkdir(path.dirname(taskLevelMarker), { recursive: true })
  await writeFile(taskLevelMarker, JSON.stringify({ reviewerCompleted: true }))
  let taskLevelPrompt = ''
  const taskLevelRecovered = await runDirectInvestmentProposalAgent({
    taskDirectory: taskLevelResumeDirectory,
    project: { id: 'project-3', name: '任务级恢复项目', companyName: '任务级恢复科技' },
    sources: [{
      sourceType: 'project_file',
      sourceId: 'file-task-level',
      sourceName: '任务级恢复材料.pdf',
      chunkIndex: 0,
      content: '任务级自动恢复仍须保留的完整材料。',
    }],
    requiredProjectFiles: [{ sourceId: 'file-task-level', sourceName: '任务级恢复材料.pdf' }],
    skill,
    sourceCutoffDate: '2026-08-21',
    instructions: '任务级自动恢复必须保留工作区。',
    userRole: 'admin',
    resumeExistingWorkspace: true,
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
      taskLevelPrompt = prompt
      return (async function* () {
        assert.ok((await stat(taskLevelMarker)).isFile())
        await copyFile(
          path.join(getAiSkillDirectory('draft-investment-proposal'), 'assets', 'primary-layout-authority.docx'),
          path.join(String(options.cwd), 'output', '任务级恢复科技_投资提案.docx'),
        )
        await writeAcceptancePdf(path.join(String(options.cwd), 'output', '任务级恢复科技_投资提案.pdf'))
        yield {
          type: 'assistant',
          message: { content: [
            { type: 'tool_use', name: 'Skill', input: { skill: 'draft-investment-proposal' } },
            { type: 'tool_use', name: 'Read', input: { file_path: './materials/manifest.json' } },
          ] },
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: '任务级全新上下文完成恢复',
          num_turns: 1,
          total_cost_usd: 0.05,
          usage: { input_tokens: 10, output_tokens: 5 },
        }
      })()
    },
  })
  assert.match(taskLevelPrompt, /工作区中的资料、Manifest、事实台账、草稿、Reviewer 结果和渲染文件均被原样保留/)
  assert.ok((await stat(taskLevelMarker)).isFile())
  assert.ok((await stat(taskLevelRecovered.outputPath)).size > 1_000)
  assert.ok(taskLevelRecovered.pdfPath)
  let closed = false
  await assert.rejects(runDirectInvestmentProposalAgent({
    taskDirectory: path.join(temporaryRoot, 'silent-sdk'),
    project: { id: 'offline', name: '离线取消测试' },
    sources: [], requiredProjectFiles: [], skill, sourceCutoffDate: '2026-09-07',
    instructions: '', userRole: 'admin', shouldCancel: async () => true,
  }, {
    runtimeConfig: { baseUrl: 'https://model.example.com', apiKey: 'unused', model: 'offline', maxTurns: 2, maxBudgetUsd: 1, timeoutMs: 10_000 },
    queryFactory: () => ({
      [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) } },
      close() { closed = true },
    }),
  }), { code: 'AI_TASK_CANCELLED' })
  assert.equal(closed, true)
  console.log('direct investment proposal Skill Agent acceptance passed')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
