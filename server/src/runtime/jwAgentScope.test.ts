import assert from 'node:assert/strict'
import test from 'node:test'
import {
  JW_AGENT_BUILT_IN_AI_TASK_TYPES,
  JW_AGENT_CREATE_AI_TASK_INPUT_SCHEMA,
  jwAgentSystemPrompt,
  jwAgentToolsForScope,
} from './jwAgentRuntime.js'

const tools = [
  'mcp__investment__search_project_docs',
  'mcp__investment__get_project_summary',
  'mcp__investment__create_ai_task',
  'mcp__investment__collect_public_intel',
]

test('global conversations do not expose project-only tools', () => {
  assert.deepEqual(jwAgentToolsForScope(tools, null), [
    'mcp__investment__search_project_docs',
    'mcp__investment__collect_public_intel',
  ])
})

test('project conversations retain project tools', () => {
  assert.deepEqual(jwAgentToolsForScope(tools, 'project-id'), tools)
})

test('global prompt says project binding is unnecessary', () => {
  const prompt = jwAgentSystemPrompt(null)
  assert.match(prompt, /不需要绑定投资项目/)
  assert.match(prompt, /不得主动要求用户绑定项目/)
})

test('built-in create_ai_task schema cannot require or receive a custom template id', () => {
  assert.equal('customTemplateId' in JW_AGENT_CREATE_AI_TASK_INPUT_SCHEMA, false)
  assert.equal(
    (JW_AGENT_BUILT_IN_AI_TASK_TYPES as readonly string[]).includes('custom_template_document'),
    false,
  )
  assert.match(jwAgentSystemPrompt('project-id'), /不得给内置任务虚构模板 ID/)
})
