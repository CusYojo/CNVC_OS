import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { AI_BUSINESS_SKILLS } from '../services/aiSkillService.js'
import { JW_AGENT_QUICK_SKILL_BINDINGS } from '../runtime/jwAgentRuntime.js'

async function source(relativePath: string) {
  return await readFile(path.resolve(process.cwd(), relativePath), 'utf8')
}

async function main() {
  const [quickActions, assistantPage, taskMessage, taskCards, runtime, schema, migration] = await Promise.all([
    source('src/components/AiQuickActions.tsx'),
    source('src/pages/AIAssistantPage.tsx'),
    source('src/components/AiTaskConversationMessage.tsx'),
    source('src/components/AiTaskCards.tsx'),
    source('server/src/runtime/jwAgentRuntime.ts'),
    source('server/src/db/schema.ts'),
    source('server/drizzle/0046_add_ai_task_events.sql'),
  ])

  const expectedSkills = [
    'generate-investment-compliance-note',
    'draft-investment-proposal',
    'investment-committee-ppt',
    'draft-due-diligence-report',
    'draft-investment-qa',
    'generate-document-from-template',
  ]
  assert.deepEqual(AI_BUSINESS_SKILLS.map((item) => item.name), expectedSkills)
  expectedSkills.forEach((skillName) => {
    assert.match(quickActions, new RegExp(`skillName: '${skillName}'`))
    assert.ok(skillName in JW_AGENT_QUICK_SKILL_BINDINGS)
  })

  assert.match(quickActions, /onSelectSkill/)
  assert.match(quickActions, /selectedActionId/)
  assert.doesNotMatch(quickActions, /onRunTask/)
  assert.doesNotMatch(quickActions, /开始生成/)
  assert.match(assistantPage, /await agent\.sendMessage\(ctx, \{/)
  assert.match(assistantPage, /skillName: quickSkill\?\.skillName/)
  assert.match(assistantPage, /补充项目数据或写作要求（可选）/)
  assert.doesNotMatch(assistantPage, /const runQuickTask/)
  assert.doesNotMatch(assistantPage, /<AiTaskCards/)
  assert.match(assistantPage, /<AiTaskConversationMessage/)

  assert.match(runtime, /taskType: 'investment_recommendation_ppt'/)
  assert.match(runtime, /taskType: 'custom_template_document'/)
  assert.match(runtime, /不得再次调用 create_ai_task/)
  assert.match(runtime, /precreatedTaskId/)

  assert.match(taskMessage, /文档 Agent 实际执行阶段/)
  assert.match(taskMessage, /task\.events \?\? \[\]/)
  assert.match(taskMessage, /artifact\.qualityStatus === 'passed'/)
  assert.match(taskMessage, /\/api\/ai\/artifacts\/\$\{artifact\.id\}\/download/)
  assert.match(taskMessage, /全部可用片段已覆盖/)
  assert.doesNotMatch(taskMessage, /ProgressBar/)
  assert.doesNotMatch(taskMessage, /task\.progress.*%/)
  assert.doesNotMatch(taskCards, /历史未校验|历史版本·未执行新编码检查/)

  assert.match(schema, /export const aiTaskEvents = mysqlTable\('ai_task_events'/)
  assert.match(migration, /CREATE TABLE `sbl_ai_task_events`/)
  assert.match(migration, /FOREIGN KEY \(`task_id`\) REFERENCES `sbl_ai_tasks`/)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'six-quick-actions-bind-current-skills',
      'quick-actions-select-skill-without-creating-task',
      'normal-agent-send-contract',
      'chat-native-task-rendering-without-progress-card',
      'protected-artifact-download-shared-by-id',
      'complete-project-source-coverage-visible-from-artifact-audit',
      'legacy-unverified-download-label-removed',
      'durable-stage-event-schema-and-migration',
      'custom-template-safe-precreation-without-generic-placeholder-id',
    ],
  }))
}

await main()
