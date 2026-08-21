import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getAiSkillDirectory, loadAiSkill } from '../services/aiSkillService.js'
import { runDirectInvestmentCommitteePptAgent } from '../services/aiDirectInvestmentCommitteePptAgentService.js'

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'direct-committee-ppt-agent-'))

try {
  const skill = await loadAiSkill('investment-committee-ppt')
  let observedOptions: Record<string, unknown> | null = null
  let observedPrompt = ''
  const result = await runDirectInvestmentCommitteePptAgent({
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
    queryFactory: ({ prompt, options }) => {
      observedPrompt = prompt
      observedOptions = options
      return (async function* () {
        const workspace = String(options.cwd)
        const outputPath = path.join(workspace, 'output', '验收科技_投资建议书.pptx')
        await copyFile(
          path.join(getAiSkillDirectory('investment-committee-ppt'), 'assets', 'dayan-investment-deck-example.pptx'),
          outputPath,
        )
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Skill', input: { skill: 'investment-committee-ppt' } },
              { type: 'tool_use', name: 'Read', input: { file_path: './materials/manifest.json' } },
              { type: 'tool_use', name: 'Write', input: { file_path: './output/验收科技_投资建议书.pptx' } },
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
  assert.deepEqual(options.skills, ['investment-committee-ppt'])
  assert.deepEqual(options.settingSources, ['project'])
  assert.equal((options.sandbox as { enabled?: boolean }).enabled, true)
  assert.equal((options.sandbox as { failIfUnavailable?: boolean }).failIfUnavailable, true)
  assert.ok((options.tools as string[]).includes('Skill'))
  assert.ok((options.tools as string[]).includes('Read'))
  assert.ok((options.tools as string[]).includes('Write'))
  assert.ok((options.tools as string[]).includes('Bash'))
  assert.match(observedPrompt, /直接调用 Skill 工具执行 investment-committee-ppt/)
  assert.match(observedPrompt, /全部来源文件和全部片段/)
  assert.match(observedPrompt, /宿主不会生成页面、编排内容或提供兜底稿/)
  assert.doesNotMatch(observedPrompt, /Gorden|图片高保真版|PDF 桥接/)

  const workspace = path.join(temporaryRoot, '.direct-skill-agent')
  const manifest = JSON.parse(await readFile(path.join(workspace, 'materials', 'manifest.json'), 'utf8'))
  assert.equal(manifest.documentCount, 2)
  assert.equal(manifest.chunkCount, 3)
  assert.ok((await readFile(path.join(workspace, 'materials', manifest.sources[0].fileName), 'utf8'))
    .includes('第一份资料的第二段完整内容。'))
  assert.ok((await stat(path.join(workspace, '.claude', 'skills', 'investment-committee-ppt', 'SKILL.md'))).isFile())
  assert.ok((await stat(path.join(
    workspace,
    '.claude',
    'skills',
    'investment-committee-ppt',
    'assets',
    'dayan-investment-deck-example.pptx',
  ))).isFile())

  assert.equal(result.skillInvoked, true)
  assert.equal(result.projectKnowledgeStudy.completeProjectFileCoverage, true)
  assert.equal(result.projectKnowledgeStudy.completeSourceChunkCoverage, true)
  assert.equal(result.projectKnowledgeStudy.includedChunkCount, 3)
  assert.equal(result.projectKnowledgeStudy.hostContentOrchestration, false)
  assert.equal(result.projectKnowledgeStudy.hostEvidenceFallback, false)
  assert.ok(Array.from('Skill公开核验').length <= 16)
  assert.ok(Array.from('Skill完整研读').length <= 16)
  assert.ok((await stat(result.outputPath)).size > 1_000)

  await assert.rejects(
    () => runDirectInvestmentCommitteePptAgent({
      taskDirectory: temporaryRoot,
      project: { id: 'project-1', name: '验收项目', companyName: '验收科技' },
      sources: [{
        sourceType: 'project_file',
        sourceId: 'file-1',
        sourceName: '商业计划书.pdf',
        chunkIndex: 0,
        content: '完整资料。',
      }],
      requiredProjectFiles: [{ sourceId: 'file-1', sourceName: '商业计划书.pdf' }],
      skill,
      sourceCutoffDate: '2026-08-21',
      instructions: '',
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
      queryFactory: () => (async function* () {
        throw new Error('API Error: 403 额度不足')
      })(),
    }),
    (error: unknown) => (error as { code?: string }).code === 'DIRECT_SKILL_AGENT_QUOTA_EXHAUSTED',
  )

  const recoveryTaskDirectory = path.join(temporaryRoot, 'gateway-recovery')
  const recoveryPrompts: string[] = []
  let recoveryQueryCount = 0
  const recovered = await runDirectInvestmentCommitteePptAgent({
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
    instructions: '普通 403 后必须保留 PPT 工作区继续生成。',
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
              { type: 'tool_use', name: 'Skill', input: { skill: 'investment-committee-ppt' } },
              { type: 'tool_use', name: 'Bash', input: { command: '生成候选稿并逐页复核' } },
            ] },
          }
          throw new Error('Response code: 403 gateway policy denied')
        }
        assert.ok((await stat(markerPath)).isFile())
        await copyFile(
          path.join(getAiSkillDirectory('investment-committee-ppt'), 'assets', 'dayan-investment-deck-example.pptx'),
          path.join(recoveryWorkspace, 'output', '恢复科技_投资建议书.pptx'),
        )
        yield {
          type: 'assistant',
          message: { content: [
            { type: 'tool_use', name: 'Skill', input: { skill: 'investment-committee-ppt' } },
            { type: 'tool_use', name: 'Read', input: { file_path: './materials/manifest.json' } },
            { type: 'tool_use', name: 'Bash', input: { command: '继续最终逐页复核' } },
          ] },
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: '全新上下文已按同一 Skill 完成 PPT 恢复与复核',
          num_turns: 2,
          total_cost_usd: 0.1,
          usage: { input_tokens: 20, output_tokens: 10 },
        }
      })()
    },
  })
  assert.equal(recoveryQueryCount, 2)
  assert.match(recoveryPrompts[0], /全部来源文件和全部片段/)
  assert.match(recoveryPrompts[1], /首先重新使用 Skill 工具调用 investment-committee-ppt/)
  assert.match(recoveryPrompts[1], /若现有证据台账不能证明某个来源或片段已经纳入，必须补读缺失资料/)
  assert.ok((await stat(recovered.outputPath)).size > 1_000)

  console.log('direct investment committee PPT Skill Agent acceptance passed')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
